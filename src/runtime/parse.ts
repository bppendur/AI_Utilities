import type { Finding, ReviewResult, Severity } from "./types.js";

const SEVERITIES: Severity[] = ["critical", "major", "minor", "nit"];

/** Pull the first balanced top-level JSON object out of arbitrary model text. */
function extractJsonObject(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const haystack = fenced?.[1] ?? raw;
  const start = haystack.indexOf("{");
  if (start === -1) throw new Error("Runtime returned no JSON object");
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
  throw new Error("Runtime returned no JSON object (unbalanced braces)");
}

function normaliseSeverity(value: unknown): Severity {
  const lowered = String(value ?? "").toLowerCase();
  return (SEVERITIES as string[]).includes(lowered) ? (lowered as Severity) : "minor";
}

function stripZeroWidthSpaces(s: string): string {
  return s.replace(/​/g, "");
}

function normaliseFinding(raw: unknown): Finding | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const file = stripZeroWidthSpaces(typeof r.file === "string" ? r.file.trim() : "");
  const line = Number.parseInt(String(r.line ?? ""), 10);
  const body = stripZeroWidthSpaces(typeof r.body === "string" ? r.body.trim() : "");
  if (!file || !body || Number.isNaN(line) || line < 1) return null;
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
