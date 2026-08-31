import { execa } from "execa";
import { parseReviewResult } from "./parse.js";
import type { ReviewResult, ReviewRuntime, RuntimeInput } from "./types.js";

/**
 * Read-only tool surface. Bash is scoped to non-mutating git/gh subcommands
 * only — the agent must be incapable of editing, committing or pushing.
 */
export const ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git status:*)",
  "Bash(git blame:*)",
  "Bash(gh pr view:*)",
  "Bash(gh pr diff:*)",
];

export const DISALLOWED_TOOLS = [
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
];

export function buildClaudeArgs(prompt: string): string[] {
  return [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--allowed-tools",
    ALLOWED_TOOLS.join(","),
    "--disallowed-tools",
    DISALLOWED_TOOLS.join(","),
  ];
}

export type ExecFn = (
  file: string,
  args: string[],
  opts: { cwd: string; timeout: number },
) => Promise<{ stdout: string }>;

const defaultExec: ExecFn = (file, args, opts) => execa(file, args, opts);

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
      const { stdout } = await exec("claude", buildClaudeArgs(input.prompt), {
        cwd: input.workspaceDir,
        timeout: input.timeoutMs,
      });
      return parseReviewResult(unwrapEnvelope(stdout));
    },
  };
}
