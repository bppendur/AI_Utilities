import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";

export interface Workspace {
  dir: string;
  cleanup(): Promise<void>;
}

/**
 * Credential-free clone URL for `owner/name`. Authentication is supplied
 * separately via `buildAuthEnv`, so this URL is safe to pass as a process
 * argument (visible in `ps`/`/proc/<pid>/cmdline`) and safe for git to
 * persist in the scratch repo's `.git/config`.
 */
export function buildRemoteUrl(owner: string, name: string): string {
  return `https://github.com/${owner}/${name}.git`;
}

/**
 * Environment variables that authenticate git against github.com without
 * ever putting the token on the command line or in `.git/config` — the
 * same `http.extraheader`-via-env approach GitHub's own `actions/checkout`
 * uses. Git reads `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`
 * as an ephemeral, process-scoped config layer that is never written to
 * disk.
 */
export function buildAuthEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

const CREDENTIALED_URL = /https:\/\/[^@\s]+@/g;

/**
 * Strips basic-auth credentials from a git error's message before it is
 * rethrown, so a checkout failure never leaks the clone token to a caller
 * that logs the error directly (e.g. an un-redacting top-level
 * `console.error`). Redacts generically over the message text — rather
 * than only string-replacing the known `remote` value — so a URL git
 * echoes back in a slightly different form is still covered. The original
 * error is preserved as `cause` for debugging.
 */
export function sanitizeGitError(error: unknown, remote: string): Error {
  const original = error instanceof Error ? error : new Error(String(error));
  let message = original.message;
  if (message.includes(remote)) {
    message = message.split(remote).join(remote.replace(CREDENTIALED_URL, "https://***@"));
  }
  message = message.replace(CREDENTIALED_URL, "https://***@");
  return new Error(message, { cause: original });
}

export interface CreateWorkspaceFromRefOptions {
  remote: string;
  refs: string[];
  checkoutRef: string;
  rootDir: string;
  label: string;
  /**
   * Extra environment variables merged into every git invocation this call
   * makes (e.g. the `GIT_CONFIG_*` trio from `buildAuthEnv`). Omit for an
   * unauthenticated / local remote — behaviour is then unchanged from
   * passing no env at all.
   */
  env?: Record<string, string>;
}

/**
 * Shallow-fetches `refs` from `remote` into a fresh directory and checks out
 * `checkoutRef`. Kept separate from `createWorkspace` so it can be tested
 * against a local repo without touching GitHub.
 */
export async function createWorkspaceFromRef(
  opts: CreateWorkspaceFromRefOptions,
): Promise<Workspace> {
  await mkdir(opts.rootDir, { recursive: true });
  const dir = await mkdtemp(join(opts.rootDir, `${opts.label}-`));
  const env = { ...opts.env };
  const git = (args: string[]) => execa("git", ["-C", dir, ...args], { env });
  try {
    await execa("git", ["init", "-q", dir], { env });
    // Disable line-ending translation so checked-out file content matches the
    // repository's stored blobs exactly, regardless of the host's global git
    // config (Windows commonly defaults core.autocrlf to true).
    await git(["config", "core.autocrlf", "false"]);
    await git(["remote", "add", "origin", opts.remote]);
    for (const ref of opts.refs) {
      await git(["fetch", "--depth", "50", "--quiet", "origin", ref]);
    }
    await git(["checkout", "--quiet", "--detach", opts.checkoutRef]);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw sanitizeGitError(error, opts.remote);
  }
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export interface CreateWorkspaceOptions {
  owner: string;
  name: string;
  prNumber: number;
  token: string;
  rootDir: string;
}

/**
 * Clones the PR head into a scratch directory the read-only agent explores.
 *
 * Only the PR head ref is fetched — the base branch used to be fetched too
 * ("so `git diff base...HEAD` works"), but the reviewing agent has no Bash
 * access (see `src/runtime/claude.ts`), so nothing can ever run that diff;
 * fetching objects nothing will use only doubled every checkout's network
 * cost. `checkoutRef: "FETCH_HEAD"` still applies unchanged from
 * `createWorkspaceFromRef` — it resolves to the PR head because that is now
 * the only (and therefore last) ref fetched.
 */
export async function createWorkspace(opts: CreateWorkspaceOptions): Promise<Workspace> {
  return createWorkspaceFromRef({
    remote: buildRemoteUrl(opts.owner, opts.name),
    env: buildAuthEnv(opts.token),
    refs: [`pull/${opts.prNumber}/head`],
    checkoutRef: "FETCH_HEAD",
    rootDir: opts.rootDir,
    label: `${opts.owner}-${opts.name}-${opts.prNumber}`,
  });
}
