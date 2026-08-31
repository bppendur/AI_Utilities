import { describe, expect, it } from "vitest";
import { parseReviewResult } from "../../src/runtime/parse.js";

describe("parseReviewResult", () => {
  it("parses a bare JSON object", () => {
    const out = parseReviewResult('{"summary":"ok","findings":[]}');
    expect(out).toEqual({ summary: "ok", findings: [] });
  });

  it("extracts JSON from a fenced code block", () => {
    const raw = 'Here you go:\n```json\n{"summary":"ok","findings":[]}\n```\nThanks!';
    expect(parseReviewResult(raw).summary).toBe("ok");
  });

  it("extracts JSON when the model adds prose around it", () => {
    const raw = 'Sure.\n{"summary":"ok","findings":[]}\nLet me know.';
    expect(parseReviewResult(raw).summary).toBe("ok");
  });

  it("normalises findings and coerces string line numbers", () => {
    const raw = JSON.stringify({
      summary: "one issue",
      findings: [{ file: "src/a.ts", line: "12", severity: "MAJOR", body: "bad" }],
    });
    expect(parseReviewResult(raw).findings[0]).toEqual({
      file: "src/a.ts", line: 12, severity: "major", body: "bad",
    });
  });

  it("drops findings missing a usable file or line rather than posting garbage", () => {
    const raw = JSON.stringify({
      summary: "s",
      findings: [
        { file: "", line: 1, severity: "major", body: "b" },
        { file: "src/a.ts", line: 0, severity: "major", body: "b" },
        { file: "src/a.ts", line: 5, severity: "major", body: "" },
        { file: "src/ok.ts", line: 5, severity: "major", body: "keep" },
      ],
    });
    const out = parseReviewResult(raw);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]!.file).toBe("src/ok.ts");
  });

  it("defaults an unrecognised severity to minor", () => {
    const raw = JSON.stringify({
      summary: "s",
      findings: [{ file: "a.ts", line: 1, severity: "blocker", body: "b" }],
    });
    expect(parseReviewResult(raw).findings[0]!.severity).toBe("minor");
  });

  it("throws a clear error when there is no JSON at all", () => {
    expect(() => parseReviewResult("I could not review this.")).toThrow(/no JSON object/i);
  });

  it("throws when the JSON has no summary", () => {
    expect(() => parseReviewResult('{"findings":[]}')).toThrow(/summary/);
  });

  it("strips U+200B zero-width spaces from body, file, and summary", () => {
    const raw = JSON.stringify({
      summary: "ok​summary",
      findings: [
        { file: "src​/a.ts", line: 1, severity: "major", body: "</div>​ invalid" },
      ],
    });
    const out = parseReviewResult(raw);
    expect(out.summary).toBe("oksummary");
    expect(out.findings[0]!.file).toBe("src/a.ts");
    expect(out.findings[0]!.body).toBe("</div> invalid");
  });
});
