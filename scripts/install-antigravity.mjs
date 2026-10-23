#!/usr/bin/env node
// One-click installer for Antigravity
// 1. Registers `web-search` directly in ~/.gemini/config/mcp_config.json so it appears in the "MCP 服务器" UI list.
// 2. Installs routing rules in ~/.gemini/config/plugins/web-search-mcp/rules/AGENTS.md (zero SKILL.md overhead).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..").replace(/\\/g, "/");

const homeDir = os.homedir();
const geminiConfigDir = path.join(homeDir, ".gemini", "config");
const antigravityDir = path.join(homeDir, ".gemini", "antigravity");
const oldPluginDir = path.join(geminiConfigDir, "plugins", "truman-search-mcp");
const oldMcpCacheDir = path.join(antigravityDir, "mcp", "truman-search-mcp_web-search");
const oldPluginMcpCacheDir = path.join(antigravityDir, "mcp", "web-search-mcp_web-search");
const oldPluginDataDir = path.join(antigravityDir, "plugin_data", "truman-search-mcp");
const pluginTargetDir = path.join(geminiConfigDir, "plugins", "web-search-mcp");
const globalConfigJsonPath = path.join(geminiConfigDir, "config.json");
const globalMcpConfigPath = path.join(geminiConfigDir, "mcp_config.json");

console.log("Installing web-search MCP server & routing rules into Antigravity...");

// Remove any legacy folders and duplicate plugin MCP caches
for (const dirToRemove of [
  oldPluginDir,
  oldMcpCacheDir,
  oldPluginMcpCacheDir,
  oldPluginDataDir,
  path.join(pluginTargetDir, "skills"),
  path.join(pluginTargetDir, "mcp_config.json"),
  path.join(REPO_ROOT, "skills")
]) {
  try {
    if (fs.existsSync(dirToRemove)) {
      fs.rmSync(dirToRemove, { recursive: true, force: true });
    }
  } catch {}
}

fs.mkdirSync(path.join(pluginTargetDir, "rules"), { recursive: true });
fs.mkdirSync(path.join(pluginTargetDir, "src"), { recursive: true });
fs.mkdirSync(path.join(pluginTargetDir, "config"), { recursive: true });
fs.mkdirSync(path.join(pluginTargetDir, "agents"), { recursive: true });

// Preserve existing runtime-state.json from pluginTargetDir if it has more data
const targetRuntimePath = path.join(pluginTargetDir, "config", "runtime-state.json");
const repoRuntimePath = path.join(REPO_ROOT, "config", "runtime-state.json");
try {
  if (fs.existsSync(targetRuntimePath)) {
    const tStat = fs.statSync(targetRuntimePath);
    const rStat = fs.existsSync(repoRuntimePath) ? fs.statSync(repoRuntimePath) : { size: 0 };
    if (tStat.size >= rStat.size) {
      fs.copyFileSync(targetRuntimePath, repoRuntimePath);
    }
  }
} catch {}

fs.copyFileSync(
  path.join(REPO_ROOT, "plugin.json"),
  path.join(pluginTargetDir, "plugin.json")
);
fs.copyFileSync(
  path.join(REPO_ROOT, "rules", "AGENTS.md"),
  path.join(pluginTargetDir, "rules", "AGENTS.md")
);

fs.cpSync(path.join(REPO_ROOT, "src"), path.join(pluginTargetDir, "src"), { recursive: true });
if (fs.existsSync(path.join(REPO_ROOT, "config"))) {
  fs.cpSync(path.join(REPO_ROOT, "config"), path.join(pluginTargetDir, "config"), { recursive: true });
}
if (fs.existsSync(path.join(REPO_ROOT, "agents"))) {
  fs.cpSync(path.join(REPO_ROOT, "agents"), path.join(pluginTargetDir, "agents"), { recursive: true });
}

// Register `web-search` in ~/.gemini/config/mcp_config.json so it shows in the "MCP 服务器" UI list
const mcpServerScriptPath = path
  .join(pluginTargetDir, "src", "mcp-server.mjs")
  .replace(/\\/g, "/");

let globalMcp = { mcpServers: {} };
try {
  if (fs.existsSync(globalMcpConfigPath)) {
    const rawMcp = fs.readFileSync(globalMcpConfigPath, "utf8").replace(/^\uFEFF/, "");
    globalMcp = JSON.parse(rawMcp);
    if (!globalMcp.mcpServers || typeof globalMcp.mcpServers !== "object") {
      globalMcp.mcpServers = {};
    }
  }
} catch (err) {
  console.error("Warning: Failed to parse existing mcp_config.json, aborting overwrite:", err.message);
  process.exit(1);
}

const existingEntry = globalMcp.mcpServers["web-search"];
const needsMcpWrite =
  Boolean(globalMcp.mcpServers["truman-search-mcp"]) ||
  !existingEntry ||
  existingEntry.command !== "node" ||
  !Array.isArray(existingEntry.args) ||
  existingEntry.args[0] !== mcpServerScriptPath;

if (needsMcpWrite) {
  delete globalMcp.mcpServers["truman-search-mcp"];
  globalMcp.mcpServers["web-search"] = {
    ...(existingEntry || {}),
    command: "node",
    args: [mcpServerScriptPath]
  };
  fs.writeFileSync(globalMcpConfigPath, JSON.stringify(globalMcp, null, 2), "utf8");
  console.log(`Registered 'web-search' MCP server in: ${globalMcpConfigPath}`);
} else {
  console.log(`Preserved existing 'web-search' MCP config (without resetting UI toggle state): ${globalMcpConfigPath}`);
}

try {
  if (fs.existsSync(globalConfigJsonPath)) {
    const rawCfg = fs.readFileSync(globalConfigJsonPath, "utf8").replace(/^\uFEFF/, "");
    const cfg = JSON.parse(rawCfg);
    cfg.plugins = cfg.plugins || {};
    const needsCfgWrite =
      Boolean(cfg.plugins["truman-search-mcp"]) || !cfg.plugins["web-search-mcp"];
    if (needsCfgWrite) {
      delete cfg.plugins["truman-search-mcp"];
      cfg.plugins["web-search-mcp"] = {
        enabled: true,
        ...(cfg.plugins["web-search-mcp"] || {})
      };
      fs.writeFileSync(globalConfigJsonPath, JSON.stringify(cfg, null, 2), "utf8");
    }
  }
} catch {}

console.log(`Synced files & routing rules to: ${pluginTargetDir}`);
