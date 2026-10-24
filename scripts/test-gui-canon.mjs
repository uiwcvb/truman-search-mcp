import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as pause } from "node:timers/promises";

const project = fileURLToPath(new URL("../", import.meta.url));
const fact = "CANON_GUI_FIXTURE: a recorded fact absent from the draft";
const output = 'The search for "fixture" returned the following results:\n\n[1] Title: Fixture\nURL: https://example.com/fixture\nDescription: Controlled test output.';

async function exerciseApproval({ sessionId, route, failSave = false }) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "truman-gui-canon-"));
  const configDir = path.join(scratch, "config");
  const statePath = path.join(configDir, "runtime-state.json");
  const originalSpawn = childProcess.spawn;
  const originalFetch = globalThis.fetch;
  const originalRename = fs.renameSync;
  let ipcUrl;
  let pending;
  let settled = false;
  try {
    fs.cpSync(path.join(project, "src"), path.join(scratch, "src"), { recursive: true });
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, "director-settings.json"), JSON.stringify({
      autoApprove: false, passthroughMode: false, autoStart: false,
      llm: { provider: "openai", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-key", model: "fixture-model" }
    }));
    fs.writeFileSync(statePath, JSON.stringify({
      sessions: sessionId === "new" ? [] : [{ id: sessionId, name: "Fixture session", canonNotes: "Operator notes", entries: [] }],
      history: [], urlCache: {}, activeSessionId: sessionId === "new" ? "" : sessionId
    }));

    // Exercise the real IPC handlers without launching a desktop app.
    childProcess.spawn = (_command, args) => {
      const ipcIndex = args.indexOf("-IpcUrl");
      ipcUrl = args[ipcIndex >= 0 ? ipcIndex + 1 : 1];
      const process = new EventEmitter();
      process.stdout = new EventEmitter();
      process.stderr = new EventEmitter();
      process.killed = false;
      process.kill = () => { process.killed = true; return true; };
      return process;
    };
    syncBuiltinESMExports();
    let step = 0;
    globalThis.fetch = async url => {
      assert.ok(String(url).startsWith("https://fixture.invalid/"), "Unexpected external request");
      const name = step++ === 0 ? "record_canon" : "deliver_search_results";
      const args = name === "record_canon" ? { fact } : { formatted_text: output };
      return new Response(JSON.stringify({ choices: [{ message: {
        tool_calls: [{ id: `fixture-${step}`, type: "function", function: { name, arguments: JSON.stringify(args) } }]
      } }] }), { headers: { "Content-Type": "application/json" } });
    };
    const { promptUserViaNativeGui } = await import(pathToFileURL(path.join(scratch, "src/gui-bridge.mjs")));
    pending = promptUserViaNativeGui({ tool: "web_search", args: { query: "fixture" } });
    pending.then(() => { settled = true; });
    for (let i = 0; !ipcUrl && i < 100; i++) await pause(10);
    assert.ok(ipcUrl, "GUI IPC endpoint did not start");

    const request = async (endpoint, body) => {
      const response = await originalFetch(ipcUrl + endpoint, body === undefined ? undefined : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      return { status: response.status, data: await response.json() };
    };
    const generated = await request(route, { sessionId, realityPrompt: "Fixture scenario", stream: false });
    assert.equal(generated.status, 200);
    let draft;
    if (route === "/generate-start") {
      for (let i = 0; i < 100; i++) {
        const { data } = await request("/generate-status");
        if (data.done) { draft = data; break; }
        await pause(10);
      }
    } else {
      draft = { content: generated.data.draftOutput, canonUpdates: generated.data.canonUpdates };
    }
    assert.ok(draft, "Generation did not complete");
    assert.ok(draft.canonUpdates.includes(fact));

    // Both native frontends submit the edited draft and notes, without canonUpdates.
    const approval = { action: "approve", output: draft.content, sessionId, canonNotes: "Operator notes", realityPrompt: "Fixture scenario" };
    if (failSave) {
      fs.renameSync = (source, destination) => {
        if (destination === statePath) throw new Error("Controlled persistence failure");
        return originalRename(source, destination);
      };
      const failed = await request("/resolve", approval);
      assert.equal(failed.status, 500);
      assert.match(failed.data.error, /Failed to save runtime state/);
      assert.equal(settled, false, "Failed approval must not return success to the Agent");
      fs.renameSync = originalRename;
    }
    const approved = await request("/resolve", approval);
    assert.equal(approved.status, 200);
    assert.equal((await pending).ok, true);
    const stored = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.ok(stored.sessions[0].canonNotes.includes(fact), "Approving the real GUI payload must persist generated canon updates");
    assert.ok(stored.sessions[0].canonNotes.includes("Operator notes"));
  } finally {
    fs.renameSync = originalRename;
    if (pending && !settled && ipcUrl) {
      await originalFetch(ipcUrl + "/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"action":"reject"}' }).catch(() => {});
      await pending;
    }
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    globalThis.fetch = originalFetch;
    assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

for (const sessionId of ["new", "fixture-session"]) {
  for (const route of ["/generate", "/generate-start"]) {
    test(`GUI approval persists canon for ${sessionId} via ${route}`, { timeout: 10000 }, () => exerciseApproval({ sessionId, route }));
  }
}

test("GUI approval reports persistence errors and allows retry", { timeout: 10000 }, () => exerciseApproval({ sessionId: "new", route: "/generate-start", failSave: true }));
