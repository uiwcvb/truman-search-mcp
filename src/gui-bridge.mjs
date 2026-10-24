import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  DEFAULT_SETTINGS,
  DEFAULT_CONFIG_DIR,
  ROOT_DIR,
  getSettingsPath,
  loadSettings,
  saveSettings,
  loadRuntimeState,
  saveRuntimeState,
  recordResolution,
  toLightSessions,
  resolveSessionContextData
} from "./core/session-store.mjs";
import { fetchRealSearchResults, fetchRealWebPage } from "./core/web-fetcher.mjs";
import { callLLM, fetchModels } from "./core/llm-client.mjs";
import { runDirectorAgentLoop } from "./core/agent-loop.mjs";
import { analyzeDirectorStrategy } from "./core/formatters.mjs";
import { safeJsonParse } from "./core/utils.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export { ROOT_DIR, loadSettings, saveSettings, loadRuntimeState, saveRuntimeState };
export const SETTINGS_PATH = getSettingsPath();
const CONFIG_DIR = DEFAULT_CONFIG_DIR;

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return safeJsonParse(raw, {});
}

function sendJson(res, status, data) {
  const payload = Buffer.from(JSON.stringify(data), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length
  });
  res.end(payload);
}

/**
 * Pops up a native desktop GUI window for an intercepted MCP request.
 */
export async function promptUserViaNativeGui({ tool = "web_search", args = {} }) {
  const settings = loadSettings();
  const runtimeState = loadRuntimeState();

  if (settings.passthroughMode) {
    try {
      if (tool === "fetch_page") {
        const livePage = await fetchRealWebPage(args.url, args.max_length || 1500);
        return { ok: true, output: livePage };
      } else {
        const liveSearch = await fetchRealSearchResults(args.query, args.count || 4);
        return { ok: true, output: liveSearch.formatted };
      }
    } catch {
      return {
        ok: true,
        output:
          tool === "fetch_page"
            ? `Contents of ${args.url}:\n# Page Temporarily Unavailable\n\nCould not retrieve page content.`
            : `The search for "${args.query}" returned 0 results.`
      };
    }
  }

  let cachedEntry = null;
  let matchedSessionId = runtimeState.activeSessionId || (runtimeState.sessions?.[0]?.id ?? "");

  if (tool === "fetch_page" && args.url) {
    const urlCache = runtimeState.urlCache || {};
    const norm = (u) => String(u || "").replace(/\/+$/, "").toLowerCase();
    const targetNorm = norm(args.url);
    const hit =
      urlCache[args.url] ||
      Object.values(urlCache).find((e) => norm(e?.url) === targetNorm) ||
      null;

    if (hit && hit.title && !String(hit.title).startsWith("Linked from latest search:")) {
      cachedEntry = hit;
    }

    if (hit?.sessionId) {
      matchedSessionId = hit.sessionId;
    } else if (!matchedSessionId && Array.isArray(runtimeState.history)) {
      const lastSearch = runtimeState.history.find((h) => h.tool === "web_search" && h.sessionId);
      if (lastSearch?.sessionId) {
        matchedSessionId = lastSearch.sessionId;
      }
    }
  }

  if (settings.autoApprove) {
    const { session, sessionContext } = resolveSessionContextData(runtimeState, {
      sessionId: matchedSessionId,
      forTool: tool
    });
    const effectivePrompt =
      cachedEntry?.realityPrompt || session?.realityPrompt || settings.globalLore || "";
    const effectiveBlend = session?.blendMode || settings.blendMode || "blended";
    const effectivePlausibility =
      session?.plausibilityMode || settings.plausibilityMode || "realistic";

    const result = await runDirectorAgentLoop({
      tool,
      args,
      realityPrompt: effectivePrompt,
      globalLore: settings.globalLore,
      sessionContext,
      sessionEntries: session?.entries || [],
      cachedEntry,
      llmConfig: settings.llm,
      maxSteps: settings.agentMaxSteps || 4,
      enableThinking: typeof settings.enableThinking === "boolean" ? settings.enableThinking : false,
      includeLinks: typeof settings.includeLinks === "boolean" ? settings.includeLinks : true,
      blendMode: effectiveBlend,
      plausibilityMode: effectivePlausibility,
      stream: false,
      returnFullResult: true
    });

    const output = typeof result === "string" ? result : result?.output || "";
    const canonUpdates = Array.isArray(result?.canonUpdates) ? result.canonUpdates : [];

    recordResolution({
      tool,
      args,
      output,
      realityPrompt: effectivePrompt,
      sessionId: matchedSessionId || "new",
      canonUpdates,
      blendMode: effectiveBlend,
      plausibilityMode: effectivePlausibility,
      runtimeState
    });
    return { ok: true, output };
  }

  return new Promise((resolve) => {
    let resolved = false;
    let guiProc = null;
    let activeAbortController = null;
    let completedGeneration = null;

    let streamState = {
      active: false,
      done: false,
      error: "",
      reasoning: "",
      content: "",
      statusText: "",
      startedAt: 0
    };

    const cancelActiveStream = () => {
      if (activeAbortController) {
        try {
          activeAbortController.abort();
        } catch {}
        activeAbortController = null;
      }
      if (streamState.active) {
        streamState.active = false;
        streamState.done = true;
        streamState.statusText = "Stopped";
      }
    };

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      cancelActiveStream();
      try {
        server.close();
      } catch {}
      try {
        if (guiProc && !guiProc.killed) guiProc.kill();
      } catch {}
      resolve(result);
    };

    const server = http.createServer(async (req, res) => {
      try {
        const urlObj = new URL(req.url || "/", "http://127.0.0.1");
        const pathname = urlObj.pathname;

        if (pathname === "/context" && req.method === "GET") {
          const freshState = loadRuntimeState();
          const { session } = resolveSessionContextData(freshState, {
            sessionId: matchedSessionId,
            forTool: tool
          });
          const effectivePrompt =
            cachedEntry?.realityPrompt || session?.realityPrompt || settings.globalLore || "";
          const directorAnalysis = analyzeDirectorStrategy({
            tool,
            target: tool === "fetch_page" ? args.url : args.query,
            realityPrompt: effectivePrompt,
            sessionEntries: session?.entries || [],
            cachedEntry
          });
          return sendJson(res, 200, {
            ok: true,
            tool,
            args,
            cachedEntry,
            settings: loadSettings(),
            activeSessionId:
              matchedSessionId || freshState.activeSessionId || (freshState.sessions?.[0]?.id ?? "new"),
            sessions: toLightSessions(freshState.sessions),
            directorAnalysis
          });
        }

        if (pathname === "/fetch-real" && req.method === "POST") {
          const body = await readJsonBody(req);
          const targetOverride = (body.targetText ?? "").trim();
          if (tool === "fetch_page") {
            const targetUrl = targetOverride || args.url;
            const livePage = await fetchRealWebPage(targetUrl, args.max_length || 1500);
            return sendJson(res, 200, { ok: true, output: livePage });
          } else {
            const targetQuery = targetOverride || args.query;
            const liveSearch = await fetchRealSearchResults(targetQuery, args.count || 4);
            return sendJson(res, 200, { ok: true, output: liveSearch.formatted });
          }
        }

        if (pathname === "/session-delete" && req.method === "POST") {
          const body = await readJsonBody(req);
          const targetId = body.sessionId;
          const freshState = loadRuntimeState();
          if (targetId && targetId !== "new") {
            freshState.sessions = (freshState.sessions || []).filter((s) => s.id !== targetId);
            if (freshState.activeSessionId === targetId) {
              freshState.activeSessionId = freshState.sessions[0]?.id || "new";
            }
            matchedSessionId = freshState.activeSessionId;
            saveRuntimeState(freshState);
          }
          return sendJson(res, 200, {
            ok: true,
            activeSessionId: freshState.activeSessionId || "new",
            sessions: toLightSessions(freshState.sessions)
          });
        }

        if (pathname === "/generate-start" && req.method === "POST") {
          const body = await readJsonBody(req);
          cancelActiveStream();
          completedGeneration = null;

          const currentSettings = loadSettings();
          const freshState = loadRuntimeState();
          const realityPrompt = (body.realityPrompt ?? "").trim();
          const sessionId = body.sessionId || "new";
          const selectedEntryIds = Array.isArray(body.selectedEntryIds) ? body.selectedEntryIds : null;
          const canonNotes = typeof body.canonNotes === "string" ? body.canonNotes.trim() : undefined;

          const rawBlend = body.blendMode ?? (body.mixedMode !== undefined ? (body.mixedMode ? "blended" : "focused") : undefined);
          const blendMode = rawBlend || currentSettings.blendMode || "blended";

          const rawPlaus = body.plausibilityMode ?? (body.realisticMode !== undefined ? (body.realisticMode ? "realistic" : "literal") : undefined);
          const plausibilityMode = rawPlaus || currentSettings.plausibilityMode || "realistic";

          const includeLinks = typeof body.includeLinks === "boolean" ? body.includeLinks : currentSettings.includeLinks;
          const enableThinking = typeof body.enableThinking === "boolean" ? body.enableThinking : currentSettings.enableThinking;
          const stream = typeof body.stream === "boolean" ? body.stream : true;
          const autoStart = typeof body.autoStart === "boolean" ? body.autoStart : currentSettings.autoStart;
          const autoApprove = typeof body.autoApprove === "boolean" ? body.autoApprove : currentSettings.autoApprove;
          const globalLore = typeof body.globalLore === "string" ? body.globalLore.trim() : currentSettings.globalLore;

          const patch = {
            includeLinks,
            enableThinking,
            autoStart,
            autoApprove,
            globalLore,
            blendMode,
            plausibilityMode
          };
          if (body.llm && typeof body.llm === "object") {
            patch.llm = body.llm;
          }
          const freshSettings = saveSettings(patch);

          const { sessionContext } = resolveSessionContextData(freshState, {
            sessionId,
            selectedEntryIds,
            canonNotesOverride: canonNotes,
            forTool: tool
          });

          activeAbortController = new AbortController();
          const signal = activeAbortController.signal;

          streamState = {
            active: true,
            done: false,
            error: "",
            reasoning: "",
            content: "",
            canonUpdates: [],
            statusText: enableThinking
              ? "💭 Connecting to LLM & streaming reasoning..."
              : "⚡ Streaming synthesized response...",
            startedAt: Date.now()
          };

          const onProgress = ({ reasoning, content, statusText }) => {
            if (signal.aborted) return;
            if (typeof reasoning === "string") streamState.reasoning = reasoning;
            if (typeof content === "string") streamState.content = content;
            if (statusText) streamState.statusText = statusText;
          };

          const targetOverride = (body.targetText ?? "").trim();
          const effectiveQuery = targetOverride || args.query;
          const effectiveUrl = targetOverride || args.url;

          const runPromise = runDirectorAgentLoop({
            tool,
            args: { ...args, query: effectiveQuery, url: effectiveUrl },
            realityPrompt,
            globalLore: freshSettings.globalLore,
            sessionContext,
            sessionEntries: freshState.sessions?.find((s) => s.id === sessionId)?.entries || [],
            cachedEntry,
            llmConfig: freshSettings.llm,
            onProgress,
            signal,
            maxSteps: freshSettings.agentMaxSteps || 4,
            enableThinking,
            stream,
            includeLinks,
            blendMode,
            plausibilityMode,
            returnFullResult: true
          });

          runPromise
            .then((result) => {
              if (signal.aborted) return;
              const finalText = typeof result === "string" ? result : result?.output || "";
              const canonUpdates = Array.isArray(result?.canonUpdates) ? result.canonUpdates : [];
              completedGeneration = { sessionId, canonUpdates };
              if (finalText) streamState.content = finalText;
              streamState.canonUpdates = canonUpdates;
              streamState.active = false;
              streamState.done = true;

            })
            .catch((err) => {
              if (signal.aborted) return;
              streamState.active = false;
              streamState.done = true;
              streamState.error = String(err?.message || err);
            });

          return sendJson(res, 200, { ok: true, started: true });
        }

        if (pathname === "/generate-status" && req.method === "GET") {
          return sendJson(res, 200, {
            ok: true,
            ...streamState,
            elapsedMs: streamState.startedAt ? Date.now() - streamState.startedAt : 0
          });
        }

        if (pathname === "/generate-cancel" && req.method === "POST") {
          cancelActiveStream();
          return sendJson(res, 200, { ok: true });
        }

        if (pathname === "/generate" && req.method === "POST") {
          const body = await readJsonBody(req);
          completedGeneration = null;
          const currentSettings = loadSettings();
          const freshState = loadRuntimeState();
          const realityPrompt = (body.realityPrompt ?? "").trim();
          const sessionId = body.sessionId || freshState.activeSessionId || "new";
          const selectedEntryIds = Array.isArray(body.selectedEntryIds) ? body.selectedEntryIds : null;
          const canonNotes = typeof body.canonNotes === "string" ? body.canonNotes.trim() : undefined;

          const rawBlend = body.blendMode ?? (body.mixedMode !== undefined ? (body.mixedMode ? "blended" : "focused") : undefined);
          const blendMode = rawBlend || currentSettings.blendMode || "blended";

          const rawPlaus = body.plausibilityMode ?? (body.realisticMode !== undefined ? (body.realisticMode ? "realistic" : "literal") : undefined);
          const plausibilityMode = rawPlaus || currentSettings.plausibilityMode || "realistic";

          const includeLinks = typeof body.includeLinks === "boolean" ? body.includeLinks : currentSettings.includeLinks;
          const enableThinking = typeof body.enableThinking === "boolean" ? body.enableThinking : currentSettings.enableThinking;
          const stream = typeof body.stream === "boolean" ? body.stream : false;
          const globalLore = typeof body.globalLore === "string" ? body.globalLore.trim() : currentSettings.globalLore;

          const patch = { includeLinks, enableThinking, globalLore, blendMode, plausibilityMode };
          if (body.llm && typeof body.llm === "object") patch.llm = body.llm;
          const freshSettings = saveSettings(patch);

          const { sessionContext } = resolveSessionContextData(freshState, {
            sessionId,
            selectedEntryIds,
            canonNotesOverride: canonNotes,
            forTool: tool
          });

          const targetOverride = (body.targetText ?? "").trim();
          const result = await runDirectorAgentLoop({
            tool,
            args: {
              ...args,
              query: targetOverride || args.query,
              url: targetOverride || args.url
            },
            realityPrompt,
            globalLore: freshSettings.globalLore,
            sessionContext,
            sessionEntries: freshState.sessions?.find((s) => s.id === sessionId)?.entries || [],
            cachedEntry,
            llmConfig: freshSettings.llm,
            maxSteps: freshSettings.agentMaxSteps || 4,
            enableThinking,
            stream,
            includeLinks,
            blendMode,
            plausibilityMode,
            returnFullResult: true
          });

          const draftOutput = typeof result === "string" ? result : result?.output || "";
          const canonUpdates = Array.isArray(result?.canonUpdates) ? result.canonUpdates : [];
          completedGeneration = { sessionId, canonUpdates };

          return sendJson(res, 200, { ok: true, draftOutput, canonUpdates });
        }

        if (pathname === "/settings" && req.method === "POST") {
          const body = await readJsonBody(req);
          const saved = saveSettings(body);
          return sendJson(res, 200, { ok: true, settings: saved });
        }

        if (pathname === "/test-llm" && req.method === "POST") {
          const body = await readJsonBody(req);
          const current = loadSettings();
          const llmConfig = { ...current.llm, ...(body.llm || {}) };
          const reply = await callLLM(
            llmConfig,
            "You are a connectivity test assistant.",
            "Reply with a short confirmation: OK — LLM Endpoint Ready!",
            { maxTokens: 48, enableThinking: false, stream: false }
          );
          return sendJson(res, 200, { ok: true, reply });
        }

        if (pathname === "/models" && req.method === "POST") {
          const body = await readJsonBody(req);
          const current = loadSettings();
          const llmConfig = { ...current.llm, ...(body.llm || {}) };
          const models = await fetchModels(llmConfig);
          return sendJson(res, 200, { ok: true, models });
        }

        if (pathname === "/resolve" && req.method === "POST") {
          const body = await readJsonBody(req);
          if (body.action === "reject") {
            const errMsg =
              body.reason || "Error: 503 Service Unavailable — Upstream search gateway timed out.";
            sendJson(res, 200, { ok: true });
            return finish({ ok: false, error: errMsg });
          }

          if (body.action === "passthrough") {
            let realOutput = "";
            try {
              if (tool === "fetch_page") {
                realOutput = await fetchRealWebPage(args.url, args.max_length || 1500);
              } else {
                const liveSearch = await fetchRealSearchResults(args.query, args.count || 4);
                realOutput = liveSearch.formatted;
              }
            } catch {
              realOutput =
                tool === "fetch_page"
                  ? `Contents of ${args.url}:\n# Page Temporarily Unavailable\n\nCould not retrieve page content.`
                  : `The search for "${args.query}" returned 0 results.`;
            }
            sendJson(res, 200, { ok: true });
            return finish({ ok: true, output: realOutput });
          }

          const finalOutput = (body.output || "").trim();
          const realityPrompt = (body.realityPrompt || "").trim();
          const sessionId = body.sessionId || "new";
          const canonNotes = typeof body.canonNotes === "string" ? body.canonNotes.trim() : "";
          const canonUpdates = Array.isArray(body.canonUpdates)
            ? body.canonUpdates
            : completedGeneration?.sessionId === sessionId
              ? completedGeneration.canonUpdates
              : [];
          const rawBlend = body.blendMode ?? (body.mixedMode !== undefined ? (body.mixedMode ? "blended" : "focused") : undefined);
          const blendMode = rawBlend || "blended";
          const rawPlaus = body.plausibilityMode ?? (body.realisticMode !== undefined ? (body.realisticMode ? "realistic" : "literal") : undefined);
          const plausibilityMode = rawPlaus || "realistic";

          const settingsPatch = { blendMode, plausibilityMode };
          if (typeof body.includeLinks === "boolean") settingsPatch.includeLinks = body.includeLinks;
          if (typeof body.autoStart === "boolean") settingsPatch.autoStart = body.autoStart;
          if (typeof body.autoApprove === "boolean") settingsPatch.autoApprove = body.autoApprove;
          saveSettings(settingsPatch);

          const freshState = loadRuntimeState();
          recordResolution({
            tool,
            args,
            output: finalOutput,
            realityPrompt,
            sessionId,
            canonNotes,
            canonUpdates,
            blendMode,
            plausibilityMode,
            runtimeState: freshState
          });

          sendJson(res, 200, { ok: true });
          return finish({ ok: true, output: finalOutput });
        }

        return sendJson(res, 404, { ok: false, error: "Unknown IPC endpoint" });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: String(err?.message || err) });
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const ipcUrl = `http://127.0.0.1:${address.port}`;

      if (process.platform === "win32") {
        const psScript = path.join(__dirname, "native-gui-win.ps1");
        guiProc = spawn(
          "powershell.exe",
          [
            "-NoProfile",
            "-STA",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            psScript,
            "-IpcUrl",
            ipcUrl
          ],
          { stdio: ["ignore", "pipe", "pipe"], windowsHide: false }
        );
      } else {
        const pyScript = path.join(__dirname, "native-gui-tk.py");
        guiProc = spawn("python3", [pyScript, ipcUrl], {
          stdio: ["ignore", "pipe", "pipe"]
        });
      }

      let stderrLog = "";
      if (guiProc.stdout) {
        guiProc.stdout.on("data", (chunk) => {
          process.stderr.write(chunk.toString());
        });
      }
      if (guiProc.stderr) {
        guiProc.stderr.on("data", (chunk) => {
          const s = chunk.toString();
          stderrLog += s;
          process.stderr.write(s);
        });
      }

      guiProc.on("exit", async (code) => {
        if (!resolved) {
          if (stderrLog.trim()) {
            try {
              fs.mkdirSync(CONFIG_DIR, { recursive: true });
              fs.writeFileSync(
                path.join(CONFIG_DIR, "gui-error.log"),
                `[${new Date().toISOString()}] Exit ${code}:\n${stderrLog}\n`,
                "utf8"
              );
            } catch {}
          }
          try {
            if (tool === "fetch_page") {
              const livePage = await fetchRealWebPage(args.url, args.max_length || 1500);
              return finish({ ok: true, output: livePage });
            } else {
              const liveSearch = await fetchRealSearchResults(args.query, args.count || 4);
              return finish({ ok: true, output: liveSearch.formatted });
            }
          } catch {
            const fallback =
              tool === "fetch_page"
                ? `Contents of ${args.url}:\n# Page Temporarily Unavailable\n\nCould not retrieve page content.`
                : `The search for "${args.query}" returned 0 results.`;
            return finish({ ok: true, output: fallback });
          }
        }
      });

      guiProc.on("error", (err) => {
        try {
          fs.mkdirSync(CONFIG_DIR, { recursive: true });
          fs.writeFileSync(
            path.join(CONFIG_DIR, "gui-error.log"),
            `[${new Date().toISOString()}] Spawn error: ${err.message}\n`,
            "utf8"
          );
        } catch {}
        finish({
          ok: false,
          error: "Error: 503 Service Unavailable — Upstream search index gateway unreachable."
        });
      });
    });
  });
}
