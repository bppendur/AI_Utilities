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

> **Only run this against a state file nothing else is using.** `state.json`
> has no locking — see "Run exactly one instance per state file" below. Do
> **not** run this `poll-once` check while `PrReviewAgent` is already
> started (step 6) and pointed at the same `STATE_PATH`; run it before first
> install, or stop the service first (`nssm stop PrReviewAgent`) if you're
> re-verifying later.

## 3. Install NSSM

Download from https://nssm.cc/download and put `nssm.exe` on your PATH.

## 4. Install the service

Replace the install path below with the actual location of your checkout.

```powershell
nssm install PrReviewAgent "C:\Program Files\nodejs\node.exe" "C:\path\to\github-pr-review-agent\dist\index.js" run
nssm set PrReviewAgent AppDirectory "C:\path\to\github-pr-review-agent"
nssm set PrReviewAgent AppStdout "C:\path\to\github-pr-review-agent\logs\agent.log"
nssm set PrReviewAgent AppStderr "C:\path\to\github-pr-review-agent\logs\agent.err.log"
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

`ANTHROPIC_API_KEY` is mandatory here: the service runs unattended and has
no way to fall back to an interactive `claude login`. `GITHUB_TOKEN` needs
the `repo` scope.

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

## Run exactly one instance per state file

`state/state.json` has no file locking. If two processes (two NSSM services,
or a service plus a manual `poll-once`/`run`) point at the same state file
at the same time, each holds its own full copy of it in memory and whichever
writes last wins — silently losing the other's recorded passes and
trigger-comment markers. In practice this causes duplicate reviews posted to
the same real PR. Make sure exactly one `PrReviewAgent` service (and no
stray foreground process) is ever running against a given `STATE_PATH` at
once. If you need a second, independent instance (e.g. a second set of
repos), give it its own `STATE_PATH`, `WORKSPACE_ROOT`, and NSSM service
name.

## Notes on the agent's runtime environment

The service also requires `git` and the Claude Code CLI (`claude`) to be on
the service account's `PATH` — `git` because the harness itself shells out
to it to check out each PR head (`src/workspace/checkout.ts`), and `claude`
because the review runtime invokes `claude -p --output-format json`
headlessly (`src/runtime/claude.ts`). NSSM services often run under a
different account/profile than your interactive shell, so a `PATH` that
works when you run `node dist/index.js poll-once` manually does not
automatically apply to the service — verify both binaries resolve under the
account NSSM uses, or set an explicit `PATH` via `AppEnvironmentExtra`.
