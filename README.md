# 🧭 Compass

[![Tests](https://github.com/raja-jamwal/compass/actions/workflows/test.yml/badge.svg)](https://github.com/raja-jamwal/compass/actions/workflows/test.yml)
[![Publish to npm](https://github.com/raja-jamwal/compass/actions/workflows/publish.yml/badge.svg)](https://github.com/raja-jamwal/compass/actions/workflows/publish.yml)
[![npm version](https://img.shields.io/npm/v/compass-agent)](https://www.npmjs.com/package/compass-agent)

Bring workforce of Claude Codes to your Slack workspace. Every thread becomes an isolated coding session — with its own working directory, git worktree, and full access to your local filesystem. Claude runs on your machine, streams responses in real-time, and your whole team can use it simultaneously without conflicts.

![Agentic task visualization with sub-agents](docs/assets/sub-agent.png)

## Quick start

```bash
bunx compass-agent
```

That's it. The bot connects via Socket Mode — no servers, no ngrok, no cloud deployment. See [Setup](#setup) for first-time configuration.

## How it works

```
You (Slack thread) → Bot (Socket Mode) → Claude CLI (local) → Your filesystem
```

The bot runs locally using Slack's Socket Mode. When you message it, it spawns a `claude` CLI process, streams output back to Slack in real-time, and maintains session continuity across messages. Each thread is an isolated session with its own working directory, session ID, and git worktree.

## Features

### Per-thread sessions

Every thread is an independent Claude session. Subsequent messages in the same thread resume the conversation with full context.

1. First message creates a new Claude session
2. `system.init` stores the session ID in SQLite
3. Follow-up messages use `--resume <session_id>` to continue

### `$cwd` — Working directory

Set the working directory for Claude to read/write files.

| Command | Description |
|---------|-------------|
| `$cwd` | Opens an interactive picker with recent directories |
| `$cwd /path/to/project` | Sets the directory directly |

The picker remembers previously used directories. CWD is stored per-thread in SQLite.

![Working directory set in channel](docs/assets/streaming-feedback.png)

### `$teach` — Team knowledge base

Store team conventions that get injected into every Claude session across your workspace.

| Command | Description |
|---------|-------------|
| `$teach <instruction>` | Adds a new convention |
| `$teach list` | Lists all active teachings with IDs |
| `$teach remove <id>` | Removes a teaching by ID |

```
$teach Use TypeScript for all new files
$teach Always write tests before implementation
$teach Use pnpm instead of npm
```

These appear in Claude's system prompt as:

```
Team conventions:
- Use TypeScript for all new files
- Always write tests before implementation
```

### Streaming responses

Responses stream token-by-token using Slack's native `chatStream` API, with automatic fallback to throttled `chat.update` calls if streaming isn't available.

Tool calls are visualized as an agentic timeline — each invocation (file reads, edits, shell commands) appears as a step that progresses from in-progress to complete.

![Streaming response with planning and sub-agents](docs/assets/planning-streaming.png)

### Git worktree isolation

When the CWD is inside a git repo, the bot automatically creates a worktree for each thread. Parallel threads can make code changes without conflicting with each other or your main working tree.

1. First message detects if CWD is in a git repo
2. Creates a worktree at `<repo>/trees/slack-<thread_ts>` on branch `slack/<thread_ts>`
3. Copies `.env` files from the main repo
4. Claude runs in the worktree instead of the raw CWD
5. Subsequent messages reuse the existing worktree

An hourly cleanup job removes worktrees idle for 24+ hours, skipping any with active processes or uncommitted changes. If the CWD is not a git repo, Claude runs directly in it.

### More features

- **Stop button** — Every response includes a red Stop button that sends `SIGTERM` to Claude. Partial responses are preserved.
- **App Home dashboard** — Live stats (active sessions, teachings, worktrees), recent sessions with status indicators, usage logs with cost tracking, and quick actions for managing teachings.
- **Usage logging** — Every invocation logs session, user, model, tokens, cost, duration, and turns to SQLite. Powers the dashboard's "Recent Activity" section.
- **User whitelist** — Set `ALLOWED_USERS` in `.env` to restrict access by Slack user ID.

## Setup

### Prerequisites

- [Bun](https://bun.sh) runtime
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- A Slack workspace where you can create apps

### 1. Create the Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click "Create New App"
2. Choose "From an app manifest" and paste the contents of `manifest.yml`
3. Install the app to your workspace
4. Under **Settings > Basic Information**, generate an App-Level Token with `connections:write` scope — this is your `SLACK_APP_TOKEN` (starts with `xapp-`)
5. Under **OAuth & Permissions**, copy the Bot User OAuth Token — this is your `SLACK_BOT_TOKEN` (starts with `xoxb-`)

### 2. Configure environment

```bash
mkdir -p ~/.compass
cat > ~/.compass/.env << 'EOF'
SLACK_APP_TOKEN=xapp-1-...
SLACK_BOT_TOKEN=xoxb-...
ALLOWED_USERS=U096GJFBZ54
EOF
```

### 3. Run

```bash
bunx compass-agent
```

You can also point to a specific env file:

```bash
bunx compass-agent --env-file /path/to/.env
```

Or pass tokens directly:

```bash
SLACK_APP_TOKEN=xapp-... SLACK_BOT_TOKEN=xoxb-... bunx compass-agent
```

#### Running from source

```bash
git clone https://github.com/raja-jamwal/compass.git
cd compass
cp .env.example .env   # edit with your tokens
bun install
bun start
```

#### Environment loading precedence

1. Real environment variables (highest)
2. `--env-file <path>`
3. `~/.compass/.env`
4. Local `.env` in the current directory (lowest)

### 4. Verify

1. Open the app in Slack (find it in the Apps section)
2. Go to the **Home** tab — you should see the dashboard
3. Start a new thread in the **Messages** tab
4. Send `$cwd /path/to/your/project`
5. Send a question — Claude should respond with streaming text

## Architecture

```
src/
  app.ts                 Entry point — Bolt app, actions, modals, App Home, startup
  db.ts                  SQLite schema and typed prepared statements (bun:sqlite)
  types.ts               Shared TypeScript interfaces
  handlers/
    assistant.ts         Thread lifecycle — session management, commands, message routing
    stream.ts            Claude CLI streaming — NDJSON parsing, tool timeline, usage logging
  ui/
    blocks.ts            Block Kit builders — dashboard, stop button, feedback, prompts
  lib/
    log.ts               Structured logging helpers
    worktree.ts          Git worktree lifecycle (create, remove, detect, cleanup)
  mcp/
    server.ts            MCP server — reminders, teachings, channel CWD tools
manifest.yml             Slack app manifest (scopes, events, features)
sessions.db              SQLite database (auto-created on first run)
```

### Message flow

```
Slack message (Socket Mode)
  → Auth check (subtype, bot, allowed user)
  → Command check ($cwd, $teach)
  → Concurrency check (one process per thread)
  → Session lookup (resume or create)
  → CWD gate
  → Worktree setup (detect git, create/reuse)
  → Post "Thinking..." with Stop button
  → Start chatStream (or fallback to chat.update)
  → Spawn claude CLI with team teachings
  → Parse NDJSON stream (init, text_delta, tool calls, result)
  → Stream to Slack in real-time
  → Finalize: log usage, clean up stop button
```

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_APP_TOKEN` | Yes | App-level token (`xapp-...`) for Socket Mode |
| `SLACK_BOT_TOKEN` | Yes | Bot user OAuth token (`xoxb-...`) |
| `ALLOWED_USERS` | No | Comma-separated Slack user IDs to whitelist |
| `CLAUDE_PATH` | No | Path to the `claude` binary (defaults to `claude` in PATH) |
| `CLAUDE_ADDITIONAL_ARGS` | No | Extra CLI args appended to every `claude` invocation |
| `ENV_*` | No | Variables prefixed with `ENV_` are injected into Claude's environment (e.g. `ENV_ANTHROPIC_API_KEY=sk-...` sets `ANTHROPIC_API_KEY`) |
