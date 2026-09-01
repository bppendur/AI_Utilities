FROM node:24-bookworm-slim

# git is required because the harness itself shells out to `git` to shallow
# clone/checkout PR heads (src/workspace/checkout.ts) — this is NOT the
# review agent running git, it's the Node process doing the checkout before
# the agent ever starts. ca-certificates for HTTPS clones.
#
# `gh` is deliberately NOT installed. An earlier design let the reviewing
# agent explore with read-only `gh`/`git` Bash commands; that was removed
# (see src/runtime/claude.ts) after a reviewer showed `git diff
# --output=<file>` is an arbitrary-file-write primitive reachable from
# attacker-controlled PR content. The agent's tool surface today is exactly
# `Read`, `Grep`, `Glob` with a blanket `Bash` deny, so it can never invoke
# `gh` (or any other CLI) — installing it would just be dead weight in the
# image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# The review runtime shells out to the Claude Code CLI.
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# DEFAULT_TEMPLATE_PATH (src/runtime/prompt.ts) resolves `agent/` relative to
# the compiled module's own directory (`dist/runtime/../../agent`), so
# `agent/` must sit beside `dist/` in the image, not just in the repo.
COPY agent ./agent

ENV CONFIG_PATH=/app/config/repos.yaml \
    STATE_PATH=/app/state/state.json \
    WORKSPACE_ROOT=/tmp/workspaces

CMD ["node", "dist/index.js", "run"]
