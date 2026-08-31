import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALLOWED_TOOLS,
  DISALLOWED_TOOLS,
  buildClaudeArgs,
  createClaudeRuntime,
} from "../../src/runtime/claude.js";
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

  it("grants no Bash access at all — not even to read-only git/gh subcommands", () => {
    // Regression guard: `git diff/show/log --output=<file>` writes arbitrary
    // files, so a prefix-wildcard Bash(git ...:*) grant is a file-write
    // primitive, not a read-only boundary. Bash must be blanket-denied.
    expect(ALLOWED_TOOLS.some((tool) => tool.startsWith("Bash"))).toBe(false);
    expect(DISALLOWED_TOOLS).toContain("Bash");
  });

  it("loads no configuration from the attacker-controlled checkout", () => {
    // Regression guard: --allowed-tools/--disallowed-tools gate tool calls
    // the model makes, but NOT hooks or MCP servers. A PR that commits
    // .claude/settings.json or .mcp.json into its branch would otherwise get
    // those loaded the moment the CLI starts with cwd set to the checkout,
    // executing attacker-controlled shell commands outside the tool-gating
    // boundary entirely. These three flags must all be present, or that RCE
    // path reopens:
    const args = buildClaudeArgs("x");
    expect(args).toContain("--bare");
    // Index-based (not substring) so removing --setting-sources or changing
    // its value away from "user" fails this test even though the string
    // "user" might otherwise appear elsewhere.
    const settingSourcesIndex = args.indexOf("--setting-sources");
    expect(settingSourcesIndex).toBeGreaterThan(-1);
    expect(args[settingSourcesIndex + 1]).toBe("user");
    expect(args).toContain("--strict-mcp-config");
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

  describe("ANTHROPIC_API_KEY guard", () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;

    afterEach(() => {
      if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalKey;
    });

    it("fails fast without spawning a subprocess when no key is set and no exec is injected", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      // No exec argument: createClaudeRuntime() falls back to the real,
      // execa-backed default — so this must reject before ever awaiting it.
      await expect(createClaudeRuntime().review(input)).rejects.toThrow(/ANTHROPIC_API_KEY/);
    });
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
