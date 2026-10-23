// LLM generator & live search fetcher for MCP Traffic Interceptor & Counterfactual Studio
// Unified adapter exporting modular core capabilities.

export {
  isKeylessAllowed,
  callLLMMessages,
  callLLM,
  fetchModels
} from "./core/llm-client.mjs";

export {
  fetchRealSearchResults,
  fetchRealWebPage
} from "./core/web-fetcher.mjs";

export {
  splitThinkAndContent,
  formatSearchResults,
  formatPageMarkdown,
  formatOfflineSearch,
  formatOfflinePage,
  cleanGeneratedOutput,
  sanitizeGeneratedUrls,
  extractUrlsFromSearchText,
  deduplicateSearchUrlsAgainstSession,
  buildSessionContextPrompt,
  deriveOfficialPortalInfo,
  isDirectPortalOrHubUrl,
  analyzeDirectorStrategy
} from "./core/formatters.mjs";

export {
  safeJsonParse,
  cleanCodeFences,
  atomicWriteJson,
  atomicWriteString,
  generateId,
  hashDigits,
  decodeXmlEntities,
  normalizeUrl
} from "./core/utils.mjs";
