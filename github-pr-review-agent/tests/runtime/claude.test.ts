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
  it("runs headless with JSON output, prompt on stdin (not argv)", () => {
    const args = buildClaudeArgs();
    expect(args).toContain("-p");
    expect(args.join(" ")).toContain("--output-format json");
    // Regression guard for the ENAMETOOLONG bug: the prompt must never be an
    // argv element. `-p` must not be immediately followed by prompt text —
    // the next element must be another flag.
    expect(args[args.indexOf("-p") + 1]?.startsWith("--")).toBe(true);
  });

  it("permits only read-only tools", () => {
    const joined = buildClaudeArgs().join(" ");
    expect(joined).toContain("--allowed-tools");
    expect(joined).toContain("Read");
    expect(joined).toContain("Grep");
    expect(joined).toContain("Glob");
  });

  it("explicitly blocks every mutating tool", () => {
    const joined = buildClaudeArgs().join(" ");
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
    const args = buildClaudeArgs();
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

  it("runs the CLI in the workspace directory with the given timeout, prompt on stdin", async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ result: '{"summary":"s","findings":[]}' }),
    });
    await createClaudeRuntime(exec).review(input);
    expect(exec).toHaveBeenCalledWith(
      "claude",
      expect.any(Array),
      expect.objectContaining({ cwd: "/ws", timeout: 60_000, input: "review this" }),
    );
    // The prompt must never appear as an argv element (see buildClaudeArgs).
    const args = (exec.mock.calls[0]![1] as string[]) ?? [];
    expect(args).not.toContain("review this");
  });

  it("spawns the CLI with a minimal, explicit env that excludes GITHUB_TOKEN", async () => {
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "ghp_shouldNotLeak";
    try {
      const exec = vi.fn().mockResolvedValue({
        stdout: JSON.stringify({ result: '{"summary":"s","findings":[]}' }),
      });
      await createClaudeRuntime(exec).review(input);
      const opts = exec.mock.calls[0]![2] as { env: Record<string, string> };
      expect(opts.env.GITHUB_TOKEN).toBeUndefined();
      expect(Object.values(opts.env)).not.toContain("ghp_shouldNotLeak");
    } finally {
      if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = originalToken;
    }
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

describe("prompt delivery via stdin (real process)", () => {
  // The point of this test: a fake `exec` (every other test in this file)
  // cannot catch an argv-length regression because it never actually spawns
  // anything. This one spawns a REAL child process (plain `node`, not
  // `claude` — no credentials needed, no network, fast) with the exact
  // mechanism `defaultExec` in claude.ts uses (execa's `input` option) and a
  // prompt well over both the Windows ~32,767-char command-line cap and the
  // Linux 131,072-byte single-argv-element cap, and proves the full prompt
  // arrives on stdin rather than argv.
  it("delivers a 200,000+ char prompt to a real child process via stdin, not argv", async () => {
    const { execa } = await import("execa");
    const bigPrompt = "x".repeat(200_000);
    const script =
      "let n=0;process.stdin.on('data',c=>{n+=c.length});" +
      "process.stdin.on('end',()=>{process.stdout.write(String(n))});";
    const { stdout } = await execa("node", ["-e", script], { input: bigPrompt });
    expect(Number(stdout)).toBe(bigPrompt.length);
  }, 15_000);
});

describe("createRuntime", () => {
  it("returns the claude runtime", () => {
    expect(createRuntime("claude").name).toBe("claude");
  });

  it("throws an actionable error for the unimplemented codex seam", () => {
    expect(() => createRuntime("codex")).toThrow(/codex.*not implemented/i);
  });
});
