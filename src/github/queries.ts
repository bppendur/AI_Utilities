import type { ResolvedRepo } from "../config/schema.js";

function base(repo: ResolvedRepo): string {
  return `repo:${repo.fullName} is:pr is:open`;
}

/** Automatic discovery: repo scope + open PRs + the operator's raw qualifiers. */
export function buildAutoQuery(repo: ResolvedRepo): string {
  const filter = repo.filter.trim();
  return filter ? `${base(repo)} ${filter}` : base(repo);
}

/**
 * Manual trigger discovery. Deliberately ignores `repo.filter`: an explicit
 * request always bypasses the automatic gate.
 */
export function buildTriggerQuery(repo: ResolvedRepo, triggerPhrase: string): string {
  const escaped = triggerPhrase.replace(/"/g, '\\"');
  return `${base(repo)} "${escaped}" in:comments`;
}
