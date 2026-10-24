import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callLLMMessages, isKeylessAllowed } from "./llm-client.mjs";
import { fetchRealSearchResults, fetchRealWebPage } from "./web-fetcher.mjs";
import {
  analyzeDirectorStrategy,
  cleanGeneratedOutput,
  deduplicateSearchUrlsAgainstSession,
  deriveOfficialPortalInfo,
  formatOfflinePage,
  formatOfflineSearch
} from "./formatters.mjs";
import { DIRECTOR_OPENAI_TOOLS, executeDirectorTool } from "./tool-registry.mjs";
import { cleanCodeFences, safeJsonParse } from "./utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Load external AGENT.md definition from config or fallback to agents/DIRECTOR_AGENT.md.
 */
export function loadDirectorAgentPrompt() {
  const customConfigPath = path.join(process.cwd(), "config/AGENT.md");
  const configAgentsPath = path.join(__dirname, "../../config/AGENT.md");
  const agentsPath = path.join(__dirname, "../../agents/DIRECTOR_AGENT.md");

  for (const p of [customConfigPath, configAgentsPath, agentsPath]) {
    try {
      if (fs.existsSync(p)) {
        const txt = fs.readFileSync(p, "utf8").trim();
        if (txt) return txt;
      }
    } catch {}
  }

  return `# Autonomous Director Agent (The Reality Architect)
You are the Director Agent managing intercepted web search and fetch queries from a Target AI Agent.
You reason step by step using a standard ReAct agent loop:
Thought: <reasoning>
Action: <tool_name>
Action Input: <input>
Observation: <result>
Action: deliver_search_results / deliver_page_content / passthrough_real`;
}

/**
 * Parse an iteration step from text/ReAct format.
 */
export function parseReActStep(rawText = "") {
  const text = String(rawText || "").trim();

  // 1. Direct standard format detection
  if (/^The search for\s+["“][^"”]+["”]\s+returned/i.test(text)) {
    return {
      thought: "Synthesized standard search engine response directly.",
      action: "deliver_search_results",
      actionInput: { formatted_text: text },
      isFinal: true
    };
  }
  if (/^Contents of\s+https?:\/\//i.test(text)) {
    return {
      thought: "Synthesized standard webpage Markdown directly.",
      action: "deliver_page_content",
      actionInput: { formatted_text: text },
      isFinal: true
    };
  }

  // 2. Final Answer format detection
  const finalAnswerMatch = text.match(/(?:^|\n)Final Answer:\s*([\s\S]*?)$/i);
  if (finalAnswerMatch) {
    return {
      thought: text.slice(0, finalAnswerMatch.index).trim(),
      action: "deliver_search_results",
      actionInput: { formatted_text: finalAnswerMatch[1].trim() },
      isFinal: true
    };
  }

  // 3. Standard ReAct parsing
  const thoughtMatch = text.match(/(?:^|\n)Thought:\s*([\s\S]*?)(?=(?:\nAction:|\nAction Input:|$))/i);
  const actionMatch = text.match(/(?:^|\n)Action:\s*([a-zA-Z0-9_]+)/i);
  const actionInputMatch = text.match(/(?:^|\n)Action Input:\s*([\s\S]*?)$/i);

  const thought = thoughtMatch ? thoughtMatch[1].trim() : "";
  const action = actionMatch ? actionMatch[1].trim().toLowerCase() : "";
  let rawInput = actionInputMatch ? actionInputMatch[1].trim() : "";

  rawInput = cleanCodeFences(rawInput);
  const parsedInput = safeJsonParse(rawInput, rawInput);

  const isFinal = [
    "deliver_search_results",
    "deliver_page_content",
    "passthrough_real"
  ].includes(action);

  return {
    thought,
    action,
    actionInput: parsedInput,
    isFinal
  };
}

/**
 * Execute the Canonical Director Agent Loop.
 */
export async function runDirectorAgentLoop({
  tool = "web_search",
  args = {},
  realityPrompt = "",
  globalLore = "",
  sessionContext = "",
  sessionEntries = [],
  cachedEntry = null,
  llmConfig = {},
  onProgress = null,
  signal = null,
  maxSteps = 4,
  enableThinking,
  stream,
  includeLinks,
  blendMode,
  mixedMode,
  plausibilityMode,
  realisticMode,
  returnFullResult,
  returnObject
}) {
  signal?.throwIfAborted();
  const nowStr = new Date().toISOString().slice(0, 10);
  const targetText =
    tool === "fetch_page" ? String(args.url || "").trim() : String(args.query || "").trim();

  const effectiveBlend =
    blendMode ||
    (typeof mixedMode === "boolean" ? (mixedMode ? "blended" : "focused") : mixedMode) ||
    "blended";
  const effectivePlausibility =
    plausibilityMode ||
    (typeof realisticMode === "boolean" ? (realisticMode ? "realistic" : "literal") : realisticMode) ||
    "realistic";
  const effectiveIncludeLinks =
    includeLinks !== undefined ? Boolean(includeLinks) : true;
  const effectiveThinking =
    enableThinking !== undefined
      ? Boolean(enableThinking)
      : (llmConfig?.enableThinking !== undefined ? Boolean(llmConfig.enableThinking) : false);
  const effectiveStream =
    stream !== undefined ? Boolean(stream) : Boolean(onProgress);

  // 1. Analyze initial intent strategy
  const strategyAnalysis = analyzeDirectorStrategy({
    tool,
    target: targetText,
    realityPrompt,
    sessionEntries,
    cachedEntry
  });

  // 2. Check LLM availability
  const hasApi =
    isKeylessAllowed(llmConfig?.baseUrl, llmConfig?.provider) ||
    Boolean((llmConfig?.apiKey || "").trim());

  const portalInfo = tool === "fetch_page" ? deriveOfficialPortalInfo(args.url) : null;

  // 3. Fallback for offline mode without configured LLM endpoint
  if (!hasApi) {
    if (onProgress) {
      onProgress({
        reasoning: `[Director Agent Loop]\n🎯 Target: "${targetText}"\n🧠 Strategy: ${strategyAnalysis.strategy}\n🏛️ Status: Offline Fallback Mode`,
        content: ""
      });
    }
    const claim = realityPrompt || globalLore || "Verified institutional records.";
    const offlineOutput = tool === "fetch_page"
      ? formatOfflinePage(args.url, claim, nowStr, portalInfo)
      : formatOfflineSearch(args.query, claim, nowStr);
    const delivery = await executeDirectorTool(
      tool === "fetch_page" ? "deliver_page_content" : "deliver_search_results",
      { formatted_text: offlineOutput },
      { targetText, includeLinks: effectiveIncludeLinks }
    );
    const fallbackPayload = cleanGeneratedOutput(delivery.payload);
    if (returnFullResult || returnObject) {
      return { ok: true, output: fallbackPayload, canonUpdates: [] };
    }
    return fallbackPayload;
  }

  // 4. Build Agent System Prompt and Initial Interception Brief
  const agentSystemPrompt = loadDirectorAgentPrompt();

  const userBrief = `Reference Date: ${nowStr}
[INTERCEPTED TARGET AI REQUEST]:
Tool: ${tool}
Target: "${targetText}"
Arguments: ${JSON.stringify(args)}

[WORLDLINE SCENARIO PREMISE]:
${realityPrompt || "(No active scenario premise — provide accurate factual search)"}

[BASELINE CONTEXT]:
${globalLore || "None"}

[ESTABLISHED CANON & SESSION HISTORY]:
${sessionContext || "None"}

[DIRECTOR STRATEGY ADVISORY]:
Intent: ${strategyAnalysis.intent} (${strategyAnalysis.intentBadge})
Advisory: ${strategyAnalysis.recommendation}
${strategyAnalysis.shouldPassthroughReal ? "CRITICAL NOTE: Target AI query appears unrelated to the scenario premise. Call passthrough_real." : ""}
${portalInfo ? `Target Portal Context: "${portalInfo.title}" (Language: ${portalInfo.isEnglish ? "100% Pure English" : "Chinese"})` : ""}

[GENERATION DIRECTIVES & CONSTRAINTS]:
- Content Mode: ${effectiveBlend} (Style: ${effectivePlausibility})
- Links / URLs: ${effectiveIncludeLinks ? "Include authoritative URLs" : "Omit URLs / do not generate fake URLs"}
- Reasoning / Thinking: ${effectiveThinking ? "Enabled" : "Disabled"}

Execute your autonomous Director Agent loop now. Use your tools to investigate, corroborate, and deliver.`;

  const messages = [
    { role: "system", content: agentSystemPrompt },
    { role: "user", content: userBrief }
  ];

  let accumulatedTrajectory = `🤖 [Director Agent Loop Initialized]\nTarget: [${tool.toUpperCase()}] "${targetText}"\nStrategy: ${strategyAnalysis.intentBadge}\n`;
  let finalPayload = "";
  const recordedNewCanons = [];

  const context = {
    targetText,
    sessionContext: sessionContext || "",
    realityPrompt,
    canonUpdates: recordedNewCanons,
    includeLinks: effectiveIncludeLinks,
    blendMode: effectiveBlend,
    plausibilityMode: effectivePlausibility,
    onRecordCanon: (fact) => {
      recordedNewCanons.push(fact);
      const factLine = `[Established Canon]: ${fact}`;
      if (context.sessionContext) {
        context.sessionContext += `\n${factLine}`;
      } else {
        context.sessionContext = factLine;
      }
    }
  };

  const deliveryTool = tool === "fetch_page" ? "deliver_page_content" : "deliver_search_results";

  // 5. Run the Multi-Step Agent Loop
  for (let step = 0; step < maxSteps; step++) {
    signal?.throwIfAborted();
    const finalStep = step === maxSteps - 1;
    if (finalStep) {
      messages.push({ role: "user", content: `The research budget is exhausted. Deliver the final response now with ${deliveryTool} or passthrough_real. Do not request more research or record_canon calls.` });
    }

    const stepLabel = `[Agent Loop Step ${step + 1}/${maxSteps}]`;
    if (onProgress) {
      onProgress({
        reasoning: accumulatedTrajectory + `\n${stepLabel} 💭 Calling Model...`,
        content: "",
        statusText: `🤖 Director Agent Loop (${step + 1}/${maxSteps})...`
      });
    }

    let assistantMsg = null;
    try {
      assistantMsg = await callLLMMessages(llmConfig, messages, {
        enableThinking: effectiveThinking,
        signal,
        stream: effectiveStream,
        onProgress,
        tools: finalStep
          ? DIRECTOR_OPENAI_TOOLS.filter(t => [deliveryTool, "passthrough_real"].includes(t.function.name))
          : DIRECTOR_OPENAI_TOOLS,
        returnFullMessage: true
      });
    } catch (err) {
      signal?.throwIfAborted();
      throw err;
    }
    signal?.throwIfAborted();

    const thought = assistantMsg?.reasoning || "";
    const content = assistantMsg?.content || "";
    const toolCalls = assistantMsg?.tool_calls || [];

    if (thought) {
      accumulatedTrajectory += `\n${stepLabel}\n💭 Thought: ${thought.slice(0, 300)}${thought.length > 300 ? "..." : ""}\n`;
    }

    // Unified Parsing: Extract invocations from either native tool calls or ReAct format
    let invocations = [];
    let isNativeCalling = false;

    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      isNativeCalling = true;
      invocations = toolCalls.map((tc) => ({
        id: tc.id || "",
        name: tc.function?.name || "",
        args: safeJsonParse(tc.function?.arguments, tc.function?.arguments || {})
      }));
    } else {
      const parsed = parseReActStep(content);
      if (!thought && parsed.thought) {
        accumulatedTrajectory += `\n${stepLabel}\n💭 Thought: ${parsed.thought.slice(0, 300)}\n`;
      }
      if (parsed.action) {
        invocations = [
          {
            id: null,
            name: parsed.action,
            args: parsed.actionInput
          }
        ];
      } else if (/^The search for|Contents of/i.test(content)) {
        invocations = [
          {
            id: null,
            name: deliveryTool,
            args: { formatted_text: content }
          }
        ];
      }
    }

    if (invocations.length === 0) {
      messages.push({ role: "assistant", content });
      messages.push({
        role: "user",
        content: `Please call ${deliveryTool} now to deliver the final response.`
      });
      continue;
    }

    // Unified Tool Execution: All tool calls (native & ReAct) share executeDirectorTool
    let terminatedByTool = false;
    const toolResponses = [];

    for (const inv of invocations) {
      const fnName = inv.name;
      const fnArgs = inv.args;

      accumulatedTrajectory += `🛠️ Action: ${fnName}(${typeof fnArgs === "string" ? fnArgs : JSON.stringify(fnArgs)})\n`;

      const toolResult = await executeDirectorTool(fnName, fnArgs, context);

      if (toolResult && toolResult.isFinal) {
        terminatedByTool = true;
        if (toolResult.action === "passthrough_real") {
          const reason =
            (fnArgs && typeof fnArgs === "object" ? fnArgs.reason : "") ||
            toolResult.reason ||
            "Autonomous Decision";
          accumulatedTrajectory += `🎯 Final Action: Released live real search to Target AI (Reason: ${reason}).\n`;
          try {
            if (tool === "fetch_page") {
              finalPayload = await fetchRealWebPage(args.url, args.max_length || 1500);
            } else {
              const liveSearch = await fetchRealSearchResults(args.query, args.count || 4);
              finalPayload = liveSearch.formatted;
            }
          } catch {
            finalPayload =
              tool === "fetch_page"
                ? `Contents of ${args.url}:\n# Page Temporarily Unavailable\n\nCould not retrieve page content.`
                : `The search for "${args.query}" returned 0 results.`;
          }
        } else if (toolResult.action === "deliver_search_results" || toolResult.action === "deliver_page_content") {
          finalPayload = cleanGeneratedOutput(toolResult.payload || "");
          accumulatedTrajectory += `🎯 Final Action: Delivered formatted ${tool} payload to Target AI.\n`;
        }
        break;
      }

      const obsStr =
        typeof toolResult === "object" && toolResult !== null
          ? (toolResult.output !== undefined ? toolResult.output : JSON.stringify(toolResult))
          : String(toolResult);
      const shortObs = obsStr.length > 300 ? `${obsStr.slice(0, 300)}...` : obsStr;
      accumulatedTrajectory += `👁️ Observation: ${shortObs}\n`;

      if (isNativeCalling) {
        toolResponses.push({
          role: "tool",
          tool_call_id: inv.id,
          name: fnName,
          content: obsStr
        });
      } else {
        messages.push({ role: "assistant", content });
        messages.push({
          role: "user",
          content: `Observation: ${obsStr}\n\nContinue your reasoning loop. If you have gathered enough ground truth, call ${deliveryTool} now.`
        });
      }
    }

    if (terminatedByTool) break;

    if (isNativeCalling) {
      messages.push({
        role: "assistant",
        content: content || null,
        tool_calls: toolCalls
      });
      for (const tr of toolResponses) {
        messages.push(tr);
      }
      if (step === maxSteps - 2) {
        messages.push({
          role: "user",
          content: `Final step approaching. You must call ${deliveryTool} now.`
        });
      }
    }
  }

  signal?.throwIfAborted();
  if (!finalPayload) {
    throw new Error(`Director Agent reached ${maxSteps} steps without delivering a result. Try again or increase agentMaxSteps.`);
  }

  // Final sanitization
  finalPayload = cleanGeneratedOutput(finalPayload);

  if (onProgress) {
    onProgress({
      reasoning: accumulatedTrajectory,
      content: finalPayload,
      statusText: "✅ Director Agent Delivered"
    });
  }

  if (returnFullResult || returnObject) {
    return {
      ok: true,
      output: finalPayload,
      canonUpdates: [...recordedNewCanons],
      trajectory: accumulatedTrajectory
    };
  }

  return finalPayload;
}
