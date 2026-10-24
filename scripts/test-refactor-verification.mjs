import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  callLLMMessages,
  callLLM,
  buildOpenAiPayload,
  executeOpenAiAttempt
} from "../src/core/llm-client.mjs";

import {
  runDirectorAgentLoop,
  parseReActStep
} from "../src/core/agent-loop.mjs";

import {
  executeDirectorTool,
  DIRECTOR_OPENAI_TOOLS
} from "../src/core/tool-registry.mjs";

import {
  formatSearchResults,
  formatPageMarkdown
} from "../src/core/formatters.mjs";

import {
  saveRuntimeState,
  loadRuntimeState,
  prepareRuntimeStateForSave,
  recordResolution,
  resolveSessionContextData
} from "../src/core/session-store.mjs";

const jsonResponse = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });

const textResponse = (text, status = 200) =>
  new Response(text, {
    status,
    headers: { "Content-Type": "text/plain" }
  });

async function withFetch(replacement, body) {
  const original = globalThis.fetch;
  globalThis.fetch = replacement;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

// ===========================================================================
// ISSUE 1: Settings propagation & enableThinking: false respect
// ===========================================================================
test("Issue 1: enableThinking: false and stream: false are respected across agent loop and outgoing request", async () => {
  const requests = [];
  const fakeConfig = {
    provider: "openai",
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "test-key",
    model: "test-model"
  };

  const deliverResultsText = 'The search for "test query" returned the following results:\n\n[1] Title: R1\nURL: https://example.com/1\nDescription: D1';

  await withFetch(
    async (_url, init) => {
      const parsedBody = JSON.parse(init.body);
      requests.push(parsedBody);
      return jsonResponse({
        choices: [
          {
            message: {
              content: deliverResultsText
            }
          }
        ]
      });
    },
    async () => {
      const output = await runDirectorAgentLoop({
        args: { query: "test query" },
        realityPrompt: "Test premise",
        llmConfig: fakeConfig,
        enableThinking: false,
        stream: false,
        includeLinks: false,
        blendMode: "focused",
        plausibilityMode: "literal",
        maxSteps: 1
      });

      assert.equal(requests.length, 1);
      const req = requests[0];

      // Verify stream is false as requested
      assert.equal(req.stream, false, "Outgoing request stream should be false");

      // Verify max_tokens is capped appropriately when thinking is disabled
      assert.ok(req.max_tokens <= 4096, "effectiveMaxTokens should be capped when thinking is disabled");

      // Verify prompt construction contains constraints
      const userMsg = req.messages.find((m) => m.role === "user");
      assert.ok(userMsg, "User brief message must exist");
      assert.ok(userMsg.content.includes("Content Mode: focused"), "Content mode reflected in prompt");
      assert.ok(userMsg.content.includes("Style: literal"), "Style mode reflected in prompt");
      assert.ok(userMsg.content.includes("Reasoning / Thinking: Disabled"), "Thinking toggle reflected in prompt");
      assert.ok(userMsg.content.includes("Omit URLs"), "Link toggle reflected in prompt");

      // Verify output links are suppressed when includeLinks is false
      assert.ok(!output.includes("URL: https://example.com"), "Output must not include URLs when includeLinks: false");
    }
  );
});

// ===========================================================================
// ISSUE 2: Native tool calling and ReAct share unified executeDirectorTool
// ===========================================================================
test("Issue 2: ReAct format with {results: [...]} uses executeDirectorTool and formats identical to native tool calls", async () => {
  const sampleItems = [
    { title: "Article One", url: "https://example.com/1", published: "2026-10-24", description: "First desc" },
    { title: "Article Two", url: "https://example.com/2", published: "2026-10-24", description: "Second desc" }
  ];

  const fakeConfig = {
    provider: "openai",
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "test-key",
    model: "test-model"
  };

  // Branch A: Native tool calls
  let nativeOutput = "";
  await withFetch(
    async () => {
      return jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "deliver_search_results",
                    arguments: JSON.stringify({ results: sampleItems })
                  }
                }
              ]
            }
          }
        ]
      });
    },
    async () => {
      nativeOutput = await runDirectorAgentLoop({
        args: { query: "sample topic" },
        realityPrompt: "Sample premise",
        llmConfig: fakeConfig,
        maxSteps: 1
      });
    }
  );

  // Branch B: ReAct text format emitting Action: deliver_search_results with { results: [...] }
  let reactOutput = "";
  await withFetch(
    async () => {
      const reactText = `Thought: I will deliver structured search results.\nAction: deliver_search_results\nAction Input: ${JSON.stringify({ results: sampleItems })}`;
      return jsonResponse({
        choices: [
          {
            message: {
              content: reactText
            }
          }
        ]
      });
    },
    async () => {
      reactOutput = await runDirectorAgentLoop({
        args: { query: "sample topic" },
        realityPrompt: "Sample premise",
        llmConfig: fakeConfig,
        maxSteps: 1
      });
    }
  );

  // Both MUST be formatted identically and not contain raw "Action: deliver_search_results"
  assert.ok(!reactOutput.includes("Action: deliver_search_results"), "ReAct output must not return raw action text");
  assert.equal(reactOutput, nativeOutput, "ReAct format and Native tool call must produce identical normalized outputs");
  assert.ok(reactOutput.includes("[1] Title: Article One"), "Normalized search item 1 present");
  assert.ok(reactOutput.includes("[2] Title: Article Two"), "Normalized search item 2 present");
});

// ===========================================================================
// ISSUE 3: Full data flow for record_canon (in-flight context & persistence)
// ===========================================================================
test("Issue 3: record_canon updates in-flight context immediately and returns canonUpdates for persistence", async () => {
  const fakeConfig = {
    provider: "openai",
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "test-key",
    model: "test-model"
  };

  const requests = [];
  const canonFact = "China national team won 2-1 against Argentina at MetLife Stadium";

  await withFetch(
    async (_url, init) => {
      const parsed = JSON.parse(init.body);
      requests.push(parsed);

      if (requests.length === 1) {
        // Step 1: Director decides to record a new canon fact
        return jsonResponse({
          choices: [
            {
              message: {
                content: `Thought: Record the historic final score.\nAction: record_canon\nAction Input: {"fact": "${canonFact}"}`
              }
            }
          ]
        });
      } else if (requests.length === 2) {
        // Step 2: Director calls query_canon to verify it sees the updated canon
        return jsonResponse({
          choices: [
            {
              message: {
                content: 'Thought: Check the canon context now.\nAction: query_canon\nAction Input: {}'
              }
            }
          ]
        });
      } else {
        // Step 3: Deliver final search results
        return jsonResponse({
          choices: [
            {
              message: {
                content: `The search for "world cup final" returned the following results:\n\n[1] Title: Final Report\nURL: https://fifa.com/final\nDescription: ${canonFact}`
              }
            }
          ]
        });
      }
    },
    async () => {
      const result = await runDirectorAgentLoop({
        args: { query: "world cup final" },
        realityPrompt: "World Cup 2026",
        sessionContext: "Initial context before recording.",
        llmConfig: fakeConfig,
        maxSteps: 3,
        returnFullResult: true
      });

      // 1. In-flight update: Step 2 observation must contain the new fact recorded in Step 1!
      assert.equal(requests.length, 3, "Agent loop executed 3 steps");
      const step2UserMsg = requests[1].messages.find(
        (m) => m.content && m.content.startsWith("Observation:")
      );
      assert.ok(step2UserMsg, "Step 2 must receive an observation from record_canon");
      assert.ok(
        step2UserMsg.content.includes("successfully recorded"),
        "Step 2 observation confirms recording"
      );

      // Step 3 user message should contain the observation from query_canon
      const step3UserMsg = requests[2].messages.filter(
        (m) => m.content && m.content.startsWith("Observation:")
      ).at(-1);
      assert.ok(step3UserMsg, "Step 3 must receive observation from query_canon");
      assert.ok(
        step3UserMsg.content.includes(canonFact),
        "Subsequent query_canon step in the same turn sees the in-flight updated canon fact!"
      );

      // 2. Returned result structure
      assert.equal(result.ok, true);
      assert.ok(Array.isArray(result.canonUpdates), "canonUpdates must be an array");
      assert.ok(result.canonUpdates.includes(canonFact), "canonUpdates contains the recorded fact");

      // 3. Persistence into session state
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "truman-test-canon-"));
      try {
        const state = {
          sessions: [
            {
              id: "sess_test",
              name: "Test Session",
              realityPrompt: "World Cup 2026",
              canonNotes: "Earlier notes.",
              entries: []
            }
          ],
          activeSessionId: "sess_test",
          history: [],
          urlCache: {}
        };

        recordResolution({
          tool: "web_search",
          args: { query: "world cup final" },
          output: result.output,
          realityPrompt: "World Cup 2026",
          sessionId: "sess_test",
          canonUpdates: result.canonUpdates,
          runtimeState: state,
          configDir: tmpDir
        });

        // Verify session canonNotes merged the new fact
        const updatedSession = state.sessions.find((s) => s.id === "sess_test");
        assert.ok(updatedSession.canonNotes.includes(canonFact), "Session canonNotes merged the recorded fact");

        // Verify next turn retrieves it via resolveSessionContextData
        const persistedState = loadRuntimeState(tmpDir);
        const { sessionContext } = resolveSessionContextData(persistedState, { sessionId: "sess_test" });
        assert.ok(sessionContext.includes(canonFact), "Next turn sees the persisted canon fact in session context!");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  );
});

// ===========================================================================
// ISSUE 4: LLM Client retry & error isolation (no stale 503 error body on 401)
// ===========================================================================
test("Issue 4: Attempt 1 with 503 and attempt 2 with 401 does NOT retain stale 503 body", async () => {
  let callCount = 0;
  const config = {
    provider: "openai",
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "test-key",
    model: "test-model"
  };

  await withFetch(
    async () => {
      callCount++;
      if (callCount === 1) {
        // Attempt 1: 503 Service Unavailable with 503 body
        return textResponse("Upstream server is temporarily overloaded (HTTP 503)", 503);
      } else {
        // Attempt 2: 401 Unauthorized with 401 body
        return textResponse("Unauthorized: Key expired or invalid token (HTTP 401)", 401);
      }
    },
    async () => {
      try {
        await callLLM(config, "System prompt", "User prompt", { maxTokens: 100, stream: false });
        assert.fail("Should have thrown on 401");
      } catch (err) {
        // Must report status 401
        assert.ok(err.message.includes("401"), `Error message should mention 401: ${err.message}`);
        // Must report the 401 body text, NOT the stale 503 body!
        assert.ok(
          err.message.includes("Unauthorized") || err.message.includes("invalid token"),
          `Error message should contain attempt 2 body: ${err.message}`
        );
        assert.ok(
          !err.message.includes("temporarily overloaded") && !err.message.includes("503"),
          `Error message MUST NOT contain stale 503 error text: ${err.message}`
        );
      }
    }
  );
});

// ===========================================================================
// ISSUE 5: session-store purity (no input mutation) & error propagation
// ===========================================================================
test("Issue 5: saveRuntimeState does not mutate in-memory input objects and propagates errors on failure", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "truman-test-save-"));

  try {
    // 1. Test purity & immutability of input objects
    const longOutput = "A".repeat(1200);
    const originalHistory = Array.from({ length: 25 }, (_, i) => ({
      id: `h_${i}`,
      tool: "web_search",
      output: longOutput
    }));
    const originalSessions = Array.from({ length: 20 }, (_, i) => ({
      id: `s_${i}`,
      name: `Session ${i}`,
      entries: Array.from({ length: 20 }, (_, j) => ({
        id: `e_${j}`,
        output: longOutput
      }))
    }));
    const originalUrlCache = {};
    for (let i = 0; i < 80; i++) {
      originalUrlCache[`https://example.com/${i}`] = { url: `https://example.com/${i}`, title: `Title ${i}` };
    }

    const stateToSave = {
      activeSessionId: "s_0",
      history: originalHistory,
      sessions: originalSessions,
      urlCache: originalUrlCache
    };

    // Save to valid directory
    const saveResult = saveRuntimeState(stateToSave, tmpDir);
    assert.equal(saveResult.ok, true);

    // CRITICAL: Caller's in-memory input object must NOT be mutated!
    assert.equal(stateToSave.history.length, 25, "Caller's history array length must not be mutated");
    assert.equal(stateToSave.history[0].output.length, 1200, "Caller's history output must not be truncated in memory");
    assert.equal(stateToSave.sessions.length, 20, "Caller's sessions array length must not be mutated");
    assert.equal(stateToSave.sessions[0].entries.length, 20, "Caller's session entries array must not be mutated");
    assert.equal(stateToSave.sessions[0].entries[0].output.length, 1200, "Caller's entry output must not be truncated in memory");
    assert.equal(Object.keys(stateToSave.urlCache).length, 80, "Caller's urlCache keys must not be deleted");

    // But the loaded state from disk MUST be properly bounded and trimmed
    const loadedState = loadRuntimeState(tmpDir);
    assert.ok(loadedState.history.length <= 15, "Disk state history bounded to 15");
    assert.ok(loadedState.history[0].output.length <= 600, "Disk state history output sliced to 600");
    assert.ok(loadedState.sessions.length <= 12, "Disk state sessions bounded to 12");
    assert.ok(loadedState.sessions[0].entries.length <= 12, "Disk state entries bounded to 12");
    assert.ok(loadedState.sessions[0].entries[0].output.length <= 900, "Disk state entries output sliced to 900");
    assert.ok(Object.keys(loadedState.urlCache).length <= 60, "Disk state urlCache bounded to 60");

    // 2. Test error propagation: disk write to invalid/forbidden path throws cleanly
    const invalidPath = path.join(tmpDir, "not-a-directory");
    fs.writeFileSync(invalidPath, "Controlled filesystem failure fixture");

    assert.throws(
      () => {
        saveRuntimeState(stateToSave, invalidPath);
      },
      /Failed to save runtime state/,
      "saveRuntimeState must throw when disk write fails instead of swallowing error in empty catch"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Offline search uses the same link toggle as online delivery", async () => {
  const result = await runDirectorAgentLoop({
    args: { query: "offline fixture" },
    realityPrompt: "Controlled offline fixture",
    llmConfig: {},
    includeLinks: false,
    returnFullResult: true
  });
  assert.match(result.output, /^The search for/);
  assert.doesNotMatch(result.output, /^URL:/m);
});
