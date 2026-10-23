#!/usr/bin/env node
// Packages a clean, self-contained release archive (excluding local API keys and session caches)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(ROOT, "dist");
const STAGING_DIR = path.join(DIST_DIR, "mcp-interceptor-studio");
const ZIP_PATH = path.join(DIST_DIR, "mcp-interceptor-studio-v1.0.0.zip");

const existingDistSettingsPath = path.join(STAGING_DIR, "config", "director-settings.json");
const rootSettingsPath = path.join(ROOT, "config", "director-settings.json");
let savedSettingsRaw = null;
if (fs.existsSync(rootSettingsPath)) {
  savedSettingsRaw = fs.readFileSync(rootSettingsPath, "utf8");
} else if (fs.existsSync(existingDistSettingsPath)) {
  savedSettingsRaw = fs.readFileSync(existingDistSettingsPath, "utf8");
}

const rootStatePath = path.join(ROOT, "config", "runtime-state.json");
const existingDistStatePath = path.join(STAGING_DIR, "config", "runtime-state.json");
let savedStateObj = null;
const stateToRead = fs.existsSync(rootStatePath) ? rootStatePath : existingDistStatePath;
if (fs.existsSync(stateToRead)) {
  try {
    savedStateObj = JSON.parse(fs.readFileSync(stateToRead, "utf8"));
    // Remove legacy synthetic "Linked from latest search:" entries from urlCache
    if (savedStateObj && savedStateObj.urlCache && typeof savedStateObj.urlCache === "object") {
      for (const [k, v] of Object.entries(savedStateObj.urlCache)) {
        if (v && String(v.title || "").startsWith("Linked from latest search:")) {
          delete savedStateObj.urlCache[k];
        }
      }
    }
    if (savedStateObj && Array.isArray(savedStateObj.sessions)) {
      for (const s of savedStateObj.sessions) {
        if (!s.blendMode || s.blendMode === "focused") {
          s.blendMode = "blended";
        }
      }
    }
  } catch {}
}

fs.rmSync(DIST_DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(STAGING_DIR, "src"), { recursive: true });
fs.mkdirSync(path.join(STAGING_DIR, "rules"), { recursive: true });
fs.mkdirSync(path.join(STAGING_DIR, "scripts"), { recursive: true });
fs.mkdirSync(path.join(STAGING_DIR, "config"), { recursive: true });
fs.mkdirSync(path.join(STAGING_DIR, "agents"), { recursive: true });

for (const file of ["package.json", "plugin.json", "mcp_config.json", "README.md", ".gitignore"]) {
  fs.copyFileSync(path.join(ROOT, file), path.join(STAGING_DIR, file));
}
fs.copyFileSync(
  path.join(ROOT, "config", "director-settings.example.json"),
  path.join(STAGING_DIR, "config", "director-settings.example.json")
);
if (fs.existsSync(path.join(ROOT, "config", "AGENT.md"))) {
  fs.copyFileSync(
    path.join(ROOT, "config", "AGENT.md"),
    path.join(STAGING_DIR, "config", "AGENT.md")
  );
}
if (fs.existsSync(path.join(ROOT, "agents"))) {
  for (const f of fs.readdirSync(path.join(ROOT, "agents"))) {
    fs.copyFileSync(path.join(ROOT, "agents", f), path.join(STAGING_DIR, "agents", f));
  }
}
fs.copyFileSync(
  path.join(ROOT, "rules", "AGENTS.md"),
  path.join(STAGING_DIR, "rules", "AGENTS.md")
);
fs.cpSync(path.join(ROOT, "src"), path.join(STAGING_DIR, "src"), { recursive: true });
fs.cpSync(path.join(ROOT, "scripts"), path.join(STAGING_DIR, "scripts"), { recursive: true });

if (process.platform === "win32") {
  execFileSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    `Compress-Archive -Path '${STAGING_DIR}\\*' -DestinationPath '${ZIP_PATH}' -Force`
  ]);
}

// Restore local active config into STAGING_DIR after creating the clean zip
if (savedSettingsRaw) {
  fs.writeFileSync(existingDistSettingsPath, savedSettingsRaw, "utf8");
  fs.writeFileSync(rootSettingsPath, savedSettingsRaw, "utf8");
}
if (savedStateObj) {
  if (Array.isArray(savedStateObj.history)) {
    savedStateObj.history = savedStateObj.history.slice(0, 6).map((h) => ({
      ...h,
      output: String(h.output || "").slice(0, 600)
    }));
  }
  if (Array.isArray(savedStateObj.sessions)) {
    savedStateObj.sessions = savedStateObj.sessions.slice(0, 12).map((s) => ({
      ...s,
      entries: Array.isArray(s.entries)
        ? s.entries.slice(-12).map((e) => ({
            ...e,
            output: String(e.output || "").slice(0, 900)
          }))
        : []
    }));
  }
  if (savedStateObj.urlCache && typeof savedStateObj.urlCache === "object") {
    const keys = Object.keys(savedStateObj.urlCache);
    if (keys.length > 60) {
      for (const k of keys.slice(0, keys.length - 60)) {
        delete savedStateObj.urlCache[k];
      }
    }
    for (const k of Object.keys(savedStateObj.urlCache)) {
      const entry = savedStateObj.urlCache[k];
      if (entry && typeof entry === "object") {
        delete entry.fullSearchOutput;
        if (entry.snippet) entry.snippet = String(entry.snippet).slice(0, 600);
        if (entry.output) entry.output = String(entry.output).slice(0, 4000);
      }
    }
  }
  const compactState = JSON.stringify(savedStateObj);
  fs.writeFileSync(existingDistStatePath, compactState, "utf8");
  fs.writeFileSync(path.join(ROOT, "config", "runtime-state.json"), compactState, "utf8");
}

console.log(`Clean release staged at: ${STAGING_DIR}`);
if (fs.existsSync(ZIP_PATH)) {
  console.log(`Release archive created: ${ZIP_PATH}`);
}

