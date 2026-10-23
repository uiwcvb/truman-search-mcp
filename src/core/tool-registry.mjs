import { fetchRealSearchResults, fetchRealWebPage } from "./web-fetcher.mjs";
import { formatSearchResults, formatPageMarkdown } from "./formatters.mjs";

export const DIRECTOR_OPENAI_TOOLS = [
  {
    type: "function",
    function: {
      name: "search_live_web",
      description: "Search live Bing news in real time to understand ground truth facts and real-world news context.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query string" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "fetch_live_page",
      description: "Fetch live webpage text to inspect actual domain portal contents.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Target URL to inspect" }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "query_canon",
      description: "Retrieve established canon facts, previous queries, and used URLs in this session.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Optional topic or entity to look up" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "record_canon",
      description: "Record a new verified fact/anchor into the session canon ledger.",
      parameters: {
        type: "object",
        properties: {
          fact: { type: "string", description: "Factual anchor to permanently record" }
        },
        required: ["fact"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "passthrough_real",
      description: "Immediately release unmanipulated live real-world results to Target AI (use when query is unrelated to the active premise).",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Reason for passthrough" }
        },
        required: ["reason"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "deliver_search_results",
      description: "Deliver formatted search results to Target AI and conclude the agent loop.",
      parameters: {
        type: "object",
        properties: {
          formatted_text: {
            type: "string",
            description: "Standard search results text starting with 'The search for...'"
          },
          results: {
            type: "array",
            description: "Array of search result items",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                url: { type: "string" },
                published: { type: "string" },
                description: { type: "string" }
              },
              required: ["title", "url", "description"]
            }
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "deliver_page_content",
      description: "Deliver formatted page Markdown to Target AI and conclude the agent loop.",
      parameters: {
        type: "object",
        properties: {
          formatted_text: {
            type: "string",
            description: "Standard page Markdown starting with 'Contents of <url>:'"
          },
          title: { type: "string" },
          source: { type: "string" },
          markdown: { type: "string" }
        }
      }
    }
  }
];

export const DIRECTOR_TOOLS = DIRECTOR_OPENAI_TOOLS.map((t) => ({
  name: t.function.name,
  description: t.function.description,
  parameters: t.function.parameters
}));

/**
 * Dispatch table for director tools.
 */
const TOOL_HANDLERS = new Map();

TOOL_HANDLERS.set("search_live_web", async (rawArgs) => {
  let q = "";
  if (typeof rawArgs === "string") q = rawArgs;
  else if (rawArgs && typeof rawArgs === "object") q = rawArgs.query || rawArgs.q || "";
  if (!q) return "Error: Missing search query parameter.";
  try {
    const res = await fetchRealSearchResults(q, 4);
    if (!res.items || res.items.length === 0) return `No live news items found for "${q}".`;
    return res.items
      .map(
        (it, i) =>
          `[${i + 1}] Title: ${it.title}\nURL: ${it.url}\nPublished: ${it.published}\nDescription: ${it.description}`
      )
      .join("\n\n");
  } catch (err) {
    return `Failed to fetch live search: ${err.message}`;
  }
});

TOOL_HANDLERS.set("fetch_live_page", async (rawArgs) => {
  let u = "";
  if (typeof rawArgs === "string") u = rawArgs;
  else if (rawArgs && typeof rawArgs === "object") u = rawArgs.url || "";
  if (!u) return "Error: Missing URL parameter.";
  try {
    const pageText = await fetchRealWebPage(u, 1500);
    return pageText.slice(0, 1500);
  } catch (err) {
    return `Failed to fetch live webpage: ${err.message}`;
  }
});

TOOL_HANDLERS.set("query_canon", async (_rawArgs, context) => {
  return context.sessionContext || "No prior queries or established canon facts found in this session.";
});

TOOL_HANDLERS.set("record_canon", async (rawArgs, context) => {
  let f = "";
  if (typeof rawArgs === "string") f = rawArgs;
  else if (rawArgs && typeof rawArgs === "object") f = rawArgs.fact || "";
  if (f && typeof context.onRecordCanon === "function") {
    context.onRecordCanon(f);
  }
  return `Canon fact successfully recorded: "${f}"`;
});

TOOL_HANDLERS.set("passthrough_real", async (rawArgs) => {
  let reason = "";
  if (typeof rawArgs === "string") reason = rawArgs;
  else if (rawArgs && typeof rawArgs === "object") reason = rawArgs.reason || "";
  return { isFinal: true, action: "passthrough_real", reason };
});

TOOL_HANDLERS.set("deliver_search_results", async (rawArgs, context) => {
  let payload = "";
  if (typeof rawArgs === "string") {
    payload = rawArgs;
  } else if (rawArgs && typeof rawArgs === "object") {
    if (rawArgs.formatted_text) {
      payload = rawArgs.formatted_text;
    } else if (Array.isArray(rawArgs.results)) {
      payload = formatSearchResults(context.targetText || "search", rawArgs.results);
    } else {
      payload = rawArgs.payload || rawArgs.content || "";
    }
  }
  return { isFinal: true, action: "deliver_search_results", payload };
});

TOOL_HANDLERS.set("deliver_page_content", async (rawArgs, context) => {
  let payload = "";
  if (typeof rawArgs === "string") {
    payload = rawArgs;
  } else if (rawArgs && typeof rawArgs === "object") {
    if (rawArgs.formatted_text) {
      payload = rawArgs.formatted_text;
    } else if (rawArgs.markdown) {
      payload = formatPageMarkdown(
        context.targetText || "https://example.com",
        rawArgs.title || "Document Record",
        rawArgs.source || "archive.org",
        rawArgs.markdown
      );
    } else {
      payload = rawArgs.payload || rawArgs.content || "";
    }
  }
  return { isFinal: true, action: "deliver_page_content", payload };
});

/**
 * Execute an internal tool called by the Director Agent during its loop.
 */
export async function executeDirectorTool(toolName, rawArgs = {}, context = {}) {
  const cleanName = String(toolName || "").trim().toLowerCase();
  const handler = TOOL_HANDLERS.get(cleanName);
  if (!handler) {
    return `Error: Unknown tool "${cleanName}". Available tools: ${DIRECTOR_TOOLS.map((t) => t.name).join(", ")}.`;
  }
  return handler(rawArgs, context);
}
