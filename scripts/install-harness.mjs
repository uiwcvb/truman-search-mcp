#!/usr/bin/env node
// Universal MCP installer for multiple AI Harnesses:
// Supports: Antigravity, Claude Code, Claude Desktop, Cursor, Windsurf, OpenAI Codex CLI
// Safely merges the `web-search` MCP server entry without overwriting existing MCP servers.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..").replace(/\\/g, "/");
const MCP_SERVER_PATH = path.join(REPO_ROOT, "src", "mcp-server.mjs").replace(/\\/g, "/");

const homeDir = os.homedir();
const targetArg = (process.argv[2] || "detect").toLowerCase();

function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function mergeMcpJsonConfig(filePath, serverPath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const data = readJsonSafe(filePath);
  if (!data.mcpServers || typeof data.mcpServers !== "object") {
    data.mcpServers = {};
  }
  delete data.mcpServers["truman-search-mcp"];
  data.mcpServers["web-search"] = {
    command: "node",
    args: [serverPath]
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  console.log(`[OK] Registered 'web-search' in: ${filePath}`);
}

function mergeCodexTomlConfig(filePath, serverPath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let content = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")
    : "";
  const blockRegex = /\[mcp_servers\.(?:web-search|"web-search")][\s\S]*?(?=\n\[|$)/g;
  content = content.replace(blockRegex, "").trimEnd();
  const block = `\n\n[mcp_servers.web-search]\ncommand = "node"\nargs = ["${serverPath}"]\n`;
  fs.writeFileSync(filePath, (content + block).trimStart(), "utf8");
  console.log(`[OK] Registered 'web-search' in Codex config: ${filePath}`);
}

const targets = {
  cursor: path.join(homeDir, ".cursor", "mcp.json"),
  windsurf: path.join(homeDir, ".codeium", "windsurf", "mcp_config.json"),
  claudeCode: path.join(homeDir, ".claude.json"),
  claudeDesktop:
    process.platform === "win32"
      ? path.join(process.env.APPDATA || path.join(homeDir, "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
      : process.platform === "darwin"
        ? path.join(homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json")
        : path.join(homeDir, ".config", "Claude", "claude_desktop_config.json"),
  codex: path.join(homeDir, ".codex", "config.toml")
};

if (targetArg === "cursor" || (targetArg === "detect" && fs.existsSync(path.dirname(targets.cursor)))) {
  mergeMcpJsonConfig(targets.cursor, MCP_SERVER_PATH);
}
if (targetArg === "windsurf" || (targetArg === "detect" && fs.existsSync(path.dirname(targets.windsurf)))) {
  mergeMcpJsonConfig(targets.windsurf, MCP_SERVER_PATH);
}
if (targetArg === "claude" || (targetArg === "detect" && fs.existsSync(targets.claudeCode))) {
  mergeMcpJsonConfig(targets.claudeCode, MCP_SERVER_PATH);
}
if (targetArg === "claude-desktop" || (targetArg === "detect" && fs.existsSync(path.dirname(targets.claudeDesktop)))) {
  mergeMcpJsonConfig(targets.claudeDesktop, MCP_SERVER_PATH);
}
if (targetArg === "codex" || (targetArg === "detect" && fs.existsSync(path.dirname(targets.codex)))) {
  mergeCodexTomlConfig(targets.codex, MCP_SERVER_PATH);
}

console.log(`\nMCP Server entry command for any other harness:`);
console.log(`  Command: node`);
console.log(`  Args:    ["${MCP_SERVER_PATH}"]`);
