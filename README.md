# GitHub PR Review Agent

Polls preconfigured GitHub repositories and reviews newly-opened pull
requests with a per-repo role, posting findings as inline PR comments.

## How it works

1. Every `pollIntervalMinutes`, the service runs one GitHub Search API query
   per repo: `repo:<owner>/<name> is:pr is:open <your raw filter>`. Filtering
   happens server-side — the `filter` field is raw GitHub search syntax.
2. Any PR not already in the local state file is shallow-cloned at its head
   commit into a scratch directory (the harness itself shells out to `git`
   for this — see `src/workspace/checkout.ts`).
3. Headless Claude Code (`claude -p --output-format json`) reviews it there
   and returns `{ summary, findings[] }`. The rendered prompt (which embeds
   the full diff and can be very large) is piped to the CLI on **stdin**,
   never passed as a command-line argument — argv has a hard OS length limit
   (~32KB on Windows) that an ordinary-sized diff can exceed. See **Agent
   tool access** below for exactly what the agent can and cannot do while it
   does this.
4. Findings are posted as a GitHub review with `event: "COMMENT"` — this
   service never approves a PR and never requests changes.
5. The pass is recorded so restarts never double-review.

## Setup

```bash
npm ci
cp .env.example .env          # fill in GITHUB_TOKEN and ANTHROPIC_API_KEY
cp config/repos.example.yaml config/repos.yaml
npm run build
node dist/index.js poll-once  # verify before running as a service
```

> **Warning — first-run mass review.** "Newly-opened" is enforced only by
> the PR's *absence from the local state file*, not by an actual creation
> date. The very first time you point this service at a repo, **every** open
> PR that matches your filter looks "new" to it. A repo with 40 open PRs
> gets 40 clones, 40 paid model runs, and **40 reviews posted to real,
> possibly-external PRs** on the first cycle — this is not a dry run and
> there is no undo. **Mitigation:** before the first run, add
> `created:>=YYYY-MM-DD` (today's date, or later) to that repo's `filter` in
> `config/repos.yaml` so only PRs opened from that point forward are picked
> up; remove it (or leave it) once you've confirmed the service behaves as
> expected.

`GITHUB_TOKEN` needs the `repo` scope. `ANTHROPIC_API_KEY` is mandatory: the
service runs unattended and cannot use an interactive `claude login`.

The `claude` CLI (`@anthropic-ai/claude-code`) and `git` must both be on
`PATH` for the process running the agent — the Dockerfile installs both;
for a bare-metal/Windows install, `npm install -g @anthropic-ai/claude-code`
and a system `git` are your responsibility (see
`docs/windows-service.md` for a note on service-account `PATH`).

> **Run exactly one instance per state file.** `state/state.json` has no
> locking. Two processes pointed at the same state file each hold their own
> full copy of it in memory; whichever writes last wins, silently losing the
> other's recorded passes and trigger-comment markers — the practical effect
> is duplicate reviews posted to the same real PR. Never run `run` and
> `poll-once` against the same state file at the same time, and never run
> two `run` processes against it either. In particular, **do not** run the
> `node dist/index.js poll-once` verification step above while the service
> (`run`, e.g. under NSSM) is already running against the same state file —
> see `docs/windows-service.md` for the same note in the service context.

## Commands

| Command | Purpose |
| --- | --- |
| `node dist/index.js run` | Run the polling service continuously. |
| `node dist/index.js poll-once` | Run one cycle and exit — best for testing. |
| `node dist/index.js review --repo acme/api --pr 42` | Review one PR now, bypassing the filter. |

## Triggering an extra review pass

Comment the configured `triggerPhrase` (default `@review-agent review`) on
any open PR in a configured repo. The next poll cycle picks it up, bypasses
the filter, and passes the earlier reviews to the agent so it can report what
has since been resolved.

**A failed manual trigger is not retried.** The poller records the trigger
comment's id *before* attempting the review (`src/poller/poll.ts`), so each
trigger comment causes at most one review attempt, ever — even if that
attempt throws (a bad clone, an `execa` timeout, a malformed model
response). This is deliberate: retrying automatically on a possibly
permanently-broken PR would mean unbounded clones and unbounded paid model
calls. If a triggered review fails, check the service logs for the error,
then **comment the trigger phrase again** to queue a fresh attempt — that is
the recovery path, not a built-in retry.

## Configuration

See `config/repos.example.yaml`. Per-repo `role` and `filter` each fully
replace the shared default when present.

## Agent tool access and security posture

The reviewing agent has **no shell access at all**. Its tool surface
(`src/runtime/claude.ts`) is exactly:

- **Allowed:** `Read`, `Grep`, `Glob` — file reading and searching only.
- **Disallowed:** `Bash` (blanket-denied, not allow-listed to "safe"
  subcommands), plus `Edit`, `Write`, `MultiEdit`, `NotebookEdit`,
  `WebFetch`, `WebSearch`.

This is narrower than earlier designs for this project, which planned to let
the agent explore with read-only `git`/`gh` Bash commands. That was removed
during implementation: several git subcommands accept an `--output=<file>`
(or equivalent) flag that writes arbitrary files, so a prefix allow-list
like `Bash(git diff:*)` is actually an arbitrary-file-write primitive
reachable from attacker-controlled PR content — not a read-only boundary.
Rather than try to enumerate every non-mutating flag spelling across git's
surface, the agent gets no `Bash` at all.

The CLI invocation also carries three hardening flags —
`--bare --setting-sources user --strict-mcp-config` — beyond the tool
allow/disallow lists. These exist because the allow/disallow lists only
gate *tool calls the model decides to make*; they do not gate hooks or MCP
servers. Claude Code runs with `cwd` set inside the PR checkout, which is
attacker-controlled: a PR branch that commits a `.claude/settings.json` or
`.mcp.json` would otherwise have its hooks (arbitrary shell commands) or MCP
servers (arbitrary executables) loaded and run the moment the CLI starts
there — a full code-execution path that has nothing to do with the tool
allow-list. `--bare` skips hooks/plugins/auto-memory/CLAUDE.md discovery,
`--setting-sources user` further guarantees project/local `settings.json`
is never read, and `--strict-mcp-config` guarantees no MCP servers load.
See the comment above `buildClaudeArgs` in `src/runtime/claude.ts` for the
full reasoning — do not remove any of these three flags without
re-verifying the replacement covers all three attack surfaces.

**Prompt injection:** all PR-derived content (title, body, author, branch
names, changed file list, diff, and prior review bodies) is wrapped in
XML-style tags and escaped before being interpolated into the prompt
(`src/runtime/prompt.ts`), and the agent is explicitly told this content is
untrusted data, not instructions. This reduces the risk of prompt injection
from a malicious PR but does **not** eliminate it — a sufficiently crafted
diff or PR body could still influence the model's behavior within its
sandbox. The actual blast-radius limits are the tool restrictions above and
one more property enforced in code, not by the model's good judgment:
reviews are always posted with `event: "COMMENT"`, never `APPROVE` and
never `REQUEST_CHANGES`, so even a fully successful injection cannot make
the bot approve a malicious PR.

## Runtimes

`runtime: claude` is implemented. `runtime: codex` is a declared seam
(`src/runtime/index.ts`) that throws until its adapter is written — for
Codex-based review today, use Codex's own GitHub App with
`## Code Review Rules` in the repo's `AGENTS.md`.

## Known risks / verify before deployment

- **Deprecated GitHub search endpoint.** `src/github/client.ts`'s
  `searchPullRequestNumbers` calls `octokit.rest.search.issuesAndPullRequests`,
  which `@octokit/rest@21.1.1` marks deprecated — GitHub is migrating this
  endpoint. This has **not** been changed as part of this fix wave; doing so
  cannot be verified without live access to confirm the replacement's
  behavior matches. Two consequences to check before relying on the service
  in production: (1) Octokit may emit a deprecation warning on every single
  poll cycle (harmless but noisy in logs); (2) verify both query shapes this
  service sends — the auto-discovery filter query
  (`repo:<owner>/<name> is:pr is:open <filter>`) and the quoted manual
  trigger query (`repo:<owner>/<name> is:pr is:open "<phrase>" in:comments`,
  see `src/github/queries.ts`) — still return the expected results against
  live GitHub, since a migrated endpoint could subtly change matching
  behavior.

## Deployment

### Docker

```bash
docker compose up -d --build
```

Mounts `./config` read-only and persists `./state`. See `Dockerfile` for
what the image contains — notably `git` (required, because the harness
shells out to it for checkout) but deliberately **not** `gh` (the agent has
no shell access, so nothing in the image would ever invoke it).

> **Verification status:** Docker is not installed on the machine this was
> built on. The Dockerfile has been checked statically (it names the right
> base image, installs `git`, installs the Claude Code CLI, builds, and
> copies `agent/` alongside `dist/`) but `docker build` has **not** been
> run. Verify the image actually builds and starts on a machine with Docker
> before relying on it in production.

### Windows Service

See `docs/windows-service.md` for a full NSSM setup, including how to keep
secrets out of the service definition and why service-account `PATH` needs
its own check.

## Development

```bash
npm test              # vitest, one-shot
npm run test:watch    # vitest, watch mode
npx tsc -p tsconfig.json --noEmit   # type-check only
```
