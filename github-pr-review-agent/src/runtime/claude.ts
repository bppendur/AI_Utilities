import { execa } from "execa";
import { parseReviewResult } from "./parse.js";
import type { ReviewResult, ReviewRuntime, RuntimeInput } from "./types.js";

/**
 * Read-only tool surface AND a zero-configuration-from-checkout invariant.
 * Both halves are required — neither alone is sufficient:
 *
 * 1. The agent can read files (Read/Grep/Glob) but cannot execute commands
 *    at all — Bash is blanket-denied below, not allow-listed to "safe"
 *    subcommands. Several git subcommands accept an `--output=<file>` (or
 *    equivalent) flag that writes arbitrary files, so a prefix-wildcard
 *    allow-list like `Bash(git diff:*)` is an arbitrary-file-write primitive
 *    reachable from attacker-controlled PR content, not a read-only
 *    boundary. Do not reintroduce any `Bash(...)` entry here without
 *    re-deriving that every argument spelling that pattern admits is
 *    actually non-mutating — git's flag surface is too large to enumerate
 *    safely.
 *
 * 2. `--allowed-tools`/`--disallowed-tools` gate *tool calls the model
 *    decides to make* — they do NOT gate hooks. Claude Code runs with `cwd`
 *    set to the PR checkout, which is attacker-controlled: a PR that commits
 *    a `.claude/settings.json` (project or local settings) or a `.mcp.json`
 *    into its branch gets those loaded from the checkout the moment the CLI
 *    starts there. Hooks defined in settings are plain shell commands the
 *    CLI process itself executes at lifecycle points, and MCP servers from
 *    `.mcp.json` can be arbitrary executables — neither is a "tool call" the
 *    model makes, so neither is touched by the allow/disallow lists above.
 *    That is a full RCE path straight through the Bash denial in (1), and
 *    `buildClaudeArgs` below closes it by refusing to load ANY configuration
 *    from the workspace: `--bare` skips hooks/plugins/auto-memory/CLAUDE.md
 *    discovery, `--setting-sources user` additionally guarantees project and
 *    local `settings.json` (where hooks actually live) are never read
 *    regardless of `--bare`'s exact internals, and `--strict-mcp-config`
 *    guarantees zero MCP servers load since we never pass `--mcp-config`
 *    (this is required separately from the other two: neither `--bare`'s nor
 *    `--setting-sources`' documented scope mentions `.mcp.json` at all).
 *    A future maintainer who drops any one of these three flags reopens
 *    command execution from PR content — do not remove them without
 *    re-verifying against `claude --help` that the replacement covers hooks,
 *    project/local settings, and MCP auto-discovery.
 *
 * Residual risk this cannot close: the reviewed repository's own source is
 * still read by the model as data (that's the point of the review), and the
 * `claude` process still runs with the review service's own account
 * privileges. These flags close CLI-config-driven code execution from the
 * checkout; they are not a sandbox.
 */
export const ALLOWED_TOOLS = ["Read", "Grep", "Glob"];

export const DISALLOWED_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
];

/**
 * The prompt is deliberately NOT one of these argv elements — it goes on
 * stdin instead (see `createClaudeRuntime` below). `-p` with no following
 * argument reads the prompt from stdin; verified empirically against the
 * installed CLI (`echo "say hi" | claude -p --output-format json`), which
 * parsed the flags and returned a normal JSON result. Two independent
 * reasons this must stay stdin, not argv, ever again:
 *   1. Windows caps a whole command line at ~32,767 chars and Linux caps a
 *      single argv element at 131,072 bytes; `MAX_DIFF_CHARS` in
 *      `src/github/client.ts` alone allows a 200,000-char diff into the
 *      rendered prompt, which blew both limits (`ENAMETOOLONG`) before this
 *      fix — ordinary PRs could not be reviewed at all.
 *   2. argv is visible in the host process table (`ps`/`/proc/<pid>/cmdline`
 *      on Linux, Task Manager/WMI on Windows) and gets echoed into execa's
 *      own error messages on a non-zero exit. The prompt embeds
 *      attacker-controlled PR content (title, body, diff) — keeping it off
 *      argv keeps that content out of both.
 */
export function buildClaudeArgs(): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--allowed-tools",
    ALLOWED_TOOLS.join(","),
    "--disallowed-tools",
    DISALLOWED_TOOLS.join(","),
    "--bare",
    "--setting-sources",
    "user",
    "--strict-mcp-config",
  ];
}

export type ExecFn = (
  file: string,
  args: string[],
  opts: { cwd: string; timeout: number; input: string; env: Record<string, string | undefined> },
) => Promise<{ stdout: string }>;

const defaultExec: ExecFn = (file, args, opts) => execa(file, args, opts);

/**
 * The minimal env the `claude` CLI is spawned with — deliberately NOT the
 * full inherited parent environment. `execa` inherits the whole parent env
 * by default, which would otherwise put `GITHUB_TOKEN` into the environment
 * of a process whose `cwd` is an attacker-controlled PR checkout. Only what
 * the CLI needs to start is passed through: `ANTHROPIC_API_KEY` for auth,
 * `PATH` to resolve `node`/other binaries, and `HOME`/`USERPROFILE` (both,
 * since Windows uses `USERPROFILE` and POSIX uses `HOME`) for its config
 * directory. `GITHUB_TOKEN` is never included.
 */
function buildRuntimeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["ANTHROPIC_API_KEY", "PATH", "HOME", "USERPROFILE"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

/** `claude -p --output-format json` wraps the answer in `{ result: "..." }`. */
function unwrapEnvelope(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as { result?: unknown };
    if (typeof parsed.result === "string") return parsed.result;
  } catch {
    // Not the envelope — treat stdout as the raw answer.
  }
  return stdout;
}

export function createClaudeRuntime(exec: ExecFn = defaultExec): ReviewRuntime {
  return {
    name: "claude",
    async review(input: RuntimeInput): Promise<ReviewResult> {
      if (!process.env.ANTHROPIC_API_KEY && exec === defaultExec) {
        throw new Error(
          "ANTHROPIC_API_KEY is required: this service runs unattended and cannot use an interactive Claude login",
        );
      }
      const { stdout } = await exec("claude", buildClaudeArgs(), {
        cwd: input.workspaceDir,
        timeout: input.timeoutMs,
        input: input.prompt,
        env: buildRuntimeEnv(),
      });
      return parseReviewResult(unwrapEnvelope(stdout));
    },
  };
}
