import { describe, expect, it, vi } from "vitest";
import { buildClaudeArgs, createClaudeRuntime } from "../../src/runtime/claude.js";
import { createRuntime } from "../../src/runtime/index.js";

const input = { prompt: "review this", workspaceDir: "/ws", timeoutMs: 60_000 };

describe("buildClaudeArgs", () => {
  it("runs headless with JSON output", () => {
    const args = buildClaudeArgs("hello");
    expect(args).toContain("-p");
    expect(args).toContain("hello");
    expect(args.join(" ")).toContain("--output-format json");
  });

  it("permits only read-only tools", () => {
    const joined = buildClaudeArgs("x").join(" ");
    expect(joined).toContain("--allowed-tools");
    expect(joined).toContain("Read");
    expect(joined).toContain("Grep");
    expect(joined).toContain("Glob");
  });

  it("explicitly blocks every mutating tool", () => {
    const joined = buildClaudeArgs("x").join(" ");
    for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      expect(joined).toContain(tool);
    }
    expect(joined).toContain("--disallowed-tools");
  });
});

describe("createClaudeRuntime", () => {
  it("unwraps the CLI JSON envelope and parses the review result", async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        type: "result",
        result: '{"summary":"looks fine","findings":[]}',
      }),
    });
    const runtime = createClaudeRuntime(exec);
    await expect(runtime.review(input)).resolves.toEqual({ summary: "looks fine", findings: [] });
  });

  it("runs the CLI in the workspace directory with the given timeout", async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ result: '{"summary":"s","findings":[]}' }),
    });
    await createClaudeRuntime(exec).review(input);
    expect(exec).toHaveBeenCalledWith(
      "claude",
      expect.any(Array),
      expect.objectContaining({ cwd: "/ws", timeout: 60_000 }),
    );
  });

  it("falls back to raw stdout when it is not the CLI envelope", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '{"summary":"raw","findings":[]}' });
    await expect(createClaudeRuntime(exec).review(input)).resolves.toMatchObject({
      summary: "raw",
    });
  });

  it("surfaces a CLI failure rather than returning an empty review", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("claude exited with 1"));
    await expect(createClaudeRuntime(exec).review(input)).rejects.toThrow(/claude/i);
  });
});

describe("createRuntime", () => {
  it("returns the claude runtime", () => {
    expect(createRuntime("claude").name).toBe("claude");
  });

  it("throws an actionable error for the unimplemented codex seam", () => {
    expect(() => createRuntime("codex")).toThrow(/codex.*not implemented/i);
  });
});
