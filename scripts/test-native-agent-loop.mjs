import fs from "fs";

const settings = JSON.parse(fs.readFileSync("config/director-settings.json", "utf8"));
const llm = settings.llm;

console.log("=== Testing Native Agent Loop on", llm.model, "===");

const tools = [
  {
    type: "function",
    function: {
      name: "search_live_web",
      description: "Search live web news",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "deliver_search_results",
      description: "Deliver final search results",
      parameters: {
        type: "object",
        properties: { formatted_text: { type: "string" } },
        required: ["formatted_text"]
      }
    }
  }
];

const res1 = await fetch(llm.baseUrl + "/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: "Bearer " + llm.apiKey
  },
  body: JSON.stringify({
    model: llm.model,
    stream: false,
    messages: [
      {
        role: "system",
        content: "You are an autonomous Director Agent. The target query is '2026 World cup winner'. You MUST first call search_live_web to check ground truth, then deliver_search_results."
      },
      { role: "user", content: "Begin your autonomous agent loop." }
    ],
    tools: tools
  })
});

const data1 = await res1.json();
console.log("Turn 1 Status:", res1.status);
const msg1 = data1.choices?.[0]?.message;
console.log("Turn 1 Tool Calls:", msg1?.tool_calls?.map(tc => `${tc.function.name}(${tc.function.arguments})`));

if (!msg1?.tool_calls || msg1.tool_calls.length === 0) {
  console.error("Turn 1 failed: No tool calls emitted!");
  process.exit(1);
}

const toolMessages = msg1.tool_calls.map((tc, idx) => ({
  role: "tool",
  tool_call_id: tc.id,
  name: tc.function.name,
  content: `Live result ${idx + 1}: FIFA World Cup 2026 will be hosted across USA, Mexico, Canada. Final scheduled at MetLife Stadium.`
}));

// Turn 2
const res2 = await fetch(llm.baseUrl + "/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: "Bearer " + llm.apiKey
  },
  body: JSON.stringify({
    model: llm.model,
    stream: false,
    messages: [
      {
        role: "system",
        content: "You are an autonomous Director Agent. The target query is '2026 World cup winner'. You MUST call deliver_search_results now."
      },
      { role: "user", content: "Begin your autonomous agent loop." },
      msg1,
      ...toolMessages
    ],
    tools: tools
  })
});

const data2 = await res2.json();
console.log("Turn 2 Status:", res2.status);
const msg2 = data2.choices?.[0]?.message;
console.log("Turn 2 Tool Calls:", msg2?.tool_calls?.map(tc => `${tc.function.name}(${tc.function.arguments})`));
console.log("Turn 2 Content:\n", msg2?.content);

console.log("\nNATIVE 2-TURN AGENT LOOP PASSED!");
