import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";

export interface Workspace {
  dir: string;
  cleanup(): Promise<void>;
}

export function buildCloneUrl(owner: string, name: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${owner}/${name}.git`;
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
  const git = (args: string[]) => execa("git", ["-C", dir, ...args]);
  try {
    await execa("git", ["init", "-q", dir]);
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
  baseRef: string;
  token: string;
  rootDir: string;
}

/**
 * Clones the PR head (plus the base branch, so `git diff base...HEAD` works)
 * into a scratch directory the read-only agent explores.
 *
 * `baseRef` is fetched before the PR head so that `FETCH_HEAD` — which
 * always resolves to whichever ref was fetched last — resolves to the PR's
 * head commit rather than the base branch.
 */
export async function createWorkspace(opts: CreateWorkspaceOptions): Promise<Workspace> {
  return createWorkspaceFromRef({
    remote: buildCloneUrl(opts.owner, opts.name, opts.token),
    refs: [opts.baseRef, `pull/${opts.prNumber}/head`],
    checkoutRef: "FETCH_HEAD",
    rootDir: opts.rootDir,
    label: `${opts.owner}-${opts.name}-${opts.prNumber}`,
  });
}
