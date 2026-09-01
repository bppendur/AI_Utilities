import type { Finding, ReviewResult, Severity } from "./types.js";

const SEVERITIES: Severity[] = ["critical", "major", "minor", "nit"];

/** Extract a balanced JSON object from a string, handling string escapes. */
function scanBalancedBraces(haystack: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < haystack.length; i += 1) {
    const ch = haystack[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return haystack.slice(start, i + 1);
    }
  }
  return null;
}

/** Extract all JSON-like objects from a candidate string. */
function extractAllJsons(candidate: string): Array<{ json: string; hasSummary: boolean }> {
  const results: Array<{ json: string; hasSummary: boolean }> = [];
  let start = candidate.indexOf("{");
  while (start !== -1) {
    const balanced = scanBalancedBraces(candidate, start);
    if (balanced) {
      try {
        const parsed = JSON.parse(balanced);
        if (parsed && typeof parsed === "object") {
          const hasSummary = typeof parsed.summary === "string" && parsed.summary.trim().length > 0;
          results.push({ json: balanced, hasSummary });
        }
      } catch {
        // Not valid JSON, continue searching
      }
    }
    start = candidate.indexOf("{", start + 1);
  }
  return results;
}

/** Pull a valid JSON object out of arbitrary model text. Try all candidates. */
function extractJsonObject(raw: string): string {
  // Build list of candidates: contents of each fenced block, then raw text
  const candidates: string[] = [];
  for (const match of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    candidates.push(match[1]!);
  }
  candidates.push(raw);

  // Compute results for all candidates once
  const allResults: Array<{ jsons: Array<{ json: string; hasSummary: boolean }>; candidate: string }> = [];
  for (const candidate of candidates) {
    allResults.push({ jsons: extractAllJsons(candidate), candidate });
  }

  // First, look for one with a summary
  for (const result of allResults) {
    for (const item of result.jsons) {
      if (item.hasSummary) {
        return item.json;
      }
    }
  }

  // If we've exhausted all candidates without finding a summary,
  // go back and return the first JSON we found (even without summary)
  // so that parseReviewResult can give the proper error
  for (const result of allResults) {
    if (result.jsons.length > 0) {
      return result.jsons[0]!.json;
    }
  }

  throw new Error("Runtime returned no JSON object");
}

function normaliseSeverity(value: unknown): Severity {
  const lowered = String(value ?? "").toLowerCase();
  return (SEVERITIES as string[]).includes(lowered) ? (lowered as Severity) : "minor";
}


function stripZeroWidthSpaces(s: string): string {
  return s.replace(/\u200B/g, "");
}

function normaliseLineNumber(value: unknown): number | null {
  // Accept only JS numbers that are positive integers, or strings of pure digits
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= 1) return value;
    return null;
  }
  if (typeof value === "string") {
    if (/^\d+$/.test(value.trim())) {
      const num = Number.parseInt(value.trim(), 10);
      return num >= 1 ? num : null;
    }
  }
  return null;
}

function normaliseFinding(raw: unknown): Finding | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const file = stripZeroWidthSpaces(typeof r.file === "string" ? r.file.trim() : "");
  const line = normaliseLineNumber(r.line);
  const body = stripZeroWidthSpaces(typeof r.body === "string" ? r.body.trim() : "");
  if (!file || !body || line === null) return null;
  return { file, line, severity: normaliseSeverity(r.severity), body };
}

export function parseReviewResult(raw: string): ReviewResult {
  const parsed = JSON.parse(extractJsonObject(raw)) as Record<string, unknown>;
  const summary = stripZeroWidthSpaces(typeof parsed.summary === "string" ? parsed.summary.trim() : "");
  if (!summary) throw new Error("Runtime result is missing a non-empty `summary`");
  const findingsRaw = Array.isArray(parsed.findings) ? parsed.findings : [];
  const findings = findingsRaw
    .map(normaliseFinding)
    .filter((f): f is Finding => f !== null);
  return { summary, findings };
}
