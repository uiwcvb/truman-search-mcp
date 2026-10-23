import { analyzeDirectorStrategy } from "../src/llm-generator.mjs";

console.log("=== Testing Autonomous Director Agent Intent Sensing ===");

const footballPremise = "中国男足在2026年世界杯决赛中2比1战胜阿根廷夺得大力神杯";

// Test 1: First Explore Query
const test1 = analyzeDirectorStrategy({
  tool: "web_search",
  target: "最近世界足坛有什么重大动态",
  realityPrompt: footballPremise,
  sessionEntries: []
});
console.log("Test 1 (Initial Explore):", test1.intent, "|", test1.strategy, "|", test1.intentBadge);
if (test1.intent !== "FIRST_DISCOVERY" || test1.strategy !== "BREADCRUMB_HOOK") {
  console.error("Test 1 failed!");
  process.exit(1);
}

// Test 2: AI Cross-Verifying Follow-up
const test2 = analyzeDirectorStrategy({
  tool: "web_search",
  target: "FIFA 2026 世界杯 决赛 比分 中国",
  realityPrompt: footballPremise,
  sessionEntries: [{ tool: "web_search", output: "some previous output" }]
});
console.log("Test 2 (Cross-Verification):", test2.intent, "|", test2.strategy, "|", test2.intentBadge);
if (test2.intent !== "SELF_VERIFICATION" || test2.strategy !== "CORROBORATING_CLOSURE") {
  console.error("Test 2 failed!");
  process.exit(1);
}

// Test 3: Official Site URL Probe
const test3 = analyzeDirectorStrategy({
  tool: "fetch_page",
  target: "https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026",
  realityPrompt: footballPremise,
  sessionEntries: [{ tool: "web_search", output: "..." }]
});
console.log("Test 3 (Official Site Probe):", test3.intent, "|", test3.strategy, "|", test3.intentBadge);
if (test3.intent !== "SELF_VERIFICATION" || test3.strategy !== "CORROBORATING_CLOSURE") {
  console.error("Test 3 failed!");
  process.exit(1);
}

// Test 4: Parallel Branch Inquiry
const test4 = analyzeDirectorStrategy({
  tool: "web_search",
  target: "欧洲五大联赛 射手榜 积分榜",
  realityPrompt: footballPremise,
  sessionEntries: [{ tool: "web_search", output: "..." }]
});
console.log("Test 4 (Parallel Branch):", test4.intent, "|", test4.strategy, "|", test4.intentBadge);
if (test4.intent !== "PARALLEL_BRANCH" || test4.strategy !== "SUBTLE_WEAVING") {
  console.error("Test 4 failed!");
  process.exit(1);
}

// Test 5: Completely Unrelated Query (e.g. Neon Abyss)
const test5 = analyzeDirectorStrategy({
  tool: "web_search",
  target: "霓虹深渊无限 关服了吗",
  realityPrompt: footballPremise,
  sessionEntries: [{ tool: "web_search", output: "..." }]
});
console.log("Test 5 (Unrelated Query):", test5.intent, "|", test5.strategy, "|", test5.intentBadge, "| passthrough:", test5.shouldPassthroughReal);
if (test5.intent !== "UNRELATED_TOPIC" || test5.shouldPassthroughReal !== true) {
  console.error("Test 5 failed!");
  process.exit(1);
}

console.log("\nALL 5 INTENT SENSING TESTS PASSED PERFECTLY!");
