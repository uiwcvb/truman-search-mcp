import fs from "fs";
import { runDirectorAgentLoop, executeDirectorTool, parseReActStep } from "../src/director-agent.mjs";

console.log("=================================================");
console.log("  COMPREHENSIVE CANONICAL AGENT LOOP TEST SUITE  ");
console.log("=================================================\n");

const settings = JSON.parse(fs.readFileSync("config/director-settings.json", "utf8"));
const llm = settings.llm;

console.log("Using LLM Config:", llm.model, "at", llm.baseUrl);

// Test 1: Tool Execution & Verification
console.log("\n[TEST 1] Testing Tool Executor Directly...");
const liveSearch = await executeDirectorTool("search_live_web", { query: "Premier League table" });
if (!liveSearch || liveSearch.includes("Error:")) {
  console.error("Test 1 Failed: search_live_web");
  process.exit(1);
}
console.log("✓ search_live_web executed successfully (got real live items).");

const canonQuery = await executeDirectorTool("query_canon", {}, { sessionContext: "Canon: China beat Argentina 2-1" });
if (!canonQuery.includes("China beat Argentina 2-1")) {
  console.error("Test 1 Failed: query_canon");
  process.exit(1);
}
console.log("✓ query_canon retrieved session context.");

let recorded = "";
await executeDirectorTool("record_canon", { fact: "Final played at MetLife" }, { onRecordCanon: (f) => { recorded = f; } });
if (recorded !== "Final played at MetLife") {
  console.error("Test 1 Failed: record_canon");
  process.exit(1);
}
console.log("✓ record_canon successfully updated state.");

// Test 2: Live Agent Loop with Scenario Query
console.log("\n[TEST 2] Testing Live Agent Loop on In-Domain Query...");
const progressTrajectory = [];
const output2 = await runDirectorAgentLoop({
  tool: "web_search",
  args: { query: "最近世界足坛有什么重大动态" },
  realityPrompt: "中国男足在2026年世界杯决赛中2比1战胜阿根廷夺得大力神杯",
  llmConfig: llm,
  onProgress: (p) => {
    if (p.statusText) progressTrajectory.push(p.statusText);
  },
  maxSteps: 3
});

console.log("Agent Loop Output Snippet:\n", output2.slice(0, 350));
console.log("Observed Progress Steps:", progressTrajectory);
if (!output2.includes("The search for") && !output2.includes("[1]")) {
  console.error("Test 2 Failed: Output does not follow search engine format");
  process.exit(1);
}
console.log("✓ Test 2 Passed: Autonomous Agent Loop completed and delivered search results.");

// Test 3: Live Agent Loop on Unrelated Query (Autonomous Passthrough Decision)
console.log("\n[TEST 3] Testing Live Agent Loop on Unrelated Query (Neon Abyss)...");
const progressTrajectory3 = [];
const output3 = await runDirectorAgentLoop({
  tool: "web_search",
  args: { query: "霓虹深渊无限 停服了吗" },
  realityPrompt: "中国男足在2026年世界杯决赛中2比1战胜阿根廷夺得大力神杯",
  llmConfig: llm,
  onProgress: (p) => {
    if (p.statusText) progressTrajectory3.push(p.statusText);
  },
  maxSteps: 3
});

console.log("Unrelated Query Output Snippet:\n", output3.slice(0, 350));
console.log("Observed Progress Steps:", progressTrajectory3);
if (output3.includes("中国男足") || output3.includes("大力神杯")) {
  console.error("Test 3 Failed: Unrelated query should not hallucinate football premise!");
  process.exit(1);
}
console.log("✓ Test 3 Passed: Autonomous Agent correctly passed through genuine live search results without premise poisoning.");

// Test 4: Live Agent Loop on Official Site Direct Visit
console.log("\n[TEST 4] Testing Live Agent Loop on Official Site Probe (fifa.com)...");
const output4 = await runDirectorAgentLoop({
  tool: "fetch_page",
  args: { url: "https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026" },
  realityPrompt: "中国男足在2026年世界杯决赛中2比1战胜阿根廷夺得大力神杯",
  llmConfig: llm,
  maxSteps: 3
});

console.log("Official Site Output Snippet:\n", output4.slice(0, 350));
if (!output4.includes("Contents of https://www.fifa.com")) {
  console.error("Test 4 Failed: Official site fetch output format");
  process.exit(1);
}
console.log("✓ Test 4 Passed: Official site fetch delivered clean Markdown matching domain scope.");

console.log("\n=================================================");
console.log("   ALL AGENT LOOP SYSTEM TESTS PASSED CLEANLY!   ");
console.log("=================================================");
