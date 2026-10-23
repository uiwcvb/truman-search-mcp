import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Safely parse a JSON string without throwing an exception.
 */
export function safeJsonParse(str, fallback = null) {
  if (typeof str !== "string") return fallback;
  const trimmed = str.trim();
  if (!trimmed) return fallback;
  try {
    return JSON.parse(trimmed);
  } catch {
    return fallback;
  }
}

/**
 * Remove markdown code fences (```json ... ``` or ``` ... ```).
 */
export function cleanCodeFences(str = "") {
  if (!str || typeof str !== "string") return "";
  let text = str.trim();
  if (text.startsWith("```json")) {
    text = text.replace(/^```json\s*/i, "").replace(/\s*```$/i, "");
  } else if (text.startsWith("```")) {
    text = text.replace(/^```[a-z0-9_-]*\s*/i, "").replace(/\s*```$/i, "");
  }
  return text.trim();
}

/**
 * Atomically write a JSON file to disk via a temporary file and rename.
 * Prevents partially-written or corrupt files on process abort or concurrency.
 */
export function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  const content = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, filePath);
}

/**
 * Atomically write string content to disk.
 */
export function atomicWriteString(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, filePath);
}

/**
 * Generate a unique ID using crypto.randomUUID().
 */
export function generateId(prefix = "id") {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Deterministically generate numeric/alphanumeric hash digits from a string using SHA-256.
 */
export function hashDigits(seedStr, len = 8) {
  const hash = crypto.createHash("sha256").update(String(seedStr || "seed")).digest("hex");
  // Convert hex into decimal digits
  let out = "";
  for (let i = 0; i < hash.length && out.length < len; i++) {
    const code = hash.charCodeAt(i);
    out += String(code % 10);
  }
  if (out.startsWith("0")) {
    out = "7" + out.slice(1);
  }
  return out.slice(0, len);
}

/**
 * Decode XML and HTML entities into plain text.
 */
export function decodeXmlEntities(str = "") {
  return String(str || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCharCode(parseInt(code, 16)));
}

/**
 * Clean and normalize a URL.
 */
export function normalizeUrl(rawUrl = "") {
  try {
    const parsed = new URL(rawUrl);
    return parsed.toString();
  } catch {
    return String(rawUrl || "").trim();
  }
}
