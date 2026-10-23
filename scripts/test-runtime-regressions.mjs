import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { splitThinkAndContent } from "../src/core/formatters.mjs";
import { callLLMMessages } from "../src/core/llm-client.mjs";
import { runDirectorAgentLoop } from "../src/core/agent-loop.mjs";

const serverUrl = new URL("../src/mcp-server.mjs", import.meta.url);
const fixtureConfig = { provider: "openai", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-key", model: "fixture" };
const finalText = 'The search for "fixture" returned the following results:\n\n[1] Title: Fixture result\nURL: https://example.com/fixture\nDescription: A controlled test result.';
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

async function withFetch(replacement, body) {
  const original = globalThis.fetch;
  globalThis.fetch = replacement;
  try { return await body(); } finally { globalThis.fetch = original; }
}

test("plain replies and ReAct actions survive reasoning separation", () => {
  for (const content of ["PONG", 'Thought: Inspect the context.\nAction: query_canon\nAction Input: {}']) {
    assert.equal(splitThinkAndContent(content).content, content);
  }
  const separated = splitThinkAndContent('<think>private reasoning</think>\nPONG');
  assert.equal(separated.content, "PONG");
  assert.equal(separated.reasoning, "private reasoning");
});

for (const provider of ["gemini", "anthropic"]) {
  test(`${provider} supports both text completion and Director message responses`, async () => {
    await withFetch(async () => jsonResponse(provider === "gemini"
      ? { candidates: [{ content: { parts: [{ text: "PONG" }] } }] }
      : { content: [{ type: "text", text: "PONG" }] }), async () => {
      const config = { ...fixtureConfig, provider };
      const messages = [{ role: "user", content: "Connectivity test" }];
      assert.equal(await callLLMMessages(config, messages), "PONG");
      const result = await callLLMMessages(config, messages, { returnFullMessage: true });
      assert.equal(result.role, "assistant");
      assert.equal(result.content, "PONG");
      assert.equal(result.tool_calls, null);
    });
  });
}

test("Director executes a text ReAct action and consumes its observation", async () => {
  const requests = [];
  await withFetch(async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return jsonResponse({ choices: [{ message: { content: requests.length === 1
      ? 'Thought: Inspect the context.\nAction: query_canon\nAction Input: {}'
      : finalText } }] });
  }, async () => {
    const result = await runDirectorAgentLoop({ args: { query: "fixture" }, realityPrompt: "fixture", sessionContext: "Existing fixture context", llmConfig: fixtureConfig, maxSteps: 2 });
    assert.match(result, /Fixture result/);
    assert.equal(requests.length, 2);
    assert.ok(requests[1].messages.some(m => m.content?.startsWith("Observation:") && m.content.includes("Existing fixture context")));
    assert.deepEqual(requests[1].tools.map(t => t.function.name).sort(), ["deliver_search_results", "passthrough_real"]);
  });
});

test("LLM errors and exhausted loops are failures, not offline successes", async () => {
  await withFetch(async () => new Response("fixture unauthorized", { status: 401 }), async () => {
    await assert.rejects(runDirectorAgentLoop({ args: { query: "fixture" }, llmConfig: fixtureConfig }), /401/);
  });
  await withFetch(async () => jsonResponse({ choices: [{ message: { content: "No completed result yet." } }] }), async () => {
    await assert.rejects(runDirectorAgentLoop({ args: { query: "fixture" }, llmConfig: fixtureConfig, maxSteps: 1 }), /without delivering a result/);
  });
});

test("cancellation rejects before and during model generation", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runDirectorAgentLoop({ signal: controller.signal }), { name: "AbortError" });
  const active = new AbortController();
  const updates = [];
  await withFetch(async () => {
    active.abort();
    throw active.signal.reason;
  }, async () => {
    await assert.rejects(runDirectorAgentLoop({ args: { query: "fixture" }, llmConfig: fixtureConfig, signal: active.signal, onProgress: update => updates.push(update) }), { name: "AbortError" });
    assert.ok(!updates.some(update => update.statusText?.includes("Delivered")));
  });
});

test("importing MCP handlers does not claim stdin or terminate its caller", () => {
  const program = `import ${JSON.stringify(serverUrl.href)}; setTimeout(() => console.log('IMPORT_TIMER_COMPLETED'), 50);`;
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", program], { encoding: "utf8", input: "", timeout: 5000 });
  assert.match(output, /IMPORT_TIMER_COMPLETED/);
});

test("MCP executable exchanges JSON-RPC over real stdio", async () => {
  const child = spawn(process.execPath, [fileURLToPath(serverUrl)], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("MCP stdio response timed out")), 5000);
      let pending = "";
      const responses = new Map();
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        pending += chunk;
        let newline;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          try {
            const message = JSON.parse(line);
            responses.set(message.id, message);
            if (responses.size === 3) {
              assert.equal(responses.get(1).result.serverInfo.name, "web-search");
              assert.deepEqual(responses.get(2).result.tools.map(t => t.name), ["web_search", "fetch_page"]);
              assert.deepEqual(responses.get(3).result, {});
              clearTimeout(timer);
              resolve();
            }
          } catch (error) { clearTimeout(timer); reject(error); }
        }
      });
      for (const [id, method] of [[1, "initialize"], [2, "tools/list"], [3, "ping"]]) {
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: { protocolVersion: "2025-06-18" } }) + "\n");
      }
    });
  } finally { child.stdin.end(); child.kill(); }
});
