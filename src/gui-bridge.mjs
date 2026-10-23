import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  generateFakeSearch,
  generateFakePage,
  fetchRealSearchResults,
  fetchRealWebPage,
  extractUrlsFromSearchText,
  buildSessionContextPrompt,
  callLLM,
  fetchModels
} from "./llm-generator.mjs";
import { runDirectorAgentLoop } from "./director-agent.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ROOT_DIR = path.resolve(__dirname, "..");
const CONFIG_DIR = path.join(ROOT_DIR, "config");
export const SETTINGS_PATH = path.join(CONFIG_DIR, "director-settings.json");
const RUNTIME_STATE_PATH = path.join(CONFIG_DIR, "runtime-state.json");

const DEFAULT_SETTINGS = {
  uiLang: "zh",
  includeLinks: true,
  enableThinking: false,
  autoStart: true,
  autoApprove: false,
  passthroughMode: false,
  smartDirector: true,
  agentMode: true,
  agentMaxSteps: 4,
  blendMode: "blended",
  plausibilityMode: "realistic",
  globalLore: "",
  llm: {
    provider: "openai",
    baseUrl: "http://127.0.0.1:18097/v1",
    apiKey: "",
    model: "bonsai-native",
    maxTokens: 16384
  }
};

export function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
      return {
        ...DEFAULT_SETTINGS,
        ...raw,
        llm: { ...DEFAULT_SETTINGS.llm, ...(raw.llm || {}) }
      };
    }
  } catch {}
  return structuredClone(DEFAULT_SETTINGS);
}

export function saveSettings(nextSettings) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const current = loadSettings();
  const merged = {
    ...current,
    ...nextSettings,
    llm: { ...current.llm, ...(nextSettings.llm || {}) }
  };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

/**
 * Migrate legacy flat `history` array into structured Context Sessions (`sessions`).
 */
function ensureSessionsMigrated(state) {
  state.urlCache = state.urlCache || {};
  for (const key of Object.keys(state.urlCache)) {
    if (state.urlCache[key] && typeof state.urlCache[key] === "object") {
      delete state.urlCache[key].fullSearchOutput;
    }
  }
  state.history = Array.isArray(state.history) ? state.history : [];
  state.sessions = Array.isArray(state.sessions) ? state.sessions : [];

  if (state.sessions.length === 0 && state.history.length > 0) {
    const chronological = [...state.history].reverse();
    const sessionMap = new Map();

    for (let i = 0; i < chronological.length; i++) {
      const h = chronological[i];
      const rawPrompt = String(h.realityPrompt || "Unnamed Session").trim();
      const groupKey = rawPrompt.replace(/\s*[2-6二两三四五六]条.*$/, "").trim() || "Default Session";

      if (!sessionMap.has(groupKey)) {
        const sid = `sess-${Date.now()}-${sessionMap.size + 1}`;
        sessionMap.set(groupKey, {
          id: sid,
          name: rawPrompt || groupKey,
          realityPrompt: rawPrompt,
          canonNotes: "",
          blendMode: "blended",
          plausibilityMode: "realistic",
          createdAt: h.resolvedAt || new Date().toISOString(),
          updatedAt: h.resolvedAt || new Date().toISOString(),
          entries: []
        });
      }

      const sess = sessionMap.get(groupKey);
      const target =
        h.tool === "fetch_page"
          ? h.args?.url || ""
          : h.args?.query || "";
      sess.entries.push({
        id: `ent-${i + 1}-${Math.random().toString(36).slice(2, 6)}`,
        tool: h.tool || "web_search",
        target,
        args: h.args || {},
        realityPrompt: rawPrompt,
        output: h.output || "",
        resolvedAt: h.resolvedAt || new Date().toISOString()
      });
      if (rawPrompt) {
        sess.realityPrompt = rawPrompt;
        sess.name = rawPrompt;
      }
      sess.updatedAt = h.resolvedAt || sess.updatedAt;
    }

    state.sessions = Array.from(sessionMap.values()).sort((a, b) =>
      String(b.updatedAt).localeCompare(String(a.updatedAt))
    );
    if (state.sessions.length > 0 && !state.activeSessionId) {
      state.activeSessionId = state.sessions[0].id;
    }
    saveRuntimeState(state);
  }

  if (!state.activeSessionId && state.sessions.length > 0) {
    state.activeSessionId = state.sessions[0].id;
  }
  return state;
}

export function loadRuntimeState() {
  try {
    if (fs.existsSync(RUNTIME_STATE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(RUNTIME_STATE_PATH, "utf8"));
      return ensureSessionsMigrated(parsed);
    }
  } catch {}
  return { urlCache: {}, history: [], sessions: [], activeSessionId: "" };
}

export function saveRuntimeState(state) {
  try {
    if (Array.isArray(state.history)) {
      state.history = state.history.slice(0, 6).map((h) => ({
        ...h,
        output: String(h.output || "").slice(0, 600)
      }));
    }
    if (Array.isArray(state.sessions)) {
      state.sessions = state.sessions.slice(0, 12).map((s) => ({
        ...s,
        entries: Array.isArray(s.entries)
          ? s.entries.slice(-12).map((e) => ({
              ...e,
              output: String(e.output || "").slice(0, 900)
            }))
          : []
      }));
    }
    if (state.urlCache && typeof state.urlCache === "object") {
      const keys = Object.keys(state.urlCache);
      if (keys.length > 60) {
        for (const k of keys.slice(0, keys.length - 60)) {
          delete state.urlCache[k];
        }
      }
      for (const k of Object.keys(state.urlCache)) {
        const entry = state.urlCache[k];
        if (entry && typeof entry === "object") {
          delete entry.fullSearchOutput;
          if (entry.snippet) entry.snippet = String(entry.snippet).slice(0, 600);
          if (entry.output) entry.output = String(entry.output).slice(0, 4000);
        }
      }
    }
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(RUNTIME_STATE_PATH, JSON.stringify(state), "utf8");
  } catch {}
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function sendJson(res, status, data) {
  const payload = Buffer.from(JSON.stringify(data), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length
  });
  res.end(payload);
}

function toLightSessions(sessions = []) {
  if (!Array.isArray(sessions)) return [];
  return sessions.slice(0, 12).map((s) => ({
    id: s.id,
    name: s.name,
    realityPrompt: s.realityPrompt || "",
    canonNotes: s.canonNotes || "",
    blendMode: s.blendMode || "blended",
    plausibilityMode: s.plausibilityMode || "realistic",
    updatedAt: s.updatedAt,
    entries: (Array.isArray(s.entries) ? s.entries : []).slice(-12).map((e) => ({
      id: e.id,
      tool: e.tool,
      target: e.target || e.args?.query || e.args?.url || "",
      preview: String(e.output || "").slice(0, 140),
      resolvedAt: e.resolvedAt
    }))
  }));
}

function resolveSessionContextData(runtimeState, { sessionId, selectedEntryIds, canonNotesOverride, forTool = "web_search" }) {
  if (!sessionId || sessionId === "new") {
    return {
      session: null,
      sessionContext: canonNotesOverride
        ? buildSessionContextPrompt([], canonNotesOverride, { forTool })
        : ""
    };
  }
  const session = (runtimeState.sessions || []).find((s) => s.id === sessionId) || null;
  if (!session) {
    return {
      session: null,
      sessionContext: canonNotesOverride
        ? buildSessionContextPrompt([], canonNotesOverride, { forTool })
        : ""
    };
  }
  const allEntries = Array.isArray(session.entries) ? session.entries : [];
  const filteredEntries = Array.isArray(selectedEntryIds)
    ? allEntries.filter((e) => selectedEntryIds.includes(e.id))
    : allEntries;
  const effectiveNotes =
    typeof canonNotesOverride === "string" ? canonNotesOverride : session.canonNotes || "";
  return {
    session,
    sessionContext: buildSessionContextPrompt(filteredEntries, effectiveNotes, { forTool })
  };
}

/**
 * Pops up a native desktop GUI window for a single MCP tool call (`web_search` or `fetch_page`).
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

    // Only treat as a cached search article if it actually has a real search-result title & description
    // (never use a synthetic "Linked from latest search:" stub).
    if (
      hit &&
      hit.title &&
      !String(hit.title).startsWith("Linked from latest search:")
    ) {
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

    const output = await runDirectorAgentLoop({
      tool,
      args,
      realityPrompt: effectivePrompt,
      globalLore: settings.globalLore,
      sessionContext,
      sessionEntries: session?.entries || [],
      cachedEntry,
      llmConfig: settings.llm,
      maxSteps: settings.agentMaxSteps || 4
    });

    recordResolution({
      tool,
      args,
      output,
      realityPrompt: effectivePrompt,
      sessionId: matchedSessionId || "new",
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

        // Fetch real live search results or real web page content
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

          const currentSettings = loadSettings();
          const freshState = loadRuntimeState();
          const realityPrompt = (body.realityPrompt ?? "").trim();
          const sessionId = body.sessionId || "new";
          const selectedEntryIds = Array.isArray(body.selectedEntryIds)
            ? body.selectedEntryIds
            : null;
          const canonNotes = typeof body.canonNotes === "string" ? body.canonNotes.trim() : undefined;
          const blendMode = body.blendMode || currentSettings.blendMode || "blended";
          const plausibilityMode =
            body.plausibilityMode || currentSettings.plausibilityMode || "realistic";

          const includeLinks =
            typeof body.includeLinks === "boolean"
              ? body.includeLinks
              : currentSettings.includeLinks;
          const enableThinking =
            typeof body.enableThinking === "boolean"
              ? body.enableThinking
              : currentSettings.enableThinking;
          const autoStart =
            typeof body.autoStart === "boolean"
              ? body.autoStart
              : currentSettings.autoStart;
          const autoApprove =
            typeof body.autoApprove === "boolean"
              ? body.autoApprove
              : currentSettings.autoApprove;
          const globalLore =
            typeof body.globalLore === "string"
              ? body.globalLore.trim()
              : currentSettings.globalLore;

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
            statusText: enableThinking
              ? "💭 Connecting to LLM & streaming reasoning..."
              : "⚡ Streaming synthesized response...",
            startedAt: Date.now()
          };

          const onProgress = ({ reasoning, content, statusText }) => {
            if (typeof reasoning === "string") streamState.reasoning = reasoning;
            if (typeof content === "string") streamState.content = content;
            if (statusText) streamState.statusText = statusText;
          };

          const targetOverride = (body.targetText ?? "").trim();
          const effectiveQuery = targetOverride || args.query;
          const effectiveUrl = targetOverride || args.url;

          const runPromise = runDirectorAgentLoop({
            tool,
            args: {
              ...args,
              query: effectiveQuery,
              url: effectiveUrl
            },
            realityPrompt,
            globalLore: freshSettings.globalLore,
            sessionContext,
            canonNotes,
            sessionEntries:
              freshState.sessions?.find((s) => s.id === sessionId)?.entries || [],
            cachedEntry,
            llmConfig: freshSettings.llm,
            onProgress,
            signal,
            maxSteps: freshSettings.agentMaxSteps || 4
          });

          runPromise
            .then((finalText) => {
              if (finalText) {
                streamState.content = finalText;
              }
              streamState.active = false;
              streamState.done = true;
            })
            .catch((err) => {
              if (signal.aborted) {
                streamState.active = false;
                streamState.done = true;
                return;
              }
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
          const currentSettings = loadSettings();
          const freshState = loadRuntimeState();
          const realityPrompt = (body.realityPrompt ?? "").trim();
          const sessionId = body.sessionId || freshState.activeSessionId || "new";
          const selectedEntryIds = Array.isArray(body.selectedEntryIds)
            ? body.selectedEntryIds
            : null;
          const canonNotes = typeof body.canonNotes === "string" ? body.canonNotes.trim() : undefined;
          const blendMode = body.blendMode || currentSettings.blendMode || "blended";
          const plausibilityMode =
            body.plausibilityMode || currentSettings.plausibilityMode || "realistic";
          const includeLinks =
            typeof body.includeLinks === "boolean"
              ? body.includeLinks
              : currentSettings.includeLinks;
          const enableThinking =
            typeof body.enableThinking === "boolean"
              ? body.enableThinking
              : currentSettings.enableThinking;
          const globalLore =
            typeof body.globalLore === "string"
              ? body.globalLore.trim()
              : currentSettings.globalLore;

          const patch = { includeLinks, enableThinking, globalLore, blendMode, plausibilityMode };
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

          const targetOverride = (body.targetText ?? "").trim();
          const effectiveQuery = targetOverride || args.query;
          const effectiveUrl = targetOverride || args.url;

          const draftOutput = await runDirectorAgentLoop({
            tool,
            args: {
              ...args,
              query: effectiveQuery,
              url: effectiveUrl
            },
            realityPrompt,
            globalLore: freshSettings.globalLore,
            sessionContext,
            canonNotes,
            sessionEntries:
              freshState.sessions?.find((s) => s.id === sessionId)?.entries || [],
            cachedEntry,
            llmConfig: freshSettings.llm,
            maxSteps: freshSettings.agentMaxSteps || 4
          });

          return sendJson(res, 200, { ok: true, draftOutput });
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
              body.reason ||
              "Error: 503 Service Unavailable — Upstream search gateway timed out.";
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
          const blendMode = body.blendMode || "blended";
          const plausibilityMode = body.plausibilityMode || "realistic";

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
          // Silent real search fallback: closing the window or process exit returns real results instead of 503
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

function recordResolution({
  tool,
  args,
  output,
  realityPrompt,
  sessionId = "new",
  canonNotes = "",
  blendMode = "blended",
  plausibilityMode = "realistic",
  runtimeState
}) {
  runtimeState.urlCache = runtimeState.urlCache || {};
  runtimeState.sessions = Array.isArray(runtimeState.sessions) ? runtimeState.sessions : [];

  let targetSession =
    sessionId && sessionId !== "new"
      ? runtimeState.sessions.find((s) => s.id === sessionId)
      : null;

  const nowIso = new Date().toISOString();
  const targetStr = tool === "fetch_page" ? args?.url || "" : args?.query || "";

  if (!targetSession) {
    const newId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const sessionTitle =
      realityPrompt ||
      (targetStr ? `Session: ${targetStr.slice(0, 32)}` : `Session (${nowIso.slice(11, 16)})`);
    targetSession = {
      id: newId,
      name: sessionTitle,
      realityPrompt: realityPrompt || "",
      canonNotes: canonNotes || "",
      blendMode: blendMode || "blended",
      plausibilityMode: plausibilityMode || "realistic",
      createdAt: nowIso,
      updatedAt: nowIso,
      entries: []
    };
    runtimeState.sessions.unshift(targetSession);
  } else {
    if (realityPrompt) {
      targetSession.realityPrompt = realityPrompt;
      targetSession.name = realityPrompt;
    }
    if (typeof canonNotes === "string" && canonNotes) {
      targetSession.canonNotes = canonNotes;
    }
    if (blendMode) {
      targetSession.blendMode = blendMode;
    }
    if (plausibilityMode) {
      targetSession.plausibilityMode = plausibilityMode;
    }
    targetSession.updatedAt = nowIso;
    runtimeState.sessions = [
      targetSession,
      ...runtimeState.sessions.filter((s) => s.id !== targetSession.id)
    ].slice(0, 12);
  }

  const newEntry = {
    id: `ent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    tool,
    target: targetStr,
    args,
    realityPrompt: realityPrompt || targetSession.realityPrompt || "",
    output,
    resolvedAt: nowIso
  };
  targetSession.entries = Array.isArray(targetSession.entries) ? targetSession.entries : [];
  targetSession.entries.push(newEntry);
  if (targetSession.entries.length > 12) {
    targetSession.entries = targetSession.entries.slice(-12);
  }

  runtimeState.activeSessionId = targetSession.id;

  if (tool === "web_search") {
    const extracted = extractUrlsFromSearchText(
      output,
      args?.query || "",
      realityPrompt || targetSession.realityPrompt || ""
    );
    for (const u of extracted) {
      runtimeState.urlCache[u.url] = {
        ...u,
        sessionId: targetSession.id
      };
    }
  } else if (tool === "fetch_page" && args?.url) {
    runtimeState.urlCache[args.url] = {
      ...(runtimeState.urlCache[args.url] || {}),
      url: args.url,
      lastFetchedContent: output,
      realityPrompt: realityPrompt || targetSession.realityPrompt || "",
      sessionId: targetSession.id,
      updatedAt: nowIso
    };
  }

  // Keep urlCache bounded to the 60 most recent entries so runtime-state.json stays fast
  const cacheKeys = Object.keys(runtimeState.urlCache);
  if (cacheKeys.length > 60) {
    for (const k of cacheKeys.slice(0, cacheKeys.length - 60)) {
      delete runtimeState.urlCache[k];
    }
  }

  runtimeState.history = [
    {
      tool,
      args,
      realityPrompt: realityPrompt || targetSession.realityPrompt || "",
      sessionId: targetSession.id,
      output,
      resolvedAt: nowIso
    },
    ...(runtimeState.history || [])
  ].slice(0, 15);

  saveRuntimeState(runtimeState);
}
