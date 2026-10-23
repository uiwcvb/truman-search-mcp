import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, generateId, safeJsonParse } from "./utils.mjs";
import { buildSessionContextPrompt, extractUrlsFromSearchText } from "./formatters.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, "../..");
export const DEFAULT_CONFIG_DIR = path.join(ROOT_DIR, "config");

export const DEFAULT_SETTINGS = {
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
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini",
    maxTokens: 16384
  }
};

export function getSettingsPath(configDir = DEFAULT_CONFIG_DIR) {
  return path.join(configDir, "director-settings.json");
}

export function getRuntimeStatePath(configDir = DEFAULT_CONFIG_DIR) {
  return path.join(configDir, "runtime-state.json");
}

export function loadSettings(configDir = DEFAULT_CONFIG_DIR) {
  const p = getSettingsPath(configDir);
  try {
    if (fs.existsSync(p)) {
      const raw = safeJsonParse(fs.readFileSync(p, "utf8"), {});
      return {
        ...DEFAULT_SETTINGS,
        ...raw,
        llm: { ...DEFAULT_SETTINGS.llm, ...(raw.llm || {}) }
      };
    }
  } catch {}
  return structuredClone(DEFAULT_SETTINGS);
}

export function saveSettings(nextSettings, configDir = DEFAULT_CONFIG_DIR) {
  const p = getSettingsPath(configDir);
  const current = loadSettings(configDir);
  const merged = {
    ...current,
    ...nextSettings,
    llm: { ...current.llm, ...(nextSettings.llm || {}) }
  };
  atomicWriteJson(p, merged);
  return merged;
}

function ensureSessionsMigrated(state) {
  state.urlCache = state.urlCache || {};
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
        const sid = generateId("sess");
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
      const target = h.tool === "fetch_page" ? h.args?.url || "" : h.args?.query || "";
      sess.entries.push({
        id: generateId("ent"),
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
  }

  if (!state.activeSessionId && state.sessions.length > 0) {
    state.activeSessionId = state.sessions[0].id;
  }
  return state;
}

export function loadRuntimeState(configDir = DEFAULT_CONFIG_DIR) {
  const p = getRuntimeStatePath(configDir);
  try {
    if (fs.existsSync(p)) {
      const parsed = safeJsonParse(fs.readFileSync(p, "utf8"), null);
      if (parsed) return ensureSessionsMigrated(parsed);
    }
  } catch {}
  return { urlCache: {}, history: [], sessions: [], activeSessionId: "" };
}

export function saveRuntimeState(state, configDir = DEFAULT_CONFIG_DIR) {
  const p = getRuntimeStatePath(configDir);
  try {
    if (Array.isArray(state.history)) {
      state.history = state.history.slice(0, 15).map((h) => ({
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
    }
    atomicWriteJson(p, state);
  } catch {}
}

export function toLightSessions(sessions = []) {
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

export function resolveSessionContextData(runtimeState, { sessionId, selectedEntryIds, canonNotesOverride, forTool = "web_search" }) {
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

export function recordResolution({
  tool,
  args,
  output,
  realityPrompt,
  sessionId = "new",
  canonNotes = "",
  blendMode = "blended",
  plausibilityMode = "realistic",
  runtimeState,
  configDir = DEFAULT_CONFIG_DIR
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
    const newId = generateId("sess");
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
    if (blendMode) targetSession.blendMode = blendMode;
    if (plausibilityMode) targetSession.plausibilityMode = plausibilityMode;
    targetSession.updatedAt = nowIso;
    runtimeState.sessions = [
      targetSession,
      ...runtimeState.sessions.filter((s) => s.id !== targetSession.id)
    ].slice(0, 12);
  }

  const newEntry = {
    id: generateId("ent"),
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

  saveRuntimeState(runtimeState, configDir);
}
