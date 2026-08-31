import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "./config/load.js";
import { resolveRepos, type ResolvedRepo } from "./config/schema.js";
import { GitHubClient } from "./github/client.js";
import { postReview } from "./github/post-review.js";
import { createLogger, errorMessage } from "./logger.js";
import { pollOnce, type PollDeps, type PollSummary } from "./poller/poll.js";
import { runReview } from "./review/run-review.js";
import { DEFAULT_TEMPLATE_PATH, loadTemplate } from "./runtime/prompt.js";
import { createRuntime } from "./runtime/index.js";
import { StateStore } from "./state/store.js";
import { createWorkspace } from "./workspace/checkout.js";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required but not set (check your .env file)`);
  return value;
}

/**
 * Parses a `--pr` CLI argument into a PR number, rejecting anything that
 * isn't entirely digits. `Number.parseInt` alone would silently accept
 * "12abc" as 12 (it stops at the first non-digit rather than rejecting the
 * whole string), so the shape is checked first.
 */
export function parsePrNumber(raw: string): number {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`--pr must be a number, got: ${raw}`);
  }
  return Number.parseInt(trimmed, 10);
}

/**
 * Removes everything directly under `root` and reports how many entries
 * were removed. Nothing under `WORKSPACE_ROOT` is ever needed across a
 * restart (each entry is a scratch clone for one already-completed or
 * in-flight review), so a crash, `SIGKILL`, or unclean restart otherwise
 * leaves full clones behind forever with nothing ever sweeping them. A
 * missing root (nothing has ever run yet) is not an error — just nothing to
 * sweep.
 */
export async function sweepWorkspaceRoot(root: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return 0;
  }
  await Promise.all(entries.map((entry) => rm(join(root, entry), { recursive: true, force: true })));
  return entries.length;
}

export async function buildDeps(): Promise<{ repos: ResolvedRepo[]; deps: PollDeps; intervalMs: number }> {
  const configPath = process.env.CONFIG_PATH ?? "./config/repos.yaml";
  const statePath = process.env.STATE_PATH ?? "./state/state.json";
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? "./workspaces";
  const token = requireEnv("GITHUB_TOKEN");
  requireEnv("ANTHROPIC_API_KEY");

  const logger = createLogger("agent");
  const swept = await sweepWorkspaceRoot(workspaceRoot);
  if (swept > 0) {
    logger.info(
      `Swept ${swept} leftover workspace ${swept === 1 ? "entry" : "entries"} from ${workspaceRoot} on startup`,
    );
  }

  const config = await loadConfig(configPath);
  const deps: PollDeps = {
    github: GitHubClient.fromToken(token),
    runtime: createRuntime(config.runtime),
    state: await StateStore.open(statePath),
    logger,
    template: await loadTemplate(DEFAULT_TEMPLATE_PATH),
    token,
    workspaceRoot,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    createWorkspace,
    postReview,
    triggerPhrase: config.triggerPhrase,
    runReview,
  };
  return {
    repos: resolveRepos(config),
    deps,
    intervalMs: config.pollIntervalMinutes * 60 * 1000,
  };
}

export interface RunLoopOptions {
  intervalMs: number;
  signal: AbortSignal;
  poll?: (repos: ResolvedRepo[], deps: PollDeps) => Promise<PollSummary>;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    // Removing the listener on the normal (non-aborted) path, not just in
    // onAbort, is what prevents unbounded listener growth: `signal` is the
    // same AbortSignal for the daemon's entire lifetime, so a listener left
    // behind after every cycle that resolves via the timer (the common
    // case) accumulates forever and eventually trips Node's
    // MaxListenersExceededWarning. Do not "simplify" this away.
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runLoop(
  deps: PollDeps,
  repos: ResolvedRepo[],
  options: RunLoopOptions,
): Promise<void> {
  const poll = options.poll ?? pollOnce;
  while (!options.signal.aborted) {
    try {
      const summary = await poll(repos, deps);
      deps.logger.info("Poll cycle complete", { ...summary });
    } catch (error) {
      // A bad cycle must never kill the service.
      deps.logger.error(`Poll cycle failed: ${errorMessage(error)}`);
    }
    if (options.signal.aborted) break;
    await sleep(options.intervalMs, options.signal);
  }
}

export function buildProgram(): Command {
  const program = new Command();
  program.name("pr-review-agent").description("Automated GitHub PR reviews driven by Claude");

  program
    .command("run")
    .description("Run the polling service continuously")
    .action(async () => {
      const { repos, deps, intervalMs } = await buildDeps();
      const controller = new AbortController();
      for (const sig of ["SIGINT", "SIGTERM"] as const) {
        process.on(sig, () => {
          deps.logger.info(`Received ${sig}, shutting down after the current cycle`);
          controller.abort();
        });
      }
      deps.logger.info(
        `Watching ${repos.length} repo(s) every ${intervalMs / 60000} minute(s) using runtime ${deps.runtime.name}`,
      );
      await runLoop(deps, repos, { intervalMs, signal: controller.signal });
    });

  program
    .command("poll-once")
    .description("Run a single poll cycle and exit")
    .action(async () => {
      const { repos, deps } = await buildDeps();
      const summary = await pollOnce(repos, deps);
      deps.logger.info("Poll cycle complete", { ...summary });
    });

  program
    .command("review")
    .description("Review one pull request now, bypassing the configured filter")
    .requiredOption("--repo <owner/name>", "repository to review in")
    .requiredOption("--pr <number>", "pull request number")
    .action(async (opts: { repo: string; pr: string }) => {
      const prNumber = parsePrNumber(opts.pr);
      const { repos, deps } = await buildDeps();
      const repo = repos.find((r) => r.fullName === opts.repo);
      if (!repo) {
        throw new Error(
          `Repo ${opts.repo} is not in the config. Configured repos: ${repos.map((r) => r.fullName).join(", ")}`,
        );
      }
      const outcome = await runReview({ repo, prNumber, trigger: "manual", deps });
      deps.logger.info("Review complete", { ...outcome });
    });

  return program;
}
