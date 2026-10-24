import { splitThinkAndContent } from "./formatters.mjs";

/**
 * Check if the given endpoint allows keyless operation (e.g. local Ollama, vLLM).
 */
export function isKeylessAllowed(baseUrl = "", provider = "") {
  const p = (provider || "").toLowerCase();
  const u = (baseUrl || "").toLowerCase();
  return (
    p === "ollama" ||
    p === "local" ||
    u.includes("127.0.0.1") ||
    u.includes("localhost") ||
    u.includes("0.0.0.0")
  );
}

// ---------------------------------------------------------------------------
// 1. Protocol Adaptation Helpers
// ---------------------------------------------------------------------------

export function buildOpenAiPayload({
  model,
  messages,
  maxTokens,
  enableThinking,
  useStream,
  tools,
  includeThinkKwarg = false,
  includeTools = true
}) {
  const effectiveMaxTokens = enableThinking ? maxTokens : Math.min(maxTokens, 4096);
  const payload = {
    model,
    temperature: 0.55,
    max_tokens: effectiveMaxTokens,
    stream: useStream,
    messages: messages.length > 0 ? messages : [{ role: "user", content: "Hello" }]
  };
  if (includeTools && Array.isArray(tools) && tools.length > 0) {
    payload.tools = tools;
  }
  if (includeThinkKwarg) {
    payload.chat_template_kwargs = { enable_thinking: enableThinking };
  }
  return payload;
}

// ---------------------------------------------------------------------------
// 2. Response Parsing Helpers (JSON and SSE Streams)
// ---------------------------------------------------------------------------

export async function parseOpenAiJsonResponse(res, { enableThinking, onProgress, options }) {
  const data = await res.json();
  const msg = data?.choices?.[0]?.message || {};
  const { reasoning, content } = splitThinkAndContent(
    msg.content || "",
    msg.reasoning_content || msg.reasoning || "",
    { enableThinking }
  );
  if (onProgress) onProgress({ reasoning, content });

  if (options.returnFullMessage) {
    return {
      role: "assistant",
      content: content.trim(),
      reasoning: reasoning.trim(),
      tool_calls: Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0 ? msg.tool_calls : null
    };
  }

  const finalOut = (content || reasoning).trim();
  if (!finalOut && (!msg.tool_calls || msg.tool_calls.length === 0)) {
    throw new Error("LLM API returned empty content");
  }
  return finalOut;
}

export async function parseOpenAiSseStream(res, { enableThinking, onProgress, options }) {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let rawContentAcc = "";
  let explicitReasoningAcc = "";
  const toolCallsAcc = [];
  let lastProgressAt = 0;

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    let hasDelta = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const dataStr = trimmed.slice(5).trim();
      if (dataStr === "[DONE]") break;

      try {
        const parsed = JSON.parse(dataStr);
        const delta = parsed?.choices?.[0]?.delta || parsed?.choices?.[0]?.message || {};
        const rDelta = delta.reasoning_content ?? delta.reasoning ?? "";
        const cDelta = delta.content ?? "";

        if (rDelta) {
          explicitReasoningAcc += rDelta;
          hasDelta = true;
        }
        if (cDelta) {
          rawContentAcc += cDelta;
          hasDelta = true;
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? toolCallsAcc.length;
            if (!toolCallsAcc[idx]) {
              toolCallsAcc[idx] = { id: tc.id || "", type: "function", function: { name: "", arguments: "" } };
            }
            if (tc.id) toolCallsAcc[idx].id = tc.id;
            if (tc.function?.name) toolCallsAcc[idx].function.name += tc.function.name;
            if (tc.function?.arguments) toolCallsAcc[idx].function.arguments += tc.function.arguments;
          }
          hasDelta = true;
        }
      } catch {}
    }

    if (hasDelta && onProgress) {
      const nowMs = Date.now();
      if (nowMs - lastProgressAt >= 85) {
        lastProgressAt = nowMs;
        const split = splitThinkAndContent(rawContentAcc, explicitReasoningAcc, { enableThinking });
        onProgress({ reasoning: split.reasoning, content: split.content });
      }
    }
  }

  const finalSplit = splitThinkAndContent(rawContentAcc, explicitReasoningAcc, { enableThinking: false });
  if (onProgress) {
    onProgress({ reasoning: finalSplit.reasoning, content: finalSplit.content });
  }

  if (options.returnFullMessage) {
    return {
      role: "assistant",
      content: finalSplit.content.trim(),
      reasoning: finalSplit.reasoning.trim(),
      tool_calls: toolCallsAcc.length > 0 ? toolCallsAcc : null
    };
  }

  const finalResult = (finalSplit.content || finalSplit.reasoning).trim();
  if (!finalResult && toolCallsAcc.length === 0) {
    throw new Error("LLM stream returned empty output");
  }
  return finalResult;
}

// ---------------------------------------------------------------------------
// 3. Single-Attempt Execution with Isolated Attempt State
// ---------------------------------------------------------------------------

export async function executeOpenAiAttempt({
  endpoint,
  headers,
  payload,
  useStream,
  enableThinking,
  signal,
  onProgress,
  options
}) {
  let res = null;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify(payload)
    });
  } catch (netErr) {
    return {
      ok: false,
      status: 0,
      errorText: netErr.message || String(netErr),
      error: netErr
    };
  }

  if (!res.ok) {
    // Read error body specifically from this isolated attempt
    const errorText = await res.text().catch(() => "");
    const error = new Error(`LLM API Error (${res.status}): ${errorText.slice(0, 300)}`);
    error.status = res.status;
    error.responseBody = errorText;
    return {
      ok: false,
      status: res.status,
      errorText,
      error
    };
  }

  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  const isSse = useStream && contentType.includes("text/event-stream");

  try {
    const result = isSse
      ? await parseOpenAiSseStream(res, { enableThinking, onProgress, options })
      : await parseOpenAiJsonResponse(res, { enableThinking, onProgress, options });
    return {
      ok: true,
      status: res.status,
      result
    };
  } catch (parseErr) {
    return {
      ok: false,
      status: res.status,
      errorText: parseErr.message,
      error: parseErr
    };
  }
}

// ---------------------------------------------------------------------------
// 4. Retry & Compatibility Fallback Orchestrator
// ---------------------------------------------------------------------------

export async function callOpenAiWithRetries({
  endpoint,
  headers,
  model,
  messages,
  maxTokens,
  enableThinking,
  useStream,
  tools,
  isLocalEndpoint,
  signal,
  onProgress,
  options
}) {
  let lastAttemptError = null;

  for (let attempt = 0; attempt < 5; attempt++) {
    signal?.throwIfAborted();

    // 1. Primary execution attempt
    const primaryPayload = buildOpenAiPayload({
      model,
      messages,
      maxTokens,
      enableThinking,
      useStream,
      tools,
      includeThinkKwarg: isLocalEndpoint,
      includeTools: true
    });

    let attemptResult = await executeOpenAiAttempt({
      endpoint,
      headers,
      payload: primaryPayload,
      useStream,
      enableThinking,
      signal,
      onProgress,
      options
    });

    // 2. Fallback: if 400 and local endpoint, try without chat_template_kwargs
    if (!attemptResult.ok && attemptResult.status === 400 && isLocalEndpoint) {
      const noKwargsPayload = buildOpenAiPayload({
        model,
        messages,
        maxTokens,
        enableThinking,
        useStream,
        tools,
        includeThinkKwarg: false,
        includeTools: true
      });
      attemptResult = await executeOpenAiAttempt({
        endpoint,
        headers,
        payload: noKwargsPayload,
        useStream,
        enableThinking,
        signal,
        onProgress,
        options
      });
    }

    // 3. Fallback: if 400 and tools provided, endpoint may not support tools schema
    if (!attemptResult.ok && attemptResult.status === 400 && Array.isArray(tools) && tools.length > 0) {
      const noToolsPayload = buildOpenAiPayload({
        model,
        messages,
        maxTokens,
        enableThinking,
        useStream,
        tools: null,
        includeThinkKwarg: false,
        includeTools: false
      });
      attemptResult = await executeOpenAiAttempt({
        endpoint,
        headers,
        payload: noToolsPayload,
        useStream,
        enableThinking,
        signal,
        onProgress,
        options
      });
    }

    if (attemptResult.ok) {
      return attemptResult.result;
    }

    // Isolate error state: each attempt carries strictly its own error
    lastAttemptError = attemptResult.error;

    // Only retry on 503
    if (attemptResult.status !== 503) {
      throw lastAttemptError;
    }

    if (attempt < 4) {
      if (onProgress) {
        onProgress({
          reasoning: "",
          content: "",
          statusText: `⏳ Model busy (503), retrying (${attempt + 1}/5)...`
        });
      }
      await new Promise((r) => setTimeout(r, 900));
    }
  }

  throw lastAttemptError;
}

// ---------------------------------------------------------------------------
// 5. Unified Multi-Provider Entry Point
// ---------------------------------------------------------------------------

export async function callLLMMessages(llmConfig, messages = [], options = {}) {
  const provider = (llmConfig?.provider || "openai").toLowerCase();
  const apiKey = (llmConfig?.apiKey || "").trim();
  const model = (llmConfig?.model || "gpt-4o-mini").trim();
  let baseUrl = (llmConfig?.baseUrl || "https://api.openai.com/v1").trim().replace(/\/+$/, "");

  // Respect boolean false cleanly: options.enableThinking ?? llmConfig?.enableThinking ?? false
  const enableThinking = options.enableThinking !== undefined
    ? Boolean(options.enableThinking)
    : (llmConfig?.enableThinking !== undefined ? Boolean(llmConfig.enableThinking) : false);

  const configuredMax = Number(options.maxTokens || llmConfig?.maxTokens) || 0;
  const maxTokens = configuredMax > 0 ? configuredMax : 16384;
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const signal = options.signal || undefined;

  if (!isKeylessAllowed(baseUrl, provider) && !apiKey) {
    throw new Error("LLM API Key not configured (set in Settings or use a local endpoint)");
  }

  const systemMessage = messages.find((m) => m.role === "system")?.content || "";
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  // Provider: Gemini
  if (provider === "gemini") {
    const geminiBase = baseUrl.includes("generativelanguage.googleapis.com")
      ? baseUrl
      : "https://generativelanguage.googleapis.com/v1beta";
    const url = `${geminiBase}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const contents = nonSystemMessages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content || "" }]
    }));
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        systemInstruction: systemMessage ? { parts: [{ text: systemMessage }] } : undefined,
        contents: contents.length > 0 ? contents : [{ role: "user", parts: [{ text: "Hello" }] }],
        generationConfig: { temperature: 0.6, maxOutputTokens: maxTokens }
      })
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Gemini API Error (${res.status}): ${errText.slice(0, 300)}`);
    }
    const data = await res.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    const { reasoning, content } = splitThinkAndContent(rawText, "", { enableThinking });
    if (onProgress) onProgress({ reasoning, content });
    if (!content) throw new Error("Gemini API returned empty content");
    if (options.returnFullMessage) {
      return { role: "assistant", content: content.trim(), reasoning: reasoning.trim(), tool_calls: null };
    }
    return content.trim();
  }

  // Provider: Anthropic
  if (provider === "anthropic") {
    const anthropicBase = baseUrl.includes("anthropic.com") ? baseUrl : "https://api.anthropic.com/v1";
    const url = anthropicBase.endsWith("/messages") ? anthropicBase : `${anthropicBase}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      signal,
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: systemMessage,
        messages: nonSystemMessages.map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content || ""
        }))
      })
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Anthropic API Error (${res.status}): ${errText.slice(0, 300)}`);
    }
    const data = await res.json();
    const rawText = data?.content?.map((c) => c.text || "").join("") || "";
    const { reasoning, content } = splitThinkAndContent(rawText, "", { enableThinking });
    if (onProgress) onProgress({ reasoning, content });
    if (!content) throw new Error("Anthropic API returned empty content");
    if (options.returnFullMessage) {
      return { role: "assistant", content: content.trim(), reasoning: reasoning.trim(), tool_calls: null };
    }
    return content.trim();
  }

  // Provider: OpenAI-compatible
  const endpoint = baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const useStream = Boolean(options.stream ?? true);
  const isLocalEndpoint = isKeylessAllowed(baseUrl, provider);

  return callOpenAiWithRetries({
    endpoint,
    headers,
    model,
    messages,
    maxTokens,
    enableThinking,
    useStream,
    tools: options.tools,
    isLocalEndpoint,
    signal,
    onProgress,
    options
  });
}

/**
 * Convenience wrapper for single system + user prompt completion.
 */
export async function callLLM(llmConfig, systemPrompt, userPrompt, options = {}) {
  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  if (userPrompt) messages.push({ role: "user", content: userPrompt });
  return callLLMMessages(llmConfig, messages, options);
}

/**
 * Fetch available model IDs from configured LLM endpoint.
 */
export async function fetchModels(llmConfig) {
  const provider = (llmConfig?.provider || "openai").toLowerCase();
  const apiKey = (llmConfig?.apiKey || "").trim();
  let baseUrl = (llmConfig?.baseUrl || "https://api.openai.com/v1").trim().replace(/\/+$/, "");

  if (provider === "gemini") {
    if (!apiKey) throw new Error("Please configure Gemini API Key first");
    const geminiBase = baseUrl.includes("generativelanguage.googleapis.com")
      ? baseUrl
      : "https://generativelanguage.googleapis.com/v1beta";
    const res = await fetch(`${geminiBase}/models?key=${encodeURIComponent(apiKey)}`);
    if (!res.ok) {
      throw new Error(`Gemini Models Error (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    const data = await res.json();
    return (data?.models || [])
      .map((m) => String(m.name || "").replace(/^models\//, ""))
      .filter(Boolean);
  }

  const modelsUrl = baseUrl.endsWith("/chat/completions")
    ? baseUrl.replace(/\/chat\/completions$/, "/models")
    : baseUrl.endsWith("/models")
      ? baseUrl
      : `${baseUrl}/models`;

  const headers = { Accept: "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  try {
    const res = await fetch(modelsUrl, { method: "GET", headers, signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      const arr = Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.models)
          ? data.models
          : Array.isArray(data)
            ? data
            : [];
      const ids = arr.map((item) => item?.id || item?.name || item?.model || "").filter(Boolean);
      if (ids.length > 0) return ids;
    }
  } catch (err) {
    if (!isKeylessAllowed(baseUrl, provider)) {
      throw new Error(`Failed to fetch models: ${err?.message || err}`);
    }
  }

  try {
    const origin = new URL(baseUrl).origin;
    const tagRes = await fetch(`${origin}/api/tags`, { signal: AbortSignal.timeout(3500) });
    if (tagRes.ok) {
      const tagData = await tagRes.json();
      const names = (tagData?.models || []).map((m) => m?.name || m?.model || "").filter(Boolean);
      if (names.length > 0) return names;
    }
  } catch {}

  throw new Error(`Could not retrieve model list from ${modelsUrl}`);
}
