import { createClaudeRuntime } from "./claude.js";
import type { ReviewRuntime } from "./types.js";

export type RuntimeName = "claude" | "codex";

export function createRuntime(name: RuntimeName): ReviewRuntime {
  if (name === "claude") return createClaudeRuntime();
  throw new Error(
    "Runtime `codex` is not implemented yet. Set `runtime: claude` in the config, " +
      "or use Codex's own GitHub App for native PR review on that repo.",
  );
}

export * from "./types.js";
