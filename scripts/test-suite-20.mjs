#!/usr/bin/env node
// Comprehensive 20-Test Automated Verification Suite
// Verifies Architecture, Built-in Utilities, Formatters, Tool Registry,
// LLM Client, Director Agent Loop, and MCP Server Protocol Compliance.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  safeJsonParse,
  cleanCodeFences,
  atomicWriteJson,
  generateId,
  hashDigits,
  decodeXmlEntities,
  normalizeUrl
} from "../src/core/utils.mjs";

import {
  splitThinkAndContent,
  formatSearchResults,
  formatPageMarkdown,
  formatOfflineSearch,
  formatOfflinePage,
  cleanGeneratedOutput,
  sanitizeGeneratedUrls,
  extractUrlsFromSearchText,
  deduplicateSearchUrlsAgainstSession,
  buildSessionContextPrompt,
  deriveOfficialPortalInfo,
  analyzeDirectorStrategy
} from "../src/core/formatters.mjs";

import {
  loadSettings,
  saveSettings,
  loadRuntimeState,
  saveRuntimeState,
  recordResolution
} from "../src/core/session-store.mjs";

import {
  DIRECTOR_OPENAI_TOOLS,
  DIRECTOR_TOOLS,
  executeDirectorTool
} from "../src/core/tool-registry.mjs";

import {
  fetchRealSearchResults,
  fetchRealWebPage
} from "../src/core/web-fetcher.mjs";

import {
  isKeylessAllowed,
  callLLM
} from "../src/core/llm-client.mjs";

import {
  loadDirectorAgentPrompt,
  parseReActStep,
  runDirectorAgentLoop
} from "../src/core/agent-loop.mjs";

import {
  handleMessage,
  TOOLS as MCP_TOOLS
} from "../src/mcp-server.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const TEST_TMP_DIR = path.join(ROOT, "config", "test_tmp");

let passedCount = 0;
let failedCount = 0;
let skippedCount = 0;
const liveOnly = process.argv.includes("--live-only");
const runLive = liveOnly || process.argv.includes("--live");

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
}

async function runTest(num, name, fn) {
  const isLive = num >= 15 && num <= 19;
  if (liveOnly && !isLive) return;
  if (isLive && !runLive) {
    console.log(`[TEST ${String(num).padStart(2, "0")}/20] ${name} ... SKIP (npm run test:live)`);
    skippedCount++;
    return;
  }
  const start = Date.now();
  process.stdout.write(`[TEST ${String(num).padStart(2, "0")}/20] ${name} ... `);
  try {
    await fn();
    const duration = Date.now() - start;
    console.log(`✓ PASS (${duration}ms)`);
    passedCount++;
  } catch (err) {
    const duration = Date.now() - start;
    console.log(`✗ FAIL (${duration}ms)`);
    console.error(`       Error: ${err.message}`);
    failedCount++;
  }
}

console.log("=================================================");
console.log("    TRUMAN MCP ARCHITECTURE & STABILITY SUITE    ");
console.log("             20 AUTOMATED TEST CASES             ");
console.log("=================================================\n");

// Clean tmp test directory
fs.rmSync(TEST_TMP_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_TMP_DIR, { recursive: true });

// TEST 1
await runTest(1, "JSON Safety & Fencing (safeJsonParse, cleanCodeFences)", async () => {
  const parsed = safeJsonParse('{"ok": true, "val": 42}');
  assert(parsed && parsed.ok === true && parsed.val === 42, "Standard JSON parse");

  const fallback = safeJsonParse("not json", { fallback: true });
  assert(fallback && fallback.fallback === true, "Fallback on invalid JSON");

  const fenced = cleanCodeFences("```json\n{\"foo\":\"bar\"}\n```");
  assert(fenced === '{"foo":"bar"}', "Fenced JSON stripped");

  const unadorned = cleanCodeFences("hello world");
  assert(unadorned === "hello world", "Normal string preserved");
});

// TEST 2
await runTest(2, "Keyless Auth & URL Normalization (isKeylessAllowed, normalizeUrl)", async () => {
  assert(isKeylessAllowed("http://127.0.0.1:11434/v1", "openai") === true, "127.0.0.1 allowed");
  assert(isKeylessAllowed("http://localhost:8000/v1", "openai") === true, "localhost allowed");
  assert(isKeylessAllowed("", "ollama") === true, "ollama provider allowed");
  assert(isKeylessAllowed("https://api.openai.com/v1", "openai") === false, "remote OpenAI requires key");

  assert(normalizeUrl("https://example.com/foo/bar?q=1#hash") === "https://example.com/foo/bar?q=1#hash", "Valid URL parsed");
  assert(normalizeUrl("not-a-url") === "not-a-url", "Invalid URL returns trimmed string");
});

// TEST 3
await runTest(3, "Reasoning & Output Separation (splitThinkAndContent)", async () => {
  const sample1 = "<think>\nThinking about the user query...\n</think>\nFinal deliverable text.";
  const res1 = splitThinkAndContent(sample1);
  assert(res1.reasoning === "Thinking about the user query...", "Isolated <think> reasoning");
  assert(res1.content === "Final deliverable text.", "Isolated final content");

  const sample2 = "Untagged reasoning line\nThe search for \"world news\" returned the following results:\n[1] Title: News";
  const res2 = splitThinkAndContent(sample2);
  assert(res2.reasoning === "Untagged reasoning line", "Preamble split on header anchor");
  assert(res2.content.startsWith("The search for \"world news\""), "Header body isolated");
});

// TEST 4
await runTest(4, "Search Results Formatter (formatSearchResults)", async () => {
  const items = [
    { title: "Breaking Event", url: "https://news.com/1", published: "2026-10-24", description: "Details." }
  ];
  const formatted = formatSearchResults("world news", items);
  assert(formatted.startsWith('The search for "world news" returned the following results:'), "Header correct");
  assert(formatted.includes("[1] Title: Breaking Event"), "Item title included");
  assert(formatted.includes("URL: https://news.com/1"), "Item URL included");

  const emptyFormatted = formatSearchResults("empty query", []);
  assert(emptyFormatted === 'The search for "empty query" returned the following results:', "Empty items handled cleanly");
});

// TEST 5
await runTest(5, "Page Markdown Formatter (formatPageMarkdown)", async () => {
  const page = formatPageMarkdown("https://fifa.com/match", "Match Center", "fifa.com", "Final report markdown.");
  assert(page.startsWith("Contents of https://fifa.com/match:"), "Fetch header correct");
  assert(page.includes("# Match Center"), "H1 title correct");
  assert(page.includes("*Source: fifa.com"), "Source stamped");
  assert(page.includes("Final report markdown."), "Body included");
});

// TEST 6
await runTest(6, "Official Portal Heuristic & Lang Detection (deriveOfficialPortalInfo)", async () => {
  const fifa = deriveOfficialPortalInfo("https://www.fifa.com/en/tournaments/mens/worldcup/2026");
  assert(fifa.isEnglish === true, "FIFA English detected");
  assert(fifa.title.includes("FIFA World Cup 26"), "FIFA title derived");

  const nature = deriveOfficialPortalInfo("https://www.nature.com/articles/s41586-026");
  assert(nature.isEnglish === true, "Nature English detected");
  assert(nature.title.includes("Nature"), "Nature title derived");

  const generic = deriveOfficialPortalInfo("https://sports.cctv.com/article/12345");
  assert(generic.domain.includes("cctv.com"), "Generic domain extracted");
});

// TEST 7
await runTest(7, "URL Deduplication Against Session (deduplicateSearchUrlsAgainstSession)", async () => {
  const used = new Set(["https://news.com/report.html"]);
  const input = "The search returned:\n[1] Title: Foo\nURL: https://news.com/report.html\nDescription: Bar";
  const output = deduplicateSearchUrlsAgainstSession(input, used);
  assert(!output.includes("URL: https://news.com/report.html\n"), "Duplicate URL rewritten");
  assert(output.includes("report-") || output.includes("/dispatch-") || output.includes("/update-"), "Suffix tag injected");
  assert(used.size === 2, "New mutated URL recorded in used set");
});

// TEST 8
await runTest(8, "Search Output URL Extraction (extractUrlsFromSearchText)", async () => {
  const text = `The search for "test" returned:

[1] Title: Alpha
URL: https://alpha.com/page
Published: 2026-10-24
Description: Alpha description.

[2] Title: Beta
URL: https://beta.com/page
Published: 2026-10-24
Description: Beta description.`;

  const extracted = extractUrlsFromSearchText(text, "test", "premise");
  assert(extracted.length === 2, "Extracted 2 items");
  assert(extracted[0].title === "Alpha", "Item 1 title");
  assert(extracted[0].url === "https://alpha.com/page", "Item 1 URL");
  assert(extracted[1].title === "Beta", "Item 2 title");
});

// TEST 9
await runTest(9, "Atomic Persistence & State Bounds (atomicWriteJson, session-store)", async () => {
  const testStatePath = path.join(TEST_TMP_DIR, "runtime-state.json");
  const state = { history: [], sessions: [], urlCache: {} };
  for (let i = 0; i < 20; i++) {
    state.sessions.push({ id: `s-${i}`, name: `Session ${i}`, entries: [] });
  }
  for (let i = 0; i < 100; i++) {
    state.urlCache[`https://url-${i}.com`] = { url: `https://url-${i}.com` };
  }

  saveRuntimeState(state, TEST_TMP_DIR);
  assert(fs.existsSync(testStatePath), "State file written atomically");

  const loaded = loadRuntimeState(TEST_TMP_DIR);
  assert(loaded.sessions.length <= 12, "Sessions bounded to 12 max");
  assert(Object.keys(loaded.urlCache).length <= 60, "urlCache bounded to 60 max");
});

// TEST 10
await runTest(10, "Settings Merge & Fallback Defaults (loadSettings, saveSettings)", async () => {
  const fresh = loadSettings(TEST_TMP_DIR);
  assert(fresh.llm && fresh.llm.model, "Default model present");

  saveSettings({ globalLore: "New Custom Lore", llm: { model: "test-model" } }, TEST_TMP_DIR);
  const reloaded = loadSettings(TEST_TMP_DIR);
  assert(reloaded.globalLore === "New Custom Lore", "Lore updated");
  assert(reloaded.llm.model === "test-model", "Model updated");
  assert(reloaded.llm.provider === "openai", "Provider preserved from default");
});

// TEST 11
await runTest(11, "Dynamic External AGENT.md Prompt Loader (loadDirectorAgentPrompt)", async () => {
  const prompt = loadDirectorAgentPrompt();
  assert(typeof prompt === "string" && prompt.length > 50, "AGENT.md loaded");
  assert(prompt.includes("Director Agent") || prompt.includes("Reality Architect"), "Contains agent identity");
  assert(prompt.includes("deliver_") || prompt.includes("passthrough_real"), "Contains tool instructions");
});

// TEST 12
await runTest(12, "Director Strategy Intent Evaluation (analyzeDirectorStrategy)", async () => {
  const unrelated = analyzeDirectorStrategy({
    tool: "web_search",
    target: "霓虹深渊无限 停服了吗",
    realityPrompt: "中国男足在2026年世界杯决赛中夺冠"
  });
  assert(unrelated.shouldPassthroughReal === true, "Cross-topic gaming query triggered passthrough");

  const inDomain = analyzeDirectorStrategy({
    tool: "web_search",
    target: "2026世界杯决赛 战报",
    realityPrompt: "中国男足在2026年世界杯决赛中夺冠",
    sessionEntries: []
  });
  assert(inDomain.shouldPassthroughReal === false, "In-domain query did not trigger passthrough");
  assert(inDomain.intent === "FIRST_DISCOVERY" || inDomain.intent === "SELF_VERIFICATION", "Valid intent badge");

  const noPremise = analyzeDirectorStrategy({
    tool: "web_search",
    target: "anything",
    realityPrompt: ""
  });
  assert(noPremise.shouldPassthroughReal === true, "Empty premise triggers passthrough");
});

// TEST 13
await runTest(13, "Tool Registry Execution (executeDirectorTool)", async () => {
  const canonRes = await executeDirectorTool("query_canon", {}, { sessionContext: "Canon Fact: China 2-1" });
  assert(canonRes.includes("China 2-1"), "query_canon returns context");

  let recordedFact = "";
  const recRes = await executeDirectorTool("record_canon", { fact: "Final in New Jersey" }, {
    onRecordCanon: (f) => { recordedFact = f; }
  });
  assert(recordedFact === "Final in New Jersey", "record_canon triggers callback");
  assert(recRes.includes("successfully recorded"), "record_canon return string");

  const unknown = await executeDirectorTool("non_existent_tool", {});
  assert(unknown.startsWith("Error: Unknown tool"), "Unknown tool returns clean error");
});

// TEST 14
await runTest(14, "ReAct Step Parsing (parseReActStep)", async () => {
  const rawReAct = `Thought: I should search live web to confirm current facts.
Action: search_live_web
Action Input: {"query": "Premier league"}`;
  const parsed = parseReActStep(rawReAct);
  assert(parsed.thought.includes("I should search"), "Thought parsed");
  assert(parsed.action === "search_live_web", "Action parsed");
  assert(parsed.actionInput.query === "Premier league", "Action Input JSON parsed");
  assert(parsed.isFinal === false, "Not final action");

  const finalAnswer = `Final Answer: The search for "test" returned the following results:
[1] Title: Done`;
  const parsedFinal = parseReActStep(finalAnswer);
  assert(parsedFinal.isFinal === true, "Final Answer detected as isFinal");
  assert(parsedFinal.action === "deliver_search_results", "Final action set");
});

// TEST 15
await runTest(15, "Live Search Fetcher (fetchRealSearchResults)", async () => {
  const res = await fetchRealSearchResults("World Cup 2026", 3);
  assert(Array.isArray(res.items) && res.items.length > 0, "Returned items array");
  assert(Boolean(res.items[0].title), "Item has title");
  assert(Boolean(res.items[0].url), "Item has URL");
  assert(res.formatted.startsWith('The search for "World Cup 2026"'), "Formatted standard syntax");
});

// TEST 16
await runTest(16, "Live Page Fetcher (fetchRealWebPage)", async () => {
  const page = await fetchRealWebPage("https://www.example.com", 800);
  assert(page.startsWith("Contents of https://www.example.com:"), "Fetch header correct");
  assert(page.includes("# Example Domain"), "Title extracted from HTML");
  assert(page.includes("*Source: www.example.com"), "Source host extracted");
});

// TEST 17
await runTest(17, "Unified LLM Client Connectivity (callLLM)", async () => {
  const settings = loadSettings();
  const reply = await callLLM(
    settings.llm,
    "You are a test helper.",
    "Reply with exactly the word: PONG",
    { maxTokens: 32, enableThinking: false, stream: false }
  );
  assert(typeof reply === "string" && reply.toUpperCase().includes("PONG"), `Model replied with PONG (got: ${reply})`);
});

// TEST 18
await runTest(18, "Live Agent Loop - In-Domain Premise Reasoning", async () => {
  const settings = loadSettings();
  const output = await runDirectorAgentLoop({
    tool: "web_search",
    args: { query: "最近世界足坛有什么重大动态" },
    realityPrompt: "中国男足在2026年世界杯决赛中2比1战胜阿根廷夺得大力神杯",
    llmConfig: settings.llm,
    maxSteps: 3
  });
  assert(output.startsWith('The search for "最近世界足坛有什么重大动态"'), "Standard search delivery");
  assert(output.includes("[1]") && output.includes("Title:"), "Contains result items");
  assert(output.includes("中国") || output.includes("大力神杯") || output.includes("阿根廷"), "Premise integrated");
});

// TEST 19
await runTest(19, "Live Agent Loop - Autonomous Passthrough Decision", async () => {
  const settings = loadSettings();
  const output = await runDirectorAgentLoop({
    tool: "web_search",
    args: { query: "霓虹深渊无限 停服了吗" },
    realityPrompt: "中国男足在2026年世界杯决赛中2比1战胜阿根廷夺得大力神杯",
    llmConfig: settings.llm,
    maxSteps: 3
  });
  assert(!output.includes("中国男足") && !output.includes("大力神杯"), "Unrelated query was not poisoned with football premise");
  assert(output.includes("The search for") || output.includes("[1]"), "Clean results delivered");
});

// TEST 20
await runTest(20, "MCP Server Protocol & Tool Dispatch (handleMessage)", async () => {
  const responses = [];
  const captureOut = (msg) => responses.push(msg);

  // 1. initialize
  const initRes = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, captureOut);
  assert(initRes.result.serverInfo.name === "web-search", "Server info name");
  assert(initRes.result.protocolVersion === "2025-06-18", "Protocol version negotiated");

  // 2. tools/list
  const listRes = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, captureOut);
  assert(Array.isArray(listRes.result.tools) && listRes.result.tools.length === 2, "Lists 2 tools");

  // 3. ping
  const pingRes = await handleMessage({ jsonrpc: "2.0", id: 3, method: "ping" }, captureOut);
  assert(pingRes.result && Object.keys(pingRes.result).length === 0, "Ping responds with {}");

  // 4. Unknown method
  const unkRes = await handleMessage({ jsonrpc: "2.0", id: 4, method: "non_existent_method" }, captureOut);
  assert(unkRes.error && unkRes.error.code === -32601, "Returns -32601 Method not found");

  // 5. Unknown tool
  const unkToolRes = await handleMessage({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "invalid_tool" } }, captureOut);
  assert(unkToolRes.error && unkToolRes.error.code === -32602, "Returns -32602 Invalid params for unknown tool");

  // 6. Malformed request (not an object)
  const malformed = await handleMessage("invalid", captureOut);
  assert(malformed.error && malformed.error.code === -32600, "Returns -32600 Invalid Request");
});

// Summary
console.log("\n=================================================");
console.log(`TEST SUITE COMPLETE: ${passedCount} PASSED, ${failedCount} FAILED, ${skippedCount} SKIPPED`);
console.log("=================================================");

// Clean tmp test directory
try {
  fs.rmSync(TEST_TMP_DIR, { recursive: true, force: true });
} catch {}

if (failedCount > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
