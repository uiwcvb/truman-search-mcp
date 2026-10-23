import { decodeXmlEntities } from "./utils.mjs";
import { formatSearchResults } from "./formatters.mjs";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const JUNK_URL_PATTERN =
  /iciba\.com|dictionary\.cambridge\.org|merriam-webster\.com|youdao\.com|rili\.com\.cn|chinacalendar\.app|appinn\.com|adobe\.com|baike\.baidu\.com\/item\/(latest|2026|国际|足球)/i;

/**
 * Fetch real live web search results via Bing RSS.
 * Fast, keyless, resilient.
 */
export async function fetchRealSearchResults(query = "", count = 4) {
  const rawQuery = String(query || "world news").trim();
  const isChinese = /[\u4e00-\u9fff]/.test(rawQuery);
  const nowStr = new Date().toISOString().slice(0, 10);

  let cleanedQuery = rawQuery
    .replace(/\b(latest|recent|today|breaking|headlines|update|updates|october|november|december|2025|2026|18|19|20)\b/gi, " ")
    .replace(/(2025年|2026年|10月\d{0,2}日?|最新|近期|今日|最近|动态|消息|汇总)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleanedQuery || cleanedQuery.length < 2) {
    cleanedQuery = isChinese ? "国际新闻 环球 央视" : "Reuters AP BBC world news";
  }

  const qEncoded = encodeURIComponent(cleanedQuery);
  const qRawEncoded = encodeURIComponent(rawQuery);
  const enParam = isChinese ? "" : "&ensearch=1";

  const endpoints = [
    `https://cn.bing.com/search?q=${qEncoded}${enParam}&format=rss`,
    `https://cn.bing.com/search?q=${qRawEncoded}${enParam}&format=rss`
  ];

  const items = [];
  const seenUrls = new Set();

  const settled = await Promise.allSettled(
    endpoints.map(async (ep) => {
      const res = await fetch(ep, {
        headers: {
          "User-Agent": DEFAULT_USER_AGENT,
          Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8"
        },
        signal: AbortSignal.timeout(3000)
      });
      if (!res.ok) return "";
      return await res.text();
    })
  );

  for (const r of settled) {
    if (r.status !== "fulfilled" || !r.value || !r.value.includes("<item>")) continue;
    const xml = r.value;
    const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
    let m;
    while ((m = itemRegex.exec(xml)) !== null && items.length < Math.max(count, 6)) {
      const block = m[1];
      const title = decodeXmlEntities((block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "").trim();
      const link = decodeXmlEntities((block.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || "").trim();
      const desc = decodeXmlEntities((block.match(/<description>([\s\S]*?)<\/description>/i) || [])[1] || "")
        .replace(/<[^>]+>/g, "")
        .trim();
      const pubRaw = decodeXmlEntities((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1] || "").trim();
      let pubDate = nowStr;
      if (pubRaw) {
        const d = new Date(pubRaw);
        if (!Number.isNaN(d.getTime())) {
          pubDate = d.toISOString().slice(0, 10);
        }
      }
      if (title && link && desc && !JUNK_URL_PATTERN.test(link) && !seenUrls.has(link)) {
        seenUrls.add(link);
        items.push({ title, url: link, published: pubDate, description: desc });
      }
    }
  }

  const sliced = items.slice(0, Math.min(Math.max(Number(count) || 4, 1), 6));
  if (sliced.length === 0) {
    throw new Error("Live search returned no clean news items for this query.");
  }

  const formatted = formatSearchResults(rawQuery, sliced);
  return { items: sliced, formatted };
}

/**
 * Fetch a real web page and extract clean Markdown text.
 */
export async function fetchRealWebPage(url = "", maxLength = 1500) {
  const nowStr = new Date().toISOString().slice(0, 10);
  let domain = "web";
  try {
    domain = new URL(url).hostname;
  } catch {}

  const res = await fetch(url, {
    headers: { "User-Agent": DEFAULT_USER_AGENT },
    signal: AbortSignal.timeout(4000)
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} when fetching ${url}`);
  }

  const html = await res.text();
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeXmlEntities(titleMatch[1]).replace(/\s+/g, " ").trim() : url;

  const bodyText = decodeXmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
      .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
      .replace(/<\/(p|div|h[1-6]|li|tr|article|section)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 35)
    .join("\n\n")
    .slice(0, Math.max(Number(maxLength) || 1500, 400));

  return `Contents of ${url}:
# ${title}
*Source: ${domain} | Published: ${nowStr}*

${bodyText || "Page content extracted."}`;
}
