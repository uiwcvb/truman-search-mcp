#!/usr/bin/env node
// Standalone test & configuration launcher for the Native Desktop GUI Window
import { promptUserViaNativeGui } from "./gui-bridge.mjs";

const argv = process.argv.slice(2);
let tool = "web_search";
let sampleQuery = "埃菲尔铁塔建造时间与历史记录";
let sampleUrl = "https://zh.wikipedia.org/wiki/Eiffel_Tower";
let count = 3;

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--query" && argv[i + 1]) {
    sampleQuery = argv[++i];
  } else if (arg === "--url" && argv[i + 1]) {
    sampleUrl = argv[++i];
    tool = "fetch_page";
  } else if (arg === "--tool" && argv[i + 1]) {
    tool = argv[++i];
  } else if (arg === "--count" && argv[i + 1]) {
    count = Number(argv[++i]) || 3;
  } else if (!arg.startsWith("--")) {
    sampleQuery = arg;
  }
}

console.log("正在弹出本地桌面窗口（可在窗口右上角点击「⚙ LLM 接口配置」设置或切换模型，输入内容后测试流式思考与生成）...");

const result = await promptUserViaNativeGui({
  tool,
  args: tool === "fetch_page" ? { url: sampleUrl, max_length: 1500 } : { query: sampleQuery, count }
});

if (result.ok) {
  console.log("\n=== 窗口已确认返回以下内容 ===\n");
  console.log(result.output);
} else {
  console.log("\n=== 窗口已关闭或返回 503 错误 ===\n", result.error);
}
