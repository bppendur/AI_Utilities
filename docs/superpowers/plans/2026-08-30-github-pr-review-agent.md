# GitHub PR Review Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a long-running Node/TypeScript service that polls preconfigured GitHub repos, reviews newly-opened pull requests with a per-repo role using headless Claude Code, and posts the findings as inline PR comments.

**Architecture:** A poll loop queries GitHub's Search API once per repo per cycle using a raw per-repo qualifier string, so filtering happens server-side. Each unreviewed PR is shallow-cloned into a scratch workspace, and a `ReviewRuntime` (Claude implementation only for now) invokes `claude -p` headlessly there with read-only tools, returning structured JSON findings. The harness posts those findings as a GitHub review with `event: "COMMENT"` and records the pass in a local JSON state file so restarts never double-review.

**Tech Stack:** Node 24 (ESM), TypeScript (strict), vitest, `@octokit/rest`, `yaml`, `zod`, `commander`, `execa`, `dotenv`. Claude Code CLI (`claude`) and `git` must be on PATH at runtime; `gh` optional but installed in the Docker image.

**Spec:** `docs/superpowers/specs/2026-08-30-github-pr-review-agent.md`

## Global Constraints

- Project root: `D:\bhanu\myprojects\github-pr-review-agent`. It is **not** a git repo yet — Task 1 runs `git init`.
- Node.js `>=24`. `package.json` sets `"type": "module"`. All imports use ESM syntax with explicit `.js` extensions on relative paths (TypeScript NodeNext resolution).
- TypeScript `strict: true`. No `any` in exported signatures.
- Test runner is **vitest**. Every task follows red → green → commit.
- GitHub reviews are **always** submitted with `event: "COMMENT"`. Never `APPROVE`, never `REQUEST_CHANGES`. This is a hard rule enforced in code, not configuration.
- The review agent gets **read-only** tools only. Allowed: `Read`, `Grep`, `Glob`, and `Bash` restricted to non-mutating `git`/`gh` subcommands. Explicitly disallowed: `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `WebFetch`, `WebSearch`.
- Secrets (`GITHUB_TOKEN`, `ANTHROPIC_API_KEY`) are read from env only, never written to logs, never committed. `.env` is gitignored; `.env.example` holds placeholder values only.
- Auth-embedded clone URLs must never appear in log output — always log the sanitized `https://github.com/owner/repo` form.
- Config values: `pollIntervalMinutes` default `10`, `runtime` default `"claude"`, `triggerPhrase` default `"@review-agent review"`.
- `runtime: "codex"` is a declared-but-unimplemented seam. Selecting it must throw a clear, actionable error — never silently fall back to Claude.
- Docker is **not** installed on the dev machine. Task 14's Dockerfile is written and reviewed but cannot be `docker build`-verified locally; that verification is explicitly deferred to a machine with Docker.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/logger.ts` | Timestamped leveled logging; single place that redacts secrets. |
| `src/config/schema.ts` | Zod schema + exported config types. Pure, no I/O. |
| `src/config/load.ts` | Read YAML from disk, validate, resolve per-repo defaults. |
| `src/state/store.ts` | JSON-file state: pass counts + last processed trigger comment id. |
| `src/github/queries.ts` | Pure builders for the two Search API query strings. |
| `src/github/client.ts` | All GitHub **read** operations (search, PR details, comments, prior reviews). |
| `src/github/post-review.ts` | The single GitHub **write** operation, with inline-comment fallback. |
| `src/workspace/checkout.ts` | Shallow-clone the PR head into a scratch dir; cleanup. |
| `src/runtime/types.ts` | `Finding`, `ReviewResult`, `RuntimeInput`, `ReviewRuntime` interface. |
| `src/runtime/parse.ts` | Extract + validate `ReviewResult` JSON out of raw model text. |
| `src/runtime/prompt.ts` | Render the agent template with role + PR context + prior reviews. |
| `src/runtime/claude.ts` | `ReviewRuntime` impl: spawn `claude -p` with read-only tool flags. |
| `src/runtime/index.ts` | `createRuntime()` factory; codex seam throws. |
| `src/review/run-review.ts` | Orchestrator: checkout → prompt → runtime → post → record state. |
| `src/poller/poll.ts` | One poll cycle: auto-discovery pass + trigger-comment pass. |
| `src/cli.ts` | `commander` CLI: `run`, `poll-once`, `review`. |
| `src/index.ts` | Entry point: load `.env`, hand off to CLI. |
| `agent/pr-review-agent.md` | The portable agent prompt template with placeholders. |
| `config/repos.example.yaml` | Documented example config. |
| `Dockerfile`, `.dockerignore`, `docker-compose.yml` | Container packaging. |
| `docs/windows-service.md`, `README.md` | Deployment + operator docs. |

---

### Task 1: Project scaffold and logger

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`
- Create: `src/logger.ts`
- Test: `tests/logger.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `createLogger(name: string): Logger` where `Logger` is `{ info(msg: string, meta?: Record<string, unknown>): void; warn(...): void; error(...): void; }`. Also `redact(text: string, secrets: string[]): string`.

- [ ] **Step 1: Initialize the repo and install dependencies**

```bash
cd /d/bhanu/myprojects/github-pr-review-agent
git init
npm init -y
npm install @octokit/rest yaml zod commander execa dotenv
npm install -D typescript vitest @types/node tsx
```

- [ ] **Step 2: Write `package.json`**

Replace the generated file with:

```json
{
  "name": "github-pr-review-agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "bin": { "pr-review-agent": "./dist/index.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "start": "node dist/index.js run"
  },
  "dependencies": {
    "@octokit/rest": "^21.1.1",
    "commander": "^13.1.0",
    "dotenv": "^16.4.7",
    "execa": "^9.5.2",
    "yaml": "^2.7.0",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "@types/node": "^22.13.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.3",
    "vitest": "^3.0.5"
  }
}
```

Then run `npm install` again so the lockfile matches.

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 4: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
  },
});
```

- [ ] **Step 5: Write `.gitignore` and `.env.example`**

`.gitignore`:

```
node_modules/
dist/
.env
state/
workspaces/
*.log
```

`.env.example`:

```
# GitHub personal access token: needs `repo` scope (read code + write PR reviews)
GITHUB_TOKEN=ghp_replace_me
# Required: this service runs unattended, so interactive Claude login is not an option
ANTHROPIC_API_KEY=sk-ant-replace-me
# Paths (defaults shown)
CONFIG_PATH=./config/repos.yaml
STATE_PATH=./state/state.json
WORKSPACE_ROOT=./workspaces
# Optional overrides of the YAML config
POLL_INTERVAL_MINUTES=10
TRIGGER_PHRASE=@review-agent review
```

- [ ] **Step 6: Write the failing test**

`tests/logger.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createLogger, redact } from "../src/logger.js";

describe("redact", () => {
  it("replaces every occurrence of each secret", () => {
    const out = redact("token=ghp_abc123 and again ghp_abc123", ["ghp_abc123"]);
    expect(out).toBe("token=*** and again ***");
  });

  it("ignores empty or short secrets so it cannot blank the whole message", () => {
    expect(redact("hello", ["", "a"])).toBe("hello");
  });
});

describe("createLogger", () => {
  it("prefixes the logger name and level", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    createLogger("poller").info("cycle start");
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![0]).toContain("[INFO]");
    expect(spy.mock.calls[0]![0]).toContain("[poller]");
    expect(spy.mock.calls[0]![0]).toContain("cycle start");
    spy.mockRestore();
  });

  it("redacts registered secrets from the message", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger("gh", { secrets: ["ghp_supersecret"] });
    log.info("cloning https://ghp_supersecret@github.com/o/r");
    expect(spy.mock.calls[0]![0]).not.toContain("ghp_supersecret");
    spy.mockRestore();
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npx vitest run tests/logger.test.ts`
Expected: FAIL — cannot resolve `../src/logger.js`.

- [ ] **Step 8: Implement `src/logger.ts`**

```ts
export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  secrets?: string[];
}

/** Replace known secret values with `***`. Values shorter than 6 chars are ignored. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 6) continue;
    out = out.split(secret).join("***");
  }
  return out;
}

function defaultSecrets(): string[] {
  return [process.env.GITHUB_TOKEN, process.env.ANTHROPIC_API_KEY].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
}

export function createLogger(name: string, options: LoggerOptions = {}): Logger {
  const emit = (level: string, msg: string, meta?: Record<string, unknown>) => {
    const secrets = options.secrets ?? defaultSecrets();
    const suffix = meta ? ` ${redact(JSON.stringify(meta), secrets)}` : "";
    const line = `${new Date().toISOString()} [${level}] [${name}] ${redact(msg, secrets)}${suffix}`;
    console.log(line);
  };
  return {
    info: (msg, meta) => emit("INFO", msg, meta),
    warn: (msg, meta) => emit("WARN", msg, meta),
    error: (msg, meta) => emit("ERROR", msg, meta),
  };
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npx vitest run tests/logger.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore: scaffold TypeScript project with redacting logger"
```

---

### Task 2: Config schema and loader

**Files:**
- Create: `src/config/schema.ts`, `src/config/load.ts`, `config/repos.example.yaml`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type AppConfig = { runtime: "claude" | "codex"; pollIntervalMinutes: number; triggerPhrase: string; defaults: { role: string; filter: string }; repos: RepoEntry[] }`
  - `type RepoEntry = { repo: string; role?: string; filter?: string }`
  - `type ResolvedRepo = { owner: string; name: string; fullName: string; role: string; filter: string }`
  - `parseConfig(raw: unknown): AppConfig`
  - `loadConfig(path: string): Promise<AppConfig>`
  - `resolveRepos(config: AppConfig): ResolvedRepo[]`

- [ ] **Step 1: Write the failing test**

`tests/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseConfig, resolveRepos } from "../src/config/schema.js";

const minimal = {
  defaults: { role: "You are a reviewer.", filter: "draft:false" },
  repos: [{ repo: "acme/api" }],
};

describe("parseConfig", () => {
  it("applies defaults for runtime, interval and trigger phrase", () => {
    const cfg = parseConfig(minimal);
    expect(cfg.runtime).toBe("claude");
    expect(cfg.pollIntervalMinutes).toBe(10);
    expect(cfg.triggerPhrase).toBe("@review-agent review");
  });

  it("rejects an unknown runtime", () => {
    expect(() => parseConfig({ ...minimal, runtime: "gemini" })).toThrow();
  });

  it("rejects a repo that is not owner/name", () => {
    expect(() => parseConfig({ ...minimal, repos: [{ repo: "acme" }] })).toThrow(
      /owner\/name/,
    );
  });

  it("rejects an empty repo list", () => {
    expect(() => parseConfig({ ...minimal, repos: [] })).toThrow();
  });
});

describe("resolveRepos", () => {
  it("falls back to the shared defaults when a repo overrides nothing", () => {
    const [repo] = resolveRepos(parseConfig(minimal));
    expect(repo).toEqual({
      owner: "acme",
      name: "api",
      fullName: "acme/api",
      role: "You are a reviewer.",
      filter: "draft:false",
    });
  });

  it("lets a repo fully replace role and filter", () => {
    const cfg = parseConfig({
      ...minimal,
      repos: [{ repo: "acme/web", role: "Security reviewer.", filter: "base:main" }],
    });
    const [repo] = resolveRepos(cfg);
    expect(repo!.role).toBe("Security reviewer.");
    expect(repo!.filter).toBe("base:main");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — cannot resolve `../src/config/schema.js`.

- [ ] **Step 3: Implement `src/config/schema.ts`**

```ts
import { z } from "zod";

const repoEntrySchema = z.object({
  repo: z
    .string()
    .regex(/^[^/\s]+\/[^/\s]+$/, "repo must be in the form owner/name"),
  role: z.string().min(1).optional(),
  filter: z.string().optional(),
});

const appConfigSchema = z.object({
  runtime: z.enum(["claude", "codex"]).default("claude"),
  pollIntervalMinutes: z.number().int().positive().default(10),
  triggerPhrase: z.string().min(1).default("@review-agent review"),
  defaults: z.object({
    role: z.string().min(1),
    filter: z.string().default(""),
  }),
  repos: z.array(repoEntrySchema).min(1, "at least one repo must be configured"),
});

export type RepoEntry = z.infer<typeof repoEntrySchema>;
export type AppConfig = z.infer<typeof appConfigSchema>;

export interface ResolvedRepo {
  owner: string;
  name: string;
  fullName: string;
  role: string;
  filter: string;
}

export function parseConfig(raw: unknown): AppConfig {
  return appConfigSchema.parse(raw);
}

/** Per-repo `role`/`filter` fully replace the shared default when present. */
export function resolveRepos(config: AppConfig): ResolvedRepo[] {
  return config.repos.map((entry) => {
    const [owner, name] = entry.repo.split("/") as [string, string];
    return {
      owner,
      name,
      fullName: entry.repo,
      role: entry.role ?? config.defaults.role,
      filter: entry.filter ?? config.defaults.filter,
    };
  });
}
```

- [ ] **Step 4: Implement `src/config/load.ts`**

```ts
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { type AppConfig, parseConfig } from "./schema.js";

export async function loadConfig(path: string): Promise<AppConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`Config file not found or unreadable: ${path}`);
  }
  const config = parseConfig(parseYaml(text));
  const intervalOverride = process.env.POLL_INTERVAL_MINUTES;
  if (intervalOverride) {
    const parsed = Number.parseInt(intervalOverride, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      throw new Error(`POLL_INTERVAL_MINUTES must be a positive integer, got: ${intervalOverride}`);
    }
    config.pollIntervalMinutes = parsed;
  }
  if (process.env.TRIGGER_PHRASE) {
    config.triggerPhrase = process.env.TRIGGER_PHRASE;
  }
  return config;
}
```

- [ ] **Step 5: Write `config/repos.example.yaml`**

```yaml
# Which AI runtime performs reviews. Only "claude" is implemented today;
# "codex" is a declared seam that will throw until its adapter is written.
runtime: claude

# How often to poll GitHub for new pull requests.
pollIntervalMinutes: 10

# Commenting this phrase on a PR queues an extra review pass. Manual passes
# always bypass the filter below.
triggerPhrase: "@review-agent review"

defaults:
  role: |
    You are a pragmatic senior engineer reviewing a pull request.
    Prioritise correctness bugs, security issues, and data-loss risks.
    Do not comment on formatting that a linter would catch.
  # Raw GitHub search qualifiers. GitHub applies these server-side; the
  # service adds `repo:<owner>/<name> is:pr is:open` automatically.
  filter: "draft:false -author:dependabot[bot] -author:renovate[bot]"

repos:
  # Inherits both defaults above.
  - repo: acme/api

  # Fully replaces the default role; keeps the default filter.
  - repo: acme/payments
    role: |
      You are a payments-domain reviewer. Scrutinise money arithmetic,
      rounding, currency handling, idempotency, and retry safety.

  # Fully replaces the default filter; keeps the default role.
  - repo: acme/infra
    filter: "draft:false base:main -author:dependabot[bot]"
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add YAML config schema, loader and example config"
```

---

### Task 3: State store

**Files:**
- Create: `src/state/store.ts`
- Test: `tests/state.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `prKey(fullName: string, prNumber: number): string` → `"acme/api#42"`
  - `class StateStore` with `static open(path: string): Promise<StateStore>`, `hasBeenReviewed(key: string): boolean`, `passCount(key: string): number`, `recordPass(key: string): Promise<number>` (returns the new pass number, 1-based), `lastTriggerCommentId(key: string): number`, `setLastTriggerCommentId(key: string, id: number): Promise<void>`.

- [ ] **Step 1: Write the failing test**

`tests/state.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prKey, StateStore } from "../src/state/store.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "prstate-"));
  file = join(dir, "nested", "state.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("StateStore", () => {
  it("starts empty when the file does not exist yet", async () => {
    const store = await StateStore.open(file);
    expect(store.hasBeenReviewed(prKey("acme/api", 1))).toBe(false);
    expect(store.passCount(prKey("acme/api", 1))).toBe(0);
  });

  it("records passes with an increasing 1-based pass number", async () => {
    const store = await StateStore.open(file);
    const key = prKey("acme/api", 7);
    expect(await store.recordPass(key)).toBe(1);
    expect(await store.recordPass(key)).toBe(2);
    expect(store.hasBeenReviewed(key)).toBe(true);
  });

  it("survives a reopen so restarts do not double-review", async () => {
    const key = prKey("acme/api", 7);
    const first = await StateStore.open(file);
    await first.recordPass(key);
    const second = await StateStore.open(file);
    expect(second.hasBeenReviewed(key)).toBe(true);
    expect(second.passCount(key)).toBe(1);
  });

  it("tracks the last processed trigger comment id per PR", async () => {
    const store = await StateStore.open(file);
    const key = prKey("acme/api", 9);
    expect(store.lastTriggerCommentId(key)).toBe(0);
    await store.setLastTriggerCommentId(key, 555);
    expect(store.lastTriggerCommentId(key)).toBe(555);
    const reopened = await StateStore.open(file);
    expect(reopened.lastTriggerCommentId(key)).toBe(555);
  });

  it("treats a corrupt state file as empty rather than crashing the service", async () => {
    const store = await StateStore.open(file);
    await store.recordPass(prKey("acme/api", 1));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, "{ not json", "utf8");
    const reopened = await StateStore.open(file);
    expect(reopened.hasBeenReviewed(prKey("acme/api", 1))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/state.test.ts`
Expected: FAIL — cannot resolve `../src/state/store.js`.

- [ ] **Step 3: Implement `src/state/store.ts`**

```ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface PrState {
  passes: number;
  lastTriggerCommentId: number;
}

interface StateData {
  prs: Record<string, PrState>;
}

export function prKey(fullName: string, prNumber: number): string {
  return `${fullName}#${prNumber}`;
}

export class StateStore {
  private constructor(
    private readonly path: string,
    private data: StateData,
  ) {}

  static async open(path: string): Promise<StateStore> {
    let data: StateData = { prs: {} };
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<StateData>;
      if (parsed && typeof parsed === "object" && parsed.prs && typeof parsed.prs === "object") {
        data = { prs: parsed.prs };
      }
    } catch {
      // Missing or corrupt state must never take the service down; start fresh.
      data = { prs: {} };
    }
    return new StateStore(path, data);
  }

  private entry(key: string): PrState {
    return this.data.prs[key] ?? { passes: 0, lastTriggerCommentId: 0 };
  }

  hasBeenReviewed(key: string): boolean {
    return this.entry(key).passes > 0;
  }

  passCount(key: string): number {
    return this.entry(key).passes;
  }

  async recordPass(key: string): Promise<number> {
    const next = { ...this.entry(key) };
    next.passes += 1;
    this.data.prs[key] = next;
    await this.flush();
    return next.passes;
  }

  lastTriggerCommentId(key: string): number {
    return this.entry(key).lastTriggerCommentId;
  }

  async setLastTriggerCommentId(key: string, id: number): Promise<void> {
    this.data.prs[key] = { ...this.entry(key), lastTriggerCommentId: id };
    await this.flush();
  }

  /** Write via a temp file + rename so a crash mid-write cannot corrupt state. */
  private async flush(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
    await rename(tmp, this.path);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/state.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add crash-safe JSON state store for review passes"
```

---

### Task 4: Search query builders

**Files:**
- Create: `src/github/queries.ts`
- Test: `tests/github/queries.test.ts`

**Interfaces:**
- Consumes: `ResolvedRepo` from `src/config/schema.ts`.
- Produces: `buildAutoQuery(repo: ResolvedRepo): string`, `buildTriggerQuery(repo: ResolvedRepo, triggerPhrase: string): string`.

- [ ] **Step 1: Write the failing test**

`tests/github/queries.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ResolvedRepo } from "../../src/config/schema.js";
import { buildAutoQuery, buildTriggerQuery } from "../../src/github/queries.js";

const repo: ResolvedRepo = {
  owner: "acme",
  name: "api",
  fullName: "acme/api",
  role: "reviewer",
  filter: "draft:false -author:dependabot[bot]",
};

describe("buildAutoQuery", () => {
  it("scopes to the repo and to open PRs, then appends the raw filter", () => {
    expect(buildAutoQuery(repo)).toBe(
      "repo:acme/api is:pr is:open draft:false -author:dependabot[bot]",
    );
  });

  it("omits trailing whitespace when the filter is empty", () => {
    expect(buildAutoQuery({ ...repo, filter: "" })).toBe("repo:acme/api is:pr is:open");
  });
});

describe("buildTriggerQuery", () => {
  it("searches comments for the quoted trigger phrase and ignores the filter", () => {
    expect(buildTriggerQuery(repo, "@review-agent review")).toBe(
      'repo:acme/api is:pr is:open "@review-agent review" in:comments',
    );
  });

  it("escapes double quotes inside the trigger phrase", () => {
    expect(buildTriggerQuery(repo, 'say "hi"')).toBe(
      'repo:acme/api is:pr is:open "say \\"hi\\"" in:comments',
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/github/queries.test.ts`
Expected: FAIL — cannot resolve `../../src/github/queries.js`.

- [ ] **Step 3: Implement `src/github/queries.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/github/queries.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add GitHub search query builders for auto and trigger passes"
```

---

### Task 5: GitHub read client

**Files:**
- Create: `src/github/client.ts`
- Test: `tests/github/client.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (takes an injected Octokit-shaped object).
- Produces:
  - `interface PullRequestRef { owner: string; repo: string; number: number }`
  - `interface PullRequestDetails { number, title, body, author, headRef, headSha, baseRef, draft, changedFiles: string[], diff: string }`
  - `interface TriggerComment { id: number; author: string; createdAt: string; body: string }`
  - `interface PriorReview { author: string; submittedAt: string; body: string }`
  - `class GitHubClient` with `constructor(octokit: OctokitLike)`, `static fromToken(token: string): GitHubClient`, `searchPullRequestNumbers(query: string): Promise<number[]>`, `getPullRequest(ref): Promise<PullRequestDetails>`, `listTriggerComments(ref, phrase): Promise<TriggerComment[]>`, `listPriorReviews(ref): Promise<PriorReview[]>`, and a `readonly octokit` getter used by Task 6.

- [ ] **Step 1: Write the failing test**

`tests/github/client.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { GitHubClient } from "../../src/github/client.js";

const ref = { owner: "acme", repo: "api", number: 42 };

function fakeOctokit(overrides: Record<string, unknown> = {}) {
  return {
    rest: {
      search: {
        issuesAndPullRequests: vi.fn().mockResolvedValue({
          data: { items: [{ number: 42 }, { number: 43 }] },
        }),
      },
      pulls: {
        get: vi.fn().mockImplementation(({ mediaType }) =>
          mediaType?.format === "diff"
            ? Promise.resolve({ data: "diff --git a/x b/x" })
            : Promise.resolve({
                data: {
                  number: 42,
                  title: "Add widget",
                  body: "Closes #1",
                  user: { login: "octocat" },
                  head: { ref: "feature", sha: "abc123" },
                  base: { ref: "main" },
                  draft: false,
                },
              }),
        ),
        listFiles: vi.fn().mockResolvedValue({
          data: [{ filename: "src/a.ts" }, { filename: "src/b.ts" }],
        }),
        listReviews: vi.fn().mockResolvedValue({
          data: [
            { user: { login: "octocat" }, submitted_at: "2026-01-01T00:00:00Z", body: "looks ok" },
            { user: { login: "octocat" }, submitted_at: "2026-01-02T00:00:00Z", body: "" },
          ],
        }),
      },
      issues: {
        listComments: vi.fn().mockResolvedValue({
          data: [
            { id: 1, user: { login: "bhanu" }, created_at: "2026-01-01T00:00:00Z", body: "nice work" },
            { id: 2, user: { login: "bhanu" }, created_at: "2026-01-02T00:00:00Z", body: "@review-agent review please" },
          ],
        }),
      },
    },
    ...overrides,
  };
}

describe("GitHubClient", () => {
  it("returns PR numbers from a search query", async () => {
    const octo = fakeOctokit();
    const client = new GitHubClient(octo as never);
    await expect(client.searchPullRequestNumbers("repo:acme/api is:pr")).resolves.toEqual([42, 43]);
    expect(octo.rest.search.issuesAndPullRequests).toHaveBeenCalledWith(
      expect.objectContaining({ q: "repo:acme/api is:pr", per_page: 100 }),
    );
  });

  it("assembles PR details including changed files and the raw diff", async () => {
    const client = new GitHubClient(fakeOctokit() as never);
    const pr = await client.getPullRequest(ref);
    expect(pr).toMatchObject({
      number: 42,
      title: "Add widget",
      author: "octocat",
      headRef: "feature",
      headSha: "abc123",
      baseRef: "main",
      draft: false,
      changedFiles: ["src/a.ts", "src/b.ts"],
      diff: "diff --git a/x b/x",
    });
  });

  it("returns only comments containing the trigger phrase", async () => {
    const client = new GitHubClient(fakeOctokit() as never);
    const comments = await client.listTriggerComments(ref, "@review-agent review");
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ id: 2, author: "bhanu" });
  });

  it("drops prior reviews that carry no body text", async () => {
    const client = new GitHubClient(fakeOctokit() as never);
    const reviews = await client.listPriorReviews(ref);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.body).toBe("looks ok");
  });

  it("truncates an oversized diff and says so", async () => {
    const octo = fakeOctokit();
    octo.rest.pulls.get = vi.fn().mockImplementation(({ mediaType }) =>
      mediaType?.format === "diff"
        ? Promise.resolve({ data: "x".repeat(300_000) })
        : Promise.resolve({
            data: {
              number: 42, title: "t", body: "", user: { login: "u" },
              head: { ref: "f", sha: "s" }, base: { ref: "main" }, draft: false,
            },
          }),
    );
    const client = new GitHubClient(octo as never);
    const pr = await client.getPullRequest(ref);
    expect(pr.diff.length).toBeLessThan(300_000);
    expect(pr.diff).toContain("[diff truncated]");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/github/client.test.ts`
Expected: FAIL — cannot resolve `../../src/github/client.js`.

- [ ] **Step 3: Implement `src/github/client.ts`**

```ts
import { Octokit } from "@octokit/rest";

export const MAX_DIFF_CHARS = 200_000;

export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
}

export interface PullRequestDetails {
  number: number;
  title: string;
  body: string;
  author: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  draft: boolean;
  changedFiles: string[];
  diff: string;
}

export interface TriggerComment {
  id: number;
  author: string;
  createdAt: string;
  body: string;
}

export interface PriorReview {
  author: string;
  submittedAt: string;
  body: string;
}

export class GitHubClient {
  constructor(readonly octokit: Octokit) {}

  static fromToken(token: string): GitHubClient {
    if (!token) throw new Error("GITHUB_TOKEN is required but was empty");
    return new GitHubClient(new Octokit({ auth: token }));
  }

  async searchPullRequestNumbers(query: string): Promise<number[]> {
    const res = await this.octokit.rest.search.issuesAndPullRequests({
      q: query,
      per_page: 100,
    });
    return res.data.items.map((item) => item.number);
  }

  async getPullRequest(ref: PullRequestRef): Promise<PullRequestDetails> {
    const params = { owner: ref.owner, repo: ref.repo, pull_number: ref.number };
    const [detail, files, diff] = await Promise.all([
      this.octokit.rest.pulls.get(params),
      this.octokit.rest.pulls.listFiles({ ...params, per_page: 100 }),
      this.octokit.rest.pulls.get({ ...params, mediaType: { format: "diff" } }),
    ]);
    const raw = diff.data as unknown as string;
    return {
      number: detail.data.number,
      title: detail.data.title,
      body: detail.data.body ?? "",
      author: detail.data.user?.login ?? "unknown",
      headRef: detail.data.head.ref,
      headSha: detail.data.head.sha,
      baseRef: detail.data.base.ref,
      draft: detail.data.draft ?? false,
      changedFiles: files.data.map((f) => f.filename),
      diff:
        raw.length > MAX_DIFF_CHARS
          ? `${raw.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated — inspect the checked-out working tree for the rest]`
          : raw,
    };
  }

  async listTriggerComments(
    ref: PullRequestRef,
    triggerPhrase: string,
  ): Promise<TriggerComment[]> {
    const res = await this.octokit.rest.issues.listComments({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.number,
      per_page: 100,
    });
    const needle = triggerPhrase.toLowerCase();
    return res.data
      .filter((c) => (c.body ?? "").toLowerCase().includes(needle))
      .map((c) => ({
        id: c.id,
        author: c.user?.login ?? "unknown",
        createdAt: c.created_at,
        body: c.body ?? "",
      }));
  }

  async listPriorReviews(ref: PullRequestRef): Promise<PriorReview[]> {
    const res = await this.octokit.rest.pulls.listReviews({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
      per_page: 100,
    });
    return res.data
      .filter((r) => (r.body ?? "").trim().length > 0)
      .map((r) => ({
        author: r.user?.login ?? "unknown",
        submittedAt: r.submitted_at ?? "",
        body: r.body ?? "",
      }));
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/github/client.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add GitHub read client for search, PR details and prior reviews"
```

---

### Task 6: Post a COMMENT review with inline-comment fallback

**Files:**
- Create: `src/github/post-review.ts`
- Test: `tests/github/post-review.test.ts`

**Interfaces:**
- Consumes: `PullRequestRef` from `src/github/client.ts`; `ReviewResult`/`Finding` types are declared in Task 9 — this task declares them first in `src/runtime/types.ts` (create the file here with just the types; Task 9 extends it).
- Produces: `postReview(octokit, ref, headSha, result: ReviewResult): Promise<{ inline: boolean }>` — `inline: true` when inline comments were accepted, `false` when it fell back to a summary-only review.
- Also produces (in `src/runtime/types.ts`): `type Severity = "critical" | "major" | "minor" | "nit"`, `interface Finding { file: string; line: number; severity: Severity; body: string }`, `interface ReviewResult { summary: string; findings: Finding[] }`.

- [ ] **Step 1: Create `src/runtime/types.ts` with the shared result types**

```ts
export type Severity = "critical" | "major" | "minor" | "nit";

export interface Finding {
  file: string;
  line: number;
  severity: Severity;
  body: string;
}

export interface ReviewResult {
  summary: string;
  findings: Finding[];
}
```

- [ ] **Step 2: Write the failing test**

`tests/github/post-review.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { postReview } from "../../src/github/post-review.js";
import type { ReviewResult } from "../../src/runtime/types.js";

const ref = { owner: "acme", repo: "api", number: 42 };
const result: ReviewResult = {
  summary: "Two issues found.",
  findings: [
    { file: "src/a.ts", line: 10, severity: "major", body: "Unhandled null." },
    { file: "src/b.ts", line: 3, severity: "nit", body: "Rename this." },
  ],
};

describe("postReview", () => {
  it("always submits with event COMMENT and never approves", async () => {
    const createReview = vi.fn().mockResolvedValue({ data: {} });
    const octo = { rest: { pulls: { createReview } } };
    await postReview(octo as never, ref, "abc123", result);
    const args = createReview.mock.calls[0]![0];
    expect(args.event).toBe("COMMENT");
    expect(args.commit_id).toBe("abc123");
    expect(args.comments).toHaveLength(2);
    expect(args.comments[0]).toMatchObject({ path: "src/a.ts", line: 10, side: "RIGHT" });
    expect(args.comments[0].body).toContain("**MAJOR**");
  });

  it("falls back to a summary-only review when GitHub rejects the inline positions", async () => {
    const createReview = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("Unprocessable"), { status: 422 }))
      .mockResolvedValueOnce({ data: {} });
    const octo = { rest: { pulls: { createReview } } };
    const outcome = await postReview(octo as never, ref, "abc123", result);
    expect(outcome.inline).toBe(false);
    expect(createReview).toHaveBeenCalledTimes(2);
    const fallback = createReview.mock.calls[1]![0];
    expect(fallback.comments).toBeUndefined();
    expect(fallback.event).toBe("COMMENT");
    expect(fallback.body).toContain("src/a.ts:10");
    expect(fallback.body).toContain("Unhandled null.");
  });

  it("posts a summary-only review when there are no findings", async () => {
    const createReview = vi.fn().mockResolvedValue({ data: {} });
    const octo = { rest: { pulls: { createReview } } };
    await postReview(octo as never, ref, "abc123", { summary: "All clear.", findings: [] });
    const args = createReview.mock.calls[0]![0];
    expect(args.comments).toBeUndefined();
    expect(args.event).toBe("COMMENT");
  });

  it("rethrows non-422 errors instead of silently degrading", async () => {
    const createReview = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("boom"), { status: 500 }));
    const octo = { rest: { pulls: { createReview } } };
    await expect(postReview(octo as never, ref, "abc123", result)).rejects.toThrow("boom");
    expect(createReview).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/github/post-review.test.ts`
Expected: FAIL — cannot resolve `../../src/github/post-review.js`.

- [ ] **Step 4: Implement `src/github/post-review.ts`**

```ts
import type { Octokit } from "@octokit/rest";
import type { PullRequestRef } from "./client.js";
import type { ReviewResult } from "../runtime/types.js";

function findingBody(severity: string, body: string): string {
  return `**${severity.toUpperCase()}** — ${body}`;
}

function summaryWithFindings(result: ReviewResult): string {
  if (result.findings.length === 0) return result.summary;
  const lines = result.findings.map(
    (f) => `- \`${f.file}:${f.line}\` **${f.severity.toUpperCase()}** — ${f.body}`,
  );
  return `${result.summary}\n\n<details><summary>Findings</summary>\n\n${lines.join("\n")}\n\n</details>`;
}

/**
 * Posts the review. Always `event: "COMMENT"` — this service never approves
 * a PR nor requests changes. If GitHub rejects the inline positions (422,
 * typically a line outside the diff), retries once as a summary-only review
 * so the findings are never lost.
 */
export async function postReview(
  octokit: Octokit,
  ref: PullRequestRef,
  headSha: string,
  result: ReviewResult,
): Promise<{ inline: boolean }> {
  const base = {
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.number,
    commit_id: headSha,
    event: "COMMENT" as const,
  };

  if (result.findings.length === 0) {
    await octokit.rest.pulls.createReview({ ...base, body: result.summary });
    return { inline: false };
  }

  try {
    await octokit.rest.pulls.createReview({
      ...base,
      body: result.summary,
      comments: result.findings.map((f) => ({
        path: f.file,
        line: f.line,
        side: "RIGHT" as const,
        body: findingBody(f.severity, f.body),
      })),
    });
    return { inline: true };
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status !== 422) throw error;
    await octokit.rest.pulls.createReview({ ...base, body: summaryWithFindings(result) });
    return { inline: false };
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/github/post-review.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: post COMMENT-only reviews with summary fallback on 422"
```

---

### Task 7: Workspace checkout

**Files:**
- Create: `src/workspace/checkout.ts`
- Test: `tests/workspace/checkout.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface Workspace { dir: string; cleanup(): Promise<void> }`
  - `buildCloneUrl(owner: string, name: string, token: string): string`
  - `createWorkspace(opts: { owner: string; name: string; prNumber: number; baseRef: string; token: string; rootDir: string }): Promise<Workspace>`
  - `createWorkspaceFromRef(opts: { remote: string; refs: string[]; checkoutRef: string; rootDir: string; label: string }): Promise<Workspace>` — the underlying primitive `createWorkspace` delegates to; tested directly against a real local git repo.

- [ ] **Step 1: Write the failing test**

`tests/workspace/checkout.test.ts`:

```ts
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCloneUrl, createWorkspaceFromRef } from "../../src/workspace/checkout.js";

const run = promisify(execFile);

let root: string;
let origin: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "prws-"));
  origin = join(root, "origin");
  await run("git", ["init", "-b", "main", origin]);
  await run("git", ["-C", origin, "config", "user.email", "t@example.com"]);
  await run("git", ["-C", origin, "config", "user.name", "Test"]);
  await writeFile(join(origin, "hello.txt"), "from main\n", "utf8");
  await run("git", ["-C", origin, "add", "."]);
  await run("git", ["-C", origin, "commit", "-m", "initial"]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("buildCloneUrl", () => {
  it("embeds the token as basic auth so git can fetch private repos", () => {
    expect(buildCloneUrl("acme", "api", "ghp_tok")).toBe(
      "https://x-access-token:ghp_tok@github.com/acme/api.git",
    );
  });
});

describe("createWorkspaceFromRef", () => {
  it("checks out the requested ref into an isolated directory", async () => {
    const ws = await createWorkspaceFromRef({
      remote: origin,
      refs: ["main"],
      checkoutRef: "FETCH_HEAD",
      rootDir: join(root, "workspaces"),
      label: "acme-api-1",
    });
    const content = await readFile(join(ws.dir, "hello.txt"), "utf8");
    expect(content).toBe("from main\n");
    await ws.cleanup();
    await expect(access(ws.dir)).rejects.toThrow();
  });

  it("fails loudly when the ref does not exist", async () => {
    await expect(
      createWorkspaceFromRef({
        remote: origin,
        refs: ["does-not-exist"],
        checkoutRef: "FETCH_HEAD",
        rootDir: join(root, "workspaces"),
        label: "acme-api-2",
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/workspace/checkout.test.ts`
Expected: FAIL — cannot resolve `../../src/workspace/checkout.js`.

- [ ] **Step 3: Implement `src/workspace/checkout.ts`**

```ts
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
    await git(["remote", "add", "origin", opts.remote]);
    for (const ref of opts.refs) {
      await git(["fetch", "--depth", "50", "--quiet", "origin", ref]);
    }
    await git(["checkout", "--quiet", "--detach", opts.checkoutRef]);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
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
 */
export async function createWorkspace(opts: CreateWorkspaceOptions): Promise<Workspace> {
  return createWorkspaceFromRef({
    remote: buildCloneUrl(opts.owner, opts.name, opts.token),
    refs: [`pull/${opts.prNumber}/head`, opts.baseRef],
    checkoutRef: "FETCH_HEAD",
    rootDir: opts.rootDir,
    label: `${opts.owner}-${opts.name}-${opts.prNumber}`,
  });
}
```

> **Note on `FETCH_HEAD`:** the PR head is fetched first, then the base branch, so the final `FETCH_HEAD` would point at the base. Fix by fetching the base first. Reorder `refs` to `[opts.baseRef, \`pull/${opts.prNumber}/head\`]` so the PR head is fetched last and `FETCH_HEAD` resolves to it. Apply this ordering when implementing.

- [ ] **Step 4: Apply the `refs` ordering fix**

In `createWorkspace`, the `refs` array must be:

```ts
refs: [opts.baseRef, `pull/${opts.prNumber}/head`],
```

- [ ] **Step 5: Add a test proving the last-fetched ref wins**

Append to `tests/workspace/checkout.test.ts`:

```ts
it("checks out the last fetched ref when several are requested", async () => {
  await run("git", ["-C", origin, "checkout", "-q", "-b", "feature"]);
  await writeFile(join(origin, "hello.txt"), "from feature\n", "utf8");
  await run("git", ["-C", origin, "commit", "-qam", "feature change"]);
  await run("git", ["-C", origin, "checkout", "-q", "main"]);

  const ws = await createWorkspaceFromRef({
    remote: origin,
    refs: ["main", "feature"],
    checkoutRef: "FETCH_HEAD",
    rootDir: join(root, "workspaces"),
    label: "acme-api-3",
  });
  expect(await readFile(join(ws.dir, "hello.txt"), "utf8")).toBe("from feature\n");
  await ws.cleanup();
});
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/workspace/checkout.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: shallow-clone PR head into an isolated scratch workspace"
```

---

### Task 8: Agent template and prompt builder

**Files:**
- Create: `agent/pr-review-agent.md`, `src/runtime/prompt.ts`
- Test: `tests/runtime/prompt.test.ts`

**Interfaces:**
- Consumes: `PullRequestDetails`, `PriorReview` from `src/github/client.ts`.
- Produces:
  - `interface PromptContext { role: string; repoFullName: string; passNumber: number; pr: PullRequestDetails; priorReviews: PriorReview[] }`
  - `buildPrompt(template: string, ctx: PromptContext): string`
  - `loadTemplate(path: string): Promise<string>`
  - `DEFAULT_TEMPLATE_PATH: string` (resolves `agent/pr-review-agent.md` relative to the package root).

- [ ] **Step 1: Write `agent/pr-review-agent.md`**

```markdown
# Pull Request Review Agent

You are reviewing a single GitHub pull request. The repository is already
checked out at the PR's head commit in your current working directory.

## Your role

{{ROLE}}

## Review pass

This is review pass **{{PASS_NUMBER}}** for this pull request.

{{PRIOR_REVIEWS}}

## Pull request

Repository: {{REPO}}
PR #{{PR_NUMBER}}: {{PR_TITLE}}
Author: {{PR_AUTHOR}}
Base branch: {{BASE_REF}} — Head branch: {{HEAD_REF}}

Description:
{{PR_BODY}}

Changed files:
{{CHANGED_FILES}}

## Diff

```diff
{{DIFF}}
```

## How to work

You have read-only access to the checked-out repository. Use Read, Grep and
Glob to inspect any file, and read-only git commands (`git log`, `git show`,
`git diff {{BASE_REF}}...HEAD`) to understand history and the full change.
You cannot and must not modify, commit, or push anything.

Look beyond the diff when it matters: check callers of changed functions,
existing tests, and neighbouring code for the conventions this change should
follow.

## What to report

Report only issues that are worth a human's attention: correctness bugs,
security problems, data-loss risks, broken contracts with callers, missing
error handling on paths that can realistically fail, and missing test
coverage for new behaviour. Do not report formatting a linter would catch,
and do not restate what the diff obviously does.

For every finding, give the file path exactly as it appears in the diff, and
a line number **that exists in the new version of that file** — inline
comments on lines outside the diff will be rejected.

## Output format

Respond with a single JSON object and nothing else. No prose before or after,
no markdown fences.

{
  "summary": "A short paragraph summarising the change and your overall assessment.",
  "findings": [
    {
      "file": "src/example.ts",
      "line": 42,
      "severity": "critical | major | minor | nit",
      "body": "What is wrong, why it matters, and what to do instead."
    }
  ]
}

If you find nothing worth reporting, return an empty `findings` array and say
so in the summary.
```

- [ ] **Step 2: Write the failing test**

`tests/runtime/prompt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { PullRequestDetails } from "../../src/github/client.js";
import { buildPrompt, loadTemplate, DEFAULT_TEMPLATE_PATH } from "../../src/runtime/prompt.js";

const pr: PullRequestDetails = {
  number: 42,
  title: "Add widget",
  body: "Closes #1",
  author: "octocat",
  headRef: "feature",
  headSha: "abc123",
  baseRef: "main",
  draft: false,
  changedFiles: ["src/a.ts", "src/b.ts"],
  diff: "diff --git a/src/a.ts b/src/a.ts",
};

describe("buildPrompt", () => {
  it("substitutes every placeholder", async () => {
    const template = await loadTemplate(DEFAULT_TEMPLATE_PATH);
    const out = buildPrompt(template, {
      role: "Security reviewer.",
      repoFullName: "acme/api",
      passNumber: 1,
      pr,
      priorReviews: [],
    });
    expect(out).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(out).toContain("Security reviewer.");
    expect(out).toContain("acme/api");
    expect(out).toContain("PR #42: Add widget");
    expect(out).toContain("- src/a.ts");
    expect(out).toContain("diff --git a/src/a.ts");
  });

  it("says there are no prior reviews on the first pass", async () => {
    const template = await loadTemplate(DEFAULT_TEMPLATE_PATH);
    const out = buildPrompt(template, {
      role: "r", repoFullName: "acme/api", passNumber: 1, pr, priorReviews: [],
    });
    expect(out).toContain("This is the first review");
  });

  it("includes prior review bodies on a later pass so it can track resolution", async () => {
    const template = await loadTemplate(DEFAULT_TEMPLATE_PATH);
    const out = buildPrompt(template, {
      role: "r",
      repoFullName: "acme/api",
      passNumber: 2,
      pr,
      priorReviews: [
        { author: "bot", submittedAt: "2026-01-01T00:00:00Z", body: "Null check missing." },
      ],
    });
    expect(out).toContain("pass **2**");
    expect(out).toContain("Null check missing.");
    expect(out).toContain("already been resolved");
  });

  it("substitutes an empty PR body without leaving a hole", async () => {
    const template = await loadTemplate(DEFAULT_TEMPLATE_PATH);
    const out = buildPrompt(template, {
      role: "r", repoFullName: "acme/api", passNumber: 1,
      pr: { ...pr, body: "" }, priorReviews: [],
    });
    expect(out).toContain("(no description provided)");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/runtime/prompt.test.ts`
Expected: FAIL — cannot resolve `../../src/runtime/prompt.js`.

- [ ] **Step 4: Implement `src/runtime/prompt.ts`**

```ts
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PriorReview, PullRequestDetails } from "../github/client.js";

const here = dirname(fileURLToPath(import.meta.url));

/** `src/runtime/` in dev, `dist/runtime/` after build — `agent/` sits beside both. */
export const DEFAULT_TEMPLATE_PATH = join(here, "..", "..", "agent", "pr-review-agent.md");

export interface PromptContext {
  role: string;
  repoFullName: string;
  passNumber: number;
  pr: PullRequestDetails;
  priorReviews: PriorReview[];
}

export async function loadTemplate(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function renderPriorReviews(ctx: PromptContext): string {
  if (ctx.priorReviews.length === 0) {
    return "This is the first review of this pull request. There is no earlier feedback to take into account.";
  }
  const blocks = ctx.priorReviews
    .map((r) => `### Review by ${r.author} (${r.submittedAt})\n\n${r.body}`)
    .join("\n\n");
  return [
    "Earlier reviews of this pull request are shown below. Check which points have",
    "already been resolved by the current code, say so explicitly in your summary,",
    "and do not repeat findings that no longer apply.",
    "",
    blocks,
  ].join("\n");
}

export function buildPrompt(template: string, ctx: PromptContext): string {
  const values: Record<string, string> = {
    ROLE: ctx.role.trim(),
    PASS_NUMBER: String(ctx.passNumber),
    PRIOR_REVIEWS: renderPriorReviews(ctx),
    REPO: ctx.repoFullName,
    PR_NUMBER: String(ctx.pr.number),
    PR_TITLE: ctx.pr.title,
    PR_AUTHOR: ctx.pr.author,
    BASE_REF: ctx.pr.baseRef,
    HEAD_REF: ctx.pr.headRef,
    PR_BODY: ctx.pr.body.trim() || "(no description provided)",
    CHANGED_FILES: ctx.pr.changedFiles.map((f) => `- ${f}`).join("\n") || "(none reported)",
    DIFF: ctx.pr.diff,
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => values[key] ?? match);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/runtime/prompt.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add portable agent template and prompt builder"
```

---

### Task 9: Review result parser

**Files:**
- Modify: `src/runtime/types.ts` (add `RuntimeInput` and `ReviewRuntime`)
- Create: `src/runtime/parse.ts`
- Test: `tests/runtime/parse.test.ts`

**Interfaces:**
- Consumes: `ReviewResult`, `Finding`, `Severity` from `src/runtime/types.ts` (created in Task 6).
- Produces:
  - `interface RuntimeInput { prompt: string; workspaceDir: string; timeoutMs: number }`
  - `interface ReviewRuntime { readonly name: string; review(input: RuntimeInput): Promise<ReviewResult> }`
  - `parseReviewResult(raw: string): ReviewResult`

- [ ] **Step 1: Write the failing test**

`tests/runtime/parse.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseReviewResult } from "../../src/runtime/parse.js";

describe("parseReviewResult", () => {
  it("parses a bare JSON object", () => {
    const out = parseReviewResult('{"summary":"ok","findings":[]}');
    expect(out).toEqual({ summary: "ok", findings: [] });
  });

  it("extracts JSON from a fenced code block", () => {
    const raw = 'Here you go:\n```json\n{"summary":"ok","findings":[]}\n```\nThanks!';
    expect(parseReviewResult(raw).summary).toBe("ok");
  });

  it("extracts JSON when the model adds prose around it", () => {
    const raw = 'Sure.\n{"summary":"ok","findings":[]}\nLet me know.';
    expect(parseReviewResult(raw).summary).toBe("ok");
  });

  it("normalises findings and coerces string line numbers", () => {
    const raw = JSON.stringify({
      summary: "one issue",
      findings: [{ file: "src/a.ts", line: "12", severity: "MAJOR", body: "bad" }],
    });
    expect(parseReviewResult(raw).findings[0]).toEqual({
      file: "src/a.ts", line: 12, severity: "major", body: "bad",
    });
  });

  it("drops findings missing a usable file or line rather than posting garbage", () => {
    const raw = JSON.stringify({
      summary: "s",
      findings: [
        { file: "", line: 1, severity: "major", body: "b" },
        { file: "src/a.ts", line: 0, severity: "major", body: "b" },
        { file: "src/a.ts", line: 5, severity: "major", body: "" },
        { file: "src/ok.ts", line: 5, severity: "major", body: "keep" },
      ],
    });
    const out = parseReviewResult(raw);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]!.file).toBe("src/ok.ts");
  });

  it("defaults an unrecognised severity to minor", () => {
    const raw = JSON.stringify({
      summary: "s",
      findings: [{ file: "a.ts", line: 1, severity: "blocker", body: "b" }],
    });
    expect(parseReviewResult(raw).findings[0]!.severity).toBe("minor");
  });

  it("throws a clear error when there is no JSON at all", () => {
    expect(() => parseReviewResult("I could not review this.")).toThrow(/no JSON object/i);
  });

  it("throws when the JSON has no summary", () => {
    expect(() => parseReviewResult('{"findings":[]}')).toThrow(/summary/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/runtime/parse.test.ts`
Expected: FAIL — cannot resolve `../../src/runtime/parse.js`.

- [ ] **Step 3: Append the runtime interface to `src/runtime/types.ts`**

```ts
export interface RuntimeInput {
  /** Fully rendered prompt, including role and PR context. */
  prompt: string;
  /** Directory the PR head is checked out into; the runtime's cwd. */
  workspaceDir: string;
  timeoutMs: number;
}

export interface ReviewRuntime {
  readonly name: string;
  review(input: RuntimeInput): Promise<ReviewResult>;
}
```

- [ ] **Step 4: Implement `src/runtime/parse.ts`**

```ts
import type { Finding, ReviewResult, Severity } from "./types.js";

const SEVERITIES: Severity[] = ["critical", "major", "minor", "nit"];

/** Pull the first balanced top-level JSON object out of arbitrary model text. */
function extractJsonObject(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const haystack = fenced?.[1] ?? raw;
  const start = haystack.indexOf("{");
  if (start === -1) throw new Error("Runtime returned no JSON object");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < haystack.length; i += 1) {
    const ch = haystack[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return haystack.slice(start, i + 1);
    }
  }
  throw new Error("Runtime returned no JSON object (unbalanced braces)");
}

function normaliseSeverity(value: unknown): Severity {
  const lowered = String(value ?? "").toLowerCase();
  return (SEVERITIES as string[]).includes(lowered) ? (lowered as Severity) : "minor";
}

function normaliseFinding(raw: unknown): Finding | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const file = typeof r.file === "string" ? r.file.trim() : "";
  const line = Number.parseInt(String(r.line ?? ""), 10);
  const body = typeof r.body === "string" ? r.body.trim() : "";
  if (!file || !body || Number.isNaN(line) || line < 1) return null;
  return { file, line, severity: normaliseSeverity(r.severity), body };
}

export function parseReviewResult(raw: string): ReviewResult {
  const parsed = JSON.parse(extractJsonObject(raw)) as Record<string, unknown>;
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  if (!summary) throw new Error("Runtime result is missing a non-empty `summary`");
  const findingsRaw = Array.isArray(parsed.findings) ? parsed.findings : [];
  const findings = findingsRaw
    .map(normaliseFinding)
    .filter((f): f is Finding => f !== null);
  return { summary, findings };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/runtime/parse.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: parse and normalise structured review results from model output"
```

---

### Task 10: Claude runtime and runtime factory

**Files:**
- Create: `src/runtime/claude.ts`, `src/runtime/index.ts`
- Test: `tests/runtime/claude.test.ts`

**Interfaces:**
- Consumes: `ReviewRuntime`, `RuntimeInput`, `ReviewResult` from `src/runtime/types.ts`; `parseReviewResult` from `src/runtime/parse.ts`.
- Produces:
  - `ALLOWED_TOOLS: string[]`, `DISALLOWED_TOOLS: string[]`
  - `buildClaudeArgs(prompt: string): string[]`
  - `type ExecFn = (file: string, args: string[], opts: { cwd: string; timeout: number }) => Promise<{ stdout: string }>`
  - `createClaudeRuntime(exec?: ExecFn): ReviewRuntime`
  - `createRuntime(name: "claude" | "codex"): ReviewRuntime` (from `src/runtime/index.ts`)

- [ ] **Step 1: Write the failing test**

`tests/runtime/claude.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { buildClaudeArgs, createClaudeRuntime } from "../../src/runtime/claude.js";
import { createRuntime } from "../../src/runtime/index.js";

const input = { prompt: "review this", workspaceDir: "/ws", timeoutMs: 60_000 };

describe("buildClaudeArgs", () => {
  it("runs headless with JSON output", () => {
    const args = buildClaudeArgs("hello");
    expect(args).toContain("-p");
    expect(args).toContain("hello");
    expect(args.join(" ")).toContain("--output-format json");
  });

  it("permits only read-only tools", () => {
    const joined = buildClaudeArgs("x").join(" ");
    expect(joined).toContain("--allowed-tools");
    expect(joined).toContain("Read");
    expect(joined).toContain("Grep");
    expect(joined).toContain("Glob");
  });

  it("explicitly blocks every mutating tool", () => {
    const joined = buildClaudeArgs("x").join(" ");
    for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      expect(joined).toContain(tool);
    }
    expect(joined).toContain("--disallowed-tools");
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

  it("runs the CLI in the workspace directory with the given timeout", async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ result: '{"summary":"s","findings":[]}' }),
    });
    await createClaudeRuntime(exec).review(input);
    expect(exec).toHaveBeenCalledWith(
      "claude",
      expect.any(Array),
      expect.objectContaining({ cwd: "/ws", timeout: 60_000 }),
    );
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
});

describe("createRuntime", () => {
  it("returns the claude runtime", () => {
    expect(createRuntime("claude").name).toBe("claude");
  });

  it("throws an actionable error for the unimplemented codex seam", () => {
    expect(() => createRuntime("codex")).toThrow(/codex.*not implemented/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/runtime/claude.test.ts`
Expected: FAIL — cannot resolve `../../src/runtime/claude.js`.

- [ ] **Step 3: Implement `src/runtime/claude.ts`**

```ts
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
```

- [ ] **Step 4: Implement `src/runtime/index.ts`**

```ts
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/runtime/claude.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add read-only Claude review runtime behind a ReviewRuntime seam"
```

---

### Task 11: Review orchestrator

**Files:**
- Create: `src/review/run-review.ts`
- Test: `tests/review/run-review.test.ts`

**Interfaces:**
- Consumes: `GitHubClient`, `postReview`, `createWorkspace`, `buildPrompt`, `StateStore`, `prKey`, `ReviewRuntime`, `ResolvedRepo`, `Logger`.
- Produces:
  - `interface ReviewDeps { github: GitHubClient; runtime: ReviewRuntime; state: StateStore; logger: Logger; template: string; token: string; workspaceRoot: string; timeoutMs: number; createWorkspace: typeof createWorkspace; postReview: typeof postReview }`
  - `interface RunReviewOptions { repo: ResolvedRepo; prNumber: number; trigger: "auto" | "manual"; deps: ReviewDeps }`
  - `interface RunReviewOutcome { reviewed: boolean; passNumber: number; findingCount: number; inline: boolean; skippedReason?: string }`
  - `runReview(options: RunReviewOptions): Promise<RunReviewOutcome>`

- [ ] **Step 1: Write the failing test**

`tests/review/run-review.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedRepo } from "../../src/config/schema.js";
import { runReview } from "../../src/review/run-review.js";
import { StateStore } from "../../src/state/store.js";

const repo: ResolvedRepo = {
  owner: "acme", name: "api", fullName: "acme/api",
  role: "Be thorough.", filter: "draft:false",
};

const prDetails = {
  number: 42, title: "Add widget", body: "b", author: "octocat",
  headRef: "feature", headSha: "abc123", baseRef: "main", draft: false,
  changedFiles: ["src/a.ts"], diff: "diff",
};

const result = {
  summary: "one issue",
  findings: [{ file: "src/a.ts", line: 4, severity: "major" as const, body: "bug" }],
};

let dir: string;

async function makeDeps(overrides: Record<string, unknown> = {}) {
  const cleanup = vi.fn().mockResolvedValue(undefined);
  return {
    cleanup,
    deps: {
      github: {
        getPullRequest: vi.fn().mockResolvedValue(prDetails),
        listPriorReviews: vi.fn().mockResolvedValue([]),
        octokit: {} as never,
      },
      runtime: { name: "claude", review: vi.fn().mockResolvedValue(result) },
      state: await StateStore.open(join(dir, "state.json")),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      template: "ROLE={{ROLE}} DIFF={{DIFF}}",
      token: "ghp_x",
      workspaceRoot: join(dir, "ws"),
      timeoutMs: 1000,
      createWorkspace: vi.fn().mockResolvedValue({ dir: "/ws", cleanup }),
      postReview: vi.fn().mockResolvedValue({ inline: true }),
      ...overrides,
    } as never,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "prrun-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("runReview", () => {
  it("checks out, reviews, posts and records the pass", async () => {
    const { deps } = await makeDeps();
    const outcome = await runReview({ repo, prNumber: 42, trigger: "auto", deps });
    expect(outcome).toMatchObject({ reviewed: true, passNumber: 1, findingCount: 1, inline: true });
    expect(deps.postReview).toHaveBeenCalledOnce();
    expect(deps.state.hasBeenReviewed("acme/api#42")).toBe(true);
  });

  it("passes the repo role and prior reviews into the prompt", async () => {
    const { deps } = await makeDeps({
      github: {
        getPullRequest: vi.fn().mockResolvedValue(prDetails),
        listPriorReviews: vi.fn().mockResolvedValue([
          { author: "bot", submittedAt: "2026-01-01", body: "earlier point" },
        ]),
        octokit: {} as never,
      },
    });
    await runReview({ repo, prNumber: 42, trigger: "manual", deps });
    const prompt = (deps.runtime.review as ReturnType<typeof vi.fn>).mock.calls[0]![0].prompt;
    expect(prompt).toContain("Be thorough.");
  });

  it("always cleans up the workspace, even when the runtime throws", async () => {
    const { deps, cleanup } = await makeDeps({
      runtime: { name: "claude", review: vi.fn().mockRejectedValue(new Error("model failed")) },
    });
    await expect(runReview({ repo, prNumber: 42, trigger: "auto", deps })).rejects.toThrow(
      "model failed",
    );
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("does not record a pass when posting fails, so the PR is retried", async () => {
    const { deps } = await makeDeps({
      postReview: vi.fn().mockRejectedValue(new Error("network")),
    });
    await expect(runReview({ repo, prNumber: 42, trigger: "auto", deps })).rejects.toThrow(
      "network",
    );
    expect(deps.state.hasBeenReviewed("acme/api#42")).toBe(false);
  });

  it("skips an auto review of a draft PR but allows a manual one", async () => {
    const draft = { ...prDetails, draft: true };
    const { deps } = await makeDeps({
      github: {
        getPullRequest: vi.fn().mockResolvedValue(draft),
        listPriorReviews: vi.fn().mockResolvedValue([]),
        octokit: {} as never,
      },
    });
    const auto = await runReview({ repo, prNumber: 42, trigger: "auto", deps });
    expect(auto).toMatchObject({ reviewed: false, skippedReason: "draft" });
    expect(deps.postReview).not.toHaveBeenCalled();

    const manual = await runReview({ repo, prNumber: 42, trigger: "manual", deps });
    expect(manual.reviewed).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/review/run-review.test.ts`
Expected: FAIL — cannot resolve `../../src/review/run-review.js`.

- [ ] **Step 3: Implement `src/review/run-review.ts`**

```ts
import type { ResolvedRepo } from "../config/schema.js";
import type { GitHubClient } from "../github/client.js";
import type { postReview as PostReviewFn } from "../github/post-review.js";
import type { Logger } from "../logger.js";
import { buildPrompt } from "../runtime/prompt.js";
import type { ReviewRuntime } from "../runtime/types.js";
import { prKey, type StateStore } from "../state/store.js";
import type { createWorkspace as CreateWorkspaceFn } from "../workspace/checkout.js";

export interface ReviewDeps {
  github: GitHubClient;
  runtime: ReviewRuntime;
  state: StateStore;
  logger: Logger;
  template: string;
  token: string;
  workspaceRoot: string;
  timeoutMs: number;
  createWorkspace: typeof CreateWorkspaceFn;
  postReview: typeof PostReviewFn;
}

export interface RunReviewOptions {
  repo: ResolvedRepo;
  prNumber: number;
  trigger: "auto" | "manual";
  deps: ReviewDeps;
}

export interface RunReviewOutcome {
  reviewed: boolean;
  passNumber: number;
  findingCount: number;
  inline: boolean;
  skippedReason?: string;
}

export async function runReview(options: RunReviewOptions): Promise<RunReviewOutcome> {
  const { repo, prNumber, trigger, deps } = options;
  const ref = { owner: repo.owner, repo: repo.name, number: prNumber };
  const key = prKey(repo.fullName, prNumber);

  const pr = await deps.github.getPullRequest(ref);

  // A draft is not ready for automatic review, but an explicit request wins.
  if (pr.draft && trigger === "auto") {
    deps.logger.info(`Skipping draft PR ${key}`);
    return { reviewed: false, passNumber: 0, findingCount: 0, inline: false, skippedReason: "draft" };
  }

  const priorReviews = await deps.github.listPriorReviews(ref);
  const passNumber = deps.state.passCount(key) + 1;

  const workspace = await deps.createWorkspace({
    owner: repo.owner,
    name: repo.name,
    prNumber,
    baseRef: pr.baseRef,
    token: deps.token,
    rootDir: deps.workspaceRoot,
  });

  try {
    const prompt = buildPrompt(deps.template, {
      role: repo.role,
      repoFullName: repo.fullName,
      passNumber,
      pr,
      priorReviews,
    });
    deps.logger.info(`Reviewing ${key} (pass ${passNumber}, trigger ${trigger})`);
    const result = await deps.runtime.review({
      prompt,
      workspaceDir: workspace.dir,
      timeoutMs: deps.timeoutMs,
    });
    const { inline } = await deps.postReview(deps.github.octokit, ref, pr.headSha, result);
    // Recorded only after a successful post, so a failed post is retried.
    await deps.state.recordPass(key);
    deps.logger.info(
      `Posted review for ${key}: ${result.findings.length} findings (inline=${inline})`,
    );
    return { reviewed: true, passNumber, findingCount: result.findings.length, inline };
  } finally {
    await workspace.cleanup();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/review/run-review.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: orchestrate checkout, review, post and state recording"
```

---

### Task 12: Poller

**Files:**
- Create: `src/poller/poll.ts`
- Test: `tests/poller/poll.test.ts`

**Interfaces:**
- Consumes: `ResolvedRepo`, `buildAutoQuery`, `buildTriggerQuery`, `runReview`, `ReviewDeps`, `StateStore`, `prKey`.
- Produces:
  - `interface PollDeps extends ReviewDeps { triggerPhrase: string; runReview: typeof runReview }`
  - `interface PollSummary { autoReviewed: number; manualReviewed: number; skipped: number; errors: number }`
  - `pollOnce(repos: ResolvedRepo[], deps: PollDeps): Promise<PollSummary>`

- [ ] **Step 1: Write the failing test**

`tests/poller/poll.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedRepo } from "../../src/config/schema.js";
import { pollOnce } from "../../src/poller/poll.js";
import { StateStore } from "../../src/state/store.js";

const repo: ResolvedRepo = {
  owner: "acme", name: "api", fullName: "acme/api",
  role: "r", filter: "draft:false",
};

let dir: string;

async function makeDeps(over: Record<string, unknown> = {}) {
  return {
    github: {
      searchPullRequestNumbers: vi.fn().mockResolvedValue([]),
      listTriggerComments: vi.fn().mockResolvedValue([]),
      octokit: {} as never,
    },
    state: await StateStore.open(join(dir, "state.json")),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    triggerPhrase: "@review-agent review",
    runReview: vi.fn().mockResolvedValue({
      reviewed: true, passNumber: 1, findingCount: 0, inline: true,
    }),
    ...over,
  } as never;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "prpoll-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("pollOnce", () => {
  it("reviews newly discovered PRs and skips ones already reviewed", async () => {
    const deps = await makeDeps({
      github: {
        searchPullRequestNumbers: vi.fn().mockImplementation((q: string) =>
          Promise.resolve(q.includes("in:comments") ? [] : [10, 11]),
        ),
        listTriggerComments: vi.fn().mockResolvedValue([]),
        octokit: {} as never,
      },
    });
    await deps.state.recordPass("acme/api#11");

    const summary = await pollOnce([repo], deps);
    expect(summary.autoReviewed).toBe(1);
    expect(deps.runReview).toHaveBeenCalledOnce();
    expect((deps.runReview as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
      prNumber: 10, trigger: "auto",
    });
  });

  it("uses the auto query for discovery and the trigger query for comments", async () => {
    const search = vi.fn().mockResolvedValue([]);
    const deps = await makeDeps({
      github: { searchPullRequestNumbers: search, listTriggerComments: vi.fn(), octokit: {} as never },
    });
    await pollOnce([repo], deps);
    const queries = search.mock.calls.map((c) => c[0]);
    expect(queries[0]).toBe("repo:acme/api is:pr is:open draft:false");
    expect(queries[1]).toBe('repo:acme/api is:pr is:open "@review-agent review" in:comments');
  });

  it("runs a manual pass for an unprocessed trigger comment and remembers its id", async () => {
    const deps = await makeDeps({
      github: {
        searchPullRequestNumbers: vi.fn().mockImplementation((q: string) =>
          Promise.resolve(q.includes("in:comments") ? [20] : []),
        ),
        listTriggerComments: vi.fn().mockResolvedValue([
          { id: 900, author: "bhanu", createdAt: "2026-01-01", body: "@review-agent review" },
        ]),
        octokit: {} as never,
      },
    });
    const summary = await pollOnce([repo], deps);
    expect(summary.manualReviewed).toBe(1);
    expect((deps.runReview as ReturnType<typeof vi.fn>).mock.calls[0]![0].trigger).toBe("manual");
    expect(deps.state.lastTriggerCommentId("acme/api#20")).toBe(900);
  });

  it("does not re-fire on a trigger comment it has already processed", async () => {
    const deps = await makeDeps({
      github: {
        searchPullRequestNumbers: vi.fn().mockImplementation((q: string) =>
          Promise.resolve(q.includes("in:comments") ? [20] : []),
        ),
        listTriggerComments: vi.fn().mockResolvedValue([
          { id: 900, author: "bhanu", createdAt: "2026-01-01", body: "@review-agent review" },
        ]),
        octokit: {} as never,
      },
    });
    await deps.state.setLastTriggerCommentId("acme/api#20", 900);
    const summary = await pollOnce([repo], deps);
    expect(summary.manualReviewed).toBe(0);
    expect(deps.runReview).not.toHaveBeenCalled();
  });

  it("keeps polling the remaining repos when one PR review throws", async () => {
    const deps = await makeDeps({
      github: {
        searchPullRequestNumbers: vi.fn().mockImplementation((q: string) =>
          Promise.resolve(q.includes("in:comments") ? [] : [10, 11]),
        ),
        listTriggerComments: vi.fn().mockResolvedValue([]),
        octokit: {} as never,
      },
      runReview: vi
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce({ reviewed: true, passNumber: 1, findingCount: 0, inline: true }),
    });
    const summary = await pollOnce([repo], deps);
    expect(summary.errors).toBe(1);
    expect(summary.autoReviewed).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/poller/poll.test.ts`
Expected: FAIL — cannot resolve `../../src/poller/poll.js`.

- [ ] **Step 3: Implement `src/poller/poll.ts`**

```ts
import type { ResolvedRepo } from "../config/schema.js";
import { buildAutoQuery, buildTriggerQuery } from "../github/queries.js";
import type { ReviewDeps, runReview as RunReviewFn } from "../review/run-review.js";
import { prKey } from "../state/store.js";

export interface PollDeps extends ReviewDeps {
  triggerPhrase: string;
  runReview: typeof RunReviewFn;
}

export interface PollSummary {
  autoReviewed: number;
  manualReviewed: number;
  skipped: number;
  errors: number;
}

export async function pollOnce(
  repos: ResolvedRepo[],
  deps: PollDeps,
): Promise<PollSummary> {
  const summary: PollSummary = { autoReviewed: 0, manualReviewed: 0, skipped: 0, errors: 0 };

  for (const repo of repos) {
    // Pass 1 — automatic discovery, gated by the repo's raw filter string.
    try {
      const numbers = await deps.github.searchPullRequestNumbers(buildAutoQuery(repo));
      for (const prNumber of numbers) {
        const key = prKey(repo.fullName, prNumber);
        if (deps.state.hasBeenReviewed(key)) {
          summary.skipped += 1;
          continue;
        }
        try {
          const outcome = await deps.runReview({ repo, prNumber, trigger: "auto", deps });
          if (outcome.reviewed) summary.autoReviewed += 1;
          else summary.skipped += 1;
        } catch (error) {
          summary.errors += 1;
          deps.logger.error(`Auto review failed for ${key}: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      summary.errors += 1;
      deps.logger.error(`Auto discovery failed for ${repo.fullName}: ${(error as Error).message}`);
    }

    // Pass 2 — manual triggers. Deliberately ignores the filter.
    try {
      const numbers = await deps.github.searchPullRequestNumbers(
        buildTriggerQuery(repo, deps.triggerPhrase),
      );
      for (const prNumber of numbers) {
        const key = prKey(repo.fullName, prNumber);
        try {
          const comments = await deps.github.listTriggerComments(
            { owner: repo.owner, repo: repo.name, number: prNumber },
            deps.triggerPhrase,
          );
          const seen = deps.state.lastTriggerCommentId(key);
          const newest = comments.reduce((max, c) => Math.max(max, c.id), 0);
          if (newest <= seen) continue;
          await deps.runReview({ repo, prNumber, trigger: "manual", deps });
          await deps.state.setLastTriggerCommentId(key, newest);
          summary.manualReviewed += 1;
        } catch (error) {
          summary.errors += 1;
          deps.logger.error(`Manual review failed for ${key}: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      summary.errors += 1;
      deps.logger.error(
        `Trigger discovery failed for ${repo.fullName}: ${(error as Error).message}`,
      );
    }
  }

  return summary;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/poller/poll.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add poll cycle with auto discovery and trigger-comment passes"
```

---

### Task 13: CLI and service loop

**Files:**
- Create: `src/cli.ts`, `src/index.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `buildDeps(options: { configPath: string; statePath: string; workspaceRoot: string; timeoutMs: number }): Promise<{ config: AppConfig; repos: ResolvedRepo[]; deps: PollDeps }>`
  - `runOnce(deps, repos): Promise<PollSummary>`
  - `runLoop(deps, repos, intervalMinutes, signal: AbortSignal): Promise<void>`
  - `buildProgram(): Command` — commander program with `run`, `poll-once`, `review --repo <owner/name> --pr <number>`.

- [ ] **Step 1: Write the failing test**

`tests/cli.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { buildProgram, runLoop } from "../src/cli.js";

describe("buildProgram", () => {
  it("exposes run, poll-once and review commands", () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names).toEqual(expect.arrayContaining(["run", "poll-once", "review"]));
  });

  it("requires --repo and --pr on the review command", () => {
    const review = buildProgram().commands.find((c) => c.name() === "review")!;
    const flags = review.options.map((o) => o.flags).join(" ");
    expect(flags).toContain("--repo");
    expect(flags).toContain("--pr");
  });
});

describe("runLoop", () => {
  it("polls repeatedly until aborted", async () => {
    const controller = new AbortController();
    let calls = 0;
    const poll = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls >= 3) controller.abort();
      return { autoReviewed: 0, manualReviewed: 0, skipped: 0, errors: 0 };
    });
    await runLoop({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as never, [], {
      intervalMs: 1,
      signal: controller.signal,
      poll,
    });
    expect(calls).toBe(3);
  });

  it("keeps looping after a poll cycle throws", async () => {
    const controller = new AbortController();
    let calls = 0;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const poll = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls >= 2) controller.abort();
      throw new Error("cycle blew up");
    });
    await runLoop({ logger } as never, [], { intervalMs: 1, signal: controller.signal, poll });
    expect(calls).toBe(2);
    expect(logger.error).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/cli.test.ts`
Expected: FAIL — cannot resolve `../src/cli.js`.

- [ ] **Step 3: Implement `src/cli.ts`**

```ts
import { Command } from "commander";
import { loadConfig } from "./config/load.js";
import { resolveRepos, type ResolvedRepo } from "./config/schema.js";
import { GitHubClient } from "./github/client.js";
import { postReview } from "./github/post-review.js";
import { createLogger } from "./logger.js";
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

export async function buildDeps(): Promise<{ repos: ResolvedRepo[]; deps: PollDeps; intervalMs: number }> {
  const configPath = process.env.CONFIG_PATH ?? "./config/repos.yaml";
  const statePath = process.env.STATE_PATH ?? "./state/state.json";
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? "./workspaces";
  const token = requireEnv("GITHUB_TOKEN");
  requireEnv("ANTHROPIC_API_KEY");

  const config = await loadConfig(configPath);
  const deps: PollDeps = {
    github: GitHubClient.fromToken(token),
    runtime: createRuntime(config.runtime),
    state: await StateStore.open(statePath),
    logger: createLogger("agent"),
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
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
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
      deps.logger.error(`Poll cycle failed: ${(error as Error).message}`);
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
      const { repos, deps } = await buildDeps();
      const repo = repos.find((r) => r.fullName === opts.repo);
      if (!repo) {
        throw new Error(
          `Repo ${opts.repo} is not in the config. Configured repos: ${repos.map((r) => r.fullName).join(", ")}`,
        );
      }
      const prNumber = Number.parseInt(opts.pr, 10);
      if (Number.isNaN(prNumber)) throw new Error(`--pr must be a number, got: ${opts.pr}`);
      const outcome = await runReview({ repo, prNumber, trigger: "manual", deps });
      deps.logger.info("Review complete", { ...outcome });
    });

  return program;
}
```

- [ ] **Step 4: Implement `src/index.ts`**

```ts
#!/usr/bin/env node
import "dotenv/config";
import { buildProgram } from "./cli.js";

buildProgram()
  .parseAsync(process.argv)
  .catch((error: unknown) => {
    console.error(`Fatal: ${(error as Error).message}`);
    process.exitCode = 1;
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/cli.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Verify the whole suite and the build**

Run: `npm test && npm run build`
Expected: all suites PASS, `tsc` completes with no errors and emits `dist/`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add CLI with run, poll-once and one-shot review commands"
```

---

### Task 14: Packaging and deployment docs

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `docs/windows-service.md`, `README.md`

**Interfaces:**
- Consumes: `npm run build`, `dist/index.js` entry point, env vars from Task 1's `.env.example`.
- Produces: no code interfaces — deployment artefacts only.

- [ ] **Step 1: Write `.dockerignore`**

```
node_modules
dist
.git
.env
state
workspaces
*.log
```

- [ ] **Step 2: Write the `Dockerfile`**

```dockerfile
FROM node:24-bookworm-slim

# git is required to check out PR heads; gh backs the agent's read-only
# `gh pr view` / `gh pr diff` commands; ca-certificates for HTTPS clones.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl gnupg \
 && mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# The review runtime shells out to the Claude Code CLI.
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

COPY agent ./agent

ENV CONFIG_PATH=/app/config/repos.yaml \
    STATE_PATH=/app/state/state.json \
    WORKSPACE_ROOT=/tmp/workspaces

CMD ["node", "dist/index.js", "run"]
```

- [ ] **Step 3: Write `docker-compose.yml`**

```yaml
services:
  pr-review-agent:
    build: .
    restart: unless-stopped
    env_file: .env
    volumes:
      # Config is read-only to the container; state must persist across restarts.
      - ./config:/app/config:ro
      - ./state:/app/state
```

- [ ] **Step 4: Verify the image definition as far as this machine allows**

Docker is **not installed** on this dev machine, so `docker build` cannot be run here.

Run: `node -e "const t=require('fs').readFileSync('Dockerfile','utf8'); for (const s of ['git','gh','@anthropic-ai/claude-code','npm run build','dist/index.js']) { if (!t.includes(s)) throw new Error('Dockerfile missing: '+s); } console.log('Dockerfile content checks passed');"`
Expected: `Dockerfile content checks passed`.

Then record explicitly in the commit message that `docker build` verification is deferred to a machine with Docker. Do **not** claim the image builds.

- [ ] **Step 5: Write `docs/windows-service.md`**

```markdown
# Running as a Windows Service (NSSM)

The agent is a plain Node process, so NSSM can supervise it directly — no
Docker required on Windows.

## 1. Build

```powershell
npm ci
npm run build
```

## 2. Verify it works interactively first

```powershell
node dist/index.js poll-once
```

Fix any config or credential errors before installing the service. A service
that fails at startup is much harder to diagnose than a foreground run.

## 3. Install NSSM

Download from https://nssm.cc/download and put `nssm.exe` on your PATH.

## 4. Install the service

```powershell
nssm install PrReviewAgent "C:\Program Files\nodejs\node.exe" "D:\bhanu\myprojects\github-pr-review-agent\dist\index.js" run
nssm set PrReviewAgent AppDirectory "D:\bhanu\myprojects\github-pr-review-agent"
nssm set PrReviewAgent AppStdout "D:\bhanu\myprojects\github-pr-review-agent\logs\agent.log"
nssm set PrReviewAgent AppStderr "D:\bhanu\myprojects\github-pr-review-agent\logs\agent.err.log"
nssm set PrReviewAgent AppRotateFiles 1
nssm set PrReviewAgent Start SERVICE_AUTO_START
```

## 5. Provide secrets

The service does not inherit your interactive shell's environment. Either
keep the `.env` file in `AppDirectory` (it is loaded at startup), or set the
variables on the service itself:

```powershell
nssm set PrReviewAgent AppEnvironmentExtra GITHUB_TOKEN=ghp_xxx ANTHROPIC_API_KEY=sk-ant-xxx
```

## 6. Start and check

```powershell
nssm start PrReviewAgent
nssm status PrReviewAgent
Get-Content .\logs\agent.log -Tail 50 -Wait
```

## 7. Update after a code change

```powershell
npm run build
nssm restart PrReviewAgent
```

## Removing

```powershell
nssm stop PrReviewAgent
nssm remove PrReviewAgent confirm
```
```

- [ ] **Step 6: Write `README.md`**

```markdown
# GitHub PR Review Agent

Polls preconfigured GitHub repositories and reviews newly-opened pull
requests with a per-repo role, posting findings as inline PR comments.

## How it works

1. Every `pollIntervalMinutes`, the service runs one GitHub Search API query
   per repo: `repo:<owner>/<name> is:pr is:open <your raw filter>`. Filtering
   happens server-side — the `filter` field is raw GitHub search syntax.
2. Any PR not already in the local state file is shallow-cloned at its head
   commit into a scratch directory.
3. Headless Claude Code (`claude -p --output-format json`) reviews it there
   with **read-only** tools, returning `{ summary, findings[] }`.
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

`GITHUB_TOKEN` needs the `repo` scope. `ANTHROPIC_API_KEY` is mandatory: the
service runs unattended and cannot use an interactive Claude login.

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

## Configuration

See `config/repos.example.yaml`. Per-repo `role` and `filter` each fully
replace the shared default when present.

## Runtimes

`runtime: claude` is implemented. `runtime: codex` is a declared seam that
throws until its adapter is written — for Codex-based review today, use
Codex's own GitHub App with `## Code Review Rules` in the repo's `AGENTS.md`.

## Deployment

- **Docker:** `docker compose up -d --build` (mounts `./config` read-only and
  persists `./state`).
- **Windows Service:** see `docs/windows-service.md`.
```

- [ ] **Step 7: Run the full suite one final time**

Run: `npm test`
Expected: all suites PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "docs: add Dockerfile, compose, Windows service guide and README

Dockerfile is content-checked only; docker build is unverified because
Docker is not installed on this machine."
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
| --- | --- |
| Polling every 10 min, configurable | 2 (config + env override), 13 (`runLoop`) |
| Newly-opened PRs via Search API | 4, 5, 12 |
| Raw per-repo filter string, server-side | 2, 4, 12 |
| Global default filter merged with per-repo | 2 (`resolveRepos`) |
| Local state store, no duplicate reviews on restart | 3, 11, 12 |
| PR comment trigger phrase | 4, 5, 12 |
| CLI one-shot review command | 13 |
| Manual triggers bypass the filter | 4 (`buildTriggerQuery` ignores filter), 11 (draft bypass), 13 |
| Prior reviews as context for later passes | 5, 8, 11 |
| Per-repo role config | 2, 8, 11 |
| `runtime: claude \| codex`, codex throws | 2, 10 |
| GitHub PAT auth | 5, 13 |
| `ANTHROPIC_API_KEY` required for unattended runs | 10, 13 |
| Native agent definition invoked headlessly | 8, 10 |
| Clone + checkout PR head into scratch dir | 7, 11 |
| Read-only tools enforced by flags | 10 |
| `ReviewRuntime` seam, Claude only | 9, 10 |
| Structured findings with severity | 6, 9 |
| Inline comments, always `event: COMMENT` | 6 |
| Dockerfile with git + gh | 14 |
| Windows Service via NSSM | 14 |
| Secrets via gitignored `.env` | 1, 14 |

No gaps found.

**Placeholder scan:** no TBDs, no "add error handling" steps, no "similar to Task N". Every code step carries runnable code.

**Type consistency:** `ReviewResult`/`Finding`/`Severity` are declared once in Task 6 (`src/runtime/types.ts`) and extended in Task 9 with `RuntimeInput`/`ReviewRuntime` — used consistently by Tasks 6, 9, 10, 11. `PullRequestRef`/`PullRequestDetails`/`PriorReview`/`TriggerComment` are declared in Task 5 and consumed unchanged by Tasks 6, 8, 11. `ResolvedRepo` from Task 2 is consumed by Tasks 4, 11, 12, 13. `prKey` from Task 3 is used identically in Tasks 11 and 12. `ReviewDeps` (Task 11) is extended by `PollDeps` (Task 12) and constructed in Task 13.

**Known deferrals, stated rather than hidden:**
- `docker build` is unverified — Docker is not installed on this machine (Task 14 Step 4).
- The Claude runtime's real end-to-end behaviour (an actual `claude -p` invocation against a real PR) is exercised only via injected fakes in tests; the first real run is `node dist/index.js poll-once` against a live repo, per the README.
