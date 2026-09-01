# GitHub PR Review Agent — Spec

Confirmed design from a requirements interview on 2026-08-30. This is the
source of truth the implementation plan argues from.

## Goal

A service that watches a preconfigured list of GitHub repos, automatically
reviews newly-opened pull requests using a per-repo "role" (a persona /
instruction set given to Claude), posts the review as inline PR comments,
and can also be triggered manually for subsequent review passes. Runs
continuously (Docker container and/or Windows Service).

## Discovery (automatic reviews)

- **Polling**, not webhooks. Interval configurable, default 10 minutes.
- Detects newly-`opened` PRs only (not `reopened`/`synchronize`), via
  GitHub's Search API (`GET /search/issues` with `is:pr is:open`).
- **Filter**: a raw GitHub search-qualifier string per repo (e.g.
  `author:johndoe -author:dependabot[bot] draft:false base:main`), merged
  with a global default filter string. GitHub does the filtering
  server-side — no client-side condition-evaluation logic.
- A local state store (JSON file) tracks which PRs/passes have already
  been reviewed, so restarts don't cause duplicate auto-reviews.

## Manual / subsequent-pass triggering

- Two entry points:
  1. A **PR comment trigger phrase** (e.g. `@review-agent review`) that
     the poller also scans for via the Search API (`in:comments`).
  2. A **CLI one-shot command** (`review --repo <owner/name> --pr <n>`)
     using the same underlying review function.
- Manual triggers **always bypass the filter string** — explicit intent
  overrides the automatic gate.
- Each subsequent pass is given the PR's **prior review(s) as context**
  (fetched from GitHub), so it can note what's resolved vs. still open
  instead of reviewing blind.

## Config

A central YAML file:

- `defaults.role` / `defaults.filter` — shared across repos.
- `repos[]` — each has `repo` (`owner/name`), and optional `role` /
  `filter` that **fully replace** the default when present (same
  override pattern for both fields — simplest, most predictable).
- `runtime: claude | codex` — global setting, defaults to `claude`.
- `triggerPhrase` — comment string that triggers a manual pass.
- `pollIntervalMinutes` — default 10.

## Auth

- GitHub: a personal PAT (repo read + PR write scopes).
- Claude: `ANTHROPIC_API_KEY` env var — required because this runs
  unattended (no interactive `claude login` in a background service).

## Review engine

- TypeScript/Node.js.
- The review "brain" is a single native Claude Code agent definition
  (Markdown template with a role placeholder and an output-format
  contract), invoked **headlessly**: `claude -p <prompt> --output-format
  json`.
- Before invoking, the harness clones the target repo and checks out the
  PR's head ref (`pull/<n>/head`) into a scratch directory.
- The agent runs there with **live but read-only tools only**:
  Read/Grep/Glob plus non-mutating `git`/`gh` Bash commands. No
  Edit/Write/MultiEdit, no push/commit/merge capability — enforced via
  `--allowed-tools`/`--disallowed-tools`, not by prompt instruction alone.
- A `ReviewRuntime` interface abstracts "run a review, get structured
  findings back." Only a Claude implementation is built now. A Codex
  adapter is a deferred, out-of-scope extension point — Codex already has
  its own native GitHub App + `AGENTS.md`-based review rules as a
  separate, parallel option outside this service.

## Output

The agent must return a single JSON object: `{ summary: string, findings:
[{ file, line, body, severity }] }`. The harness posts this as a GitHub
PR review with inline comments at those files/lines, **always submitted
as `event: "COMMENT"`** — never `APPROVE` or `REQUEST_CHANGES`.

## Deployment

- A `Dockerfile` (portable; needs `git` + `gh` in the image for the
  read-only exploration step, plus the `claude` CLI).
- Run locally for now via a Windows Service wrapper (NSSM); the same
  container is portable to a server/VM later with no code changes.
- Secrets via a gitignored `.env` file (`GITHUB_TOKEN`,
  `ANTHROPIC_API_KEY`, `CONFIG_PATH`, `STATE_PATH`,
  `POLL_INTERVAL_MINUTES` override, `TRIGGER_PHRASE` override).

## Environment facts (as of plan time)

- Dev machine: Windows, Node v24.8.0, npm 11.6.0, git 2.54.0, Python
  3.13.5, Claude Code CLI 2.1.251 installed.
- Docker and `gh` CLI are **not** installed on the dev machine — the
  Dockerfile/compose files are written and structurally reviewed but
  cannot be `docker build`-verified here; that verification happens
  wherever Docker is actually available.
