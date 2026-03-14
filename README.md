# OpenClaw Docker Runner

**English** | [简体中文](README_CN.md)

Docker-first execution plane for OpenClaw-compatible agents. The control plane can run locally in Docker or on a remote server, while the runner executes on the host that actually owns the CLI, files, shell, and local session state.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen)](https://nodejs.org/)

## Tested Environment

- MacBook Air M4
- macOS
- Node.js
- Docker
- Local Claude Code with OAuth
- OpenClaw bot running in Docker or on a cloud host
- Local runner running on the author's Mac

## Project Positioning

This repository should not be described as "just a polling worker".

The intended product shape is:

- Docker-first control plane
- Host-side runner with real file and CLI access
- Hook-accelerated bot callback delivery
- Reconciler loop for task pickup, recovery, and audit-safe fallback

Practical deployment story:

- Run the control plane in local Docker when you want a self-hosted setup on one machine
- Run the control plane on a remote server when you want cloud-hosted orchestration
- Keep the runner on the machine that actually has Claude Code, Codex, Gemini, files, shell, and browser context

Long polling is still used as transport for task pickup, but it is no longer the primary product story.

Recent productized additions:

- SQLite-backed task queue and result store so pending work survives Task API restarts
- SQLite-backed active session store with read-only session stats and state APIs
- SQLite-backed event log with `/events` query API for recent task and bot-callback lifecycle
- A runner-side provider cache with explicit env-configurable path and retention
- `/tasks/stats` for queue visibility and persisted result counts
- `/sessions/stats` and `/sessions/state` for active CLI session visibility
- `/events/stats` and `/events/maintenance` for retention, vacuum, and audit-facing event ops
- clearer `task.created / task.started / task.completed / task.failed / callback.*` event trail
- `task.reconciled` when a client actually consumes a finished task result
- reconciler naming in scripts and runtime logs, while keeping legacy endpoints for compatibility

## Product Lineage

- `openclaw-cli-pipeline` is archived and should be treated as historical protocol design
- Its multi-turn orchestration model is now absorbed by [`openclaw-cli-bridge`](https://github.com/AliceLJY/openclaw-cli-bridge)
- This repository remains the execution plane: Task API, local runner, reconciler loop, and bot callback delivery

## Compatibility Notes

- The server side is relatively generic.
- The Worker side is primarily tested on macOS.
- Some features assume a macOS shell, a Keychain-adjacent local Claude workflow, and the Claude local session layout on the author's machine.
- The core architecture is portable in principle, but the author's production-tested setup is macOS plus Docker plus local Claude Code.
- Linux and Windows are not the author's primary tested path.

## Architecture Assumptions

- `task-api` and `worker` are separate processes.
- The bot can run in Docker or in the cloud.
- The Worker runs on the local machine that actually has file access and local CLI tools.
- Callback delivery may rely on Docker container access, depending on your topology.
- The main Worker flow executes shell commands through `/bin/zsh -l -c`.
- Claude session recovery assumes a local `~/.claude/projects/...` storage layout.
- Task API session state is persisted in the SQLite task store, while the runner keeps a local provider cache at `/tmp/openclaw-runner-session-cache.json` by default.
- The default working directory for execution is `$HOME`.

## Prerequisites

- Node.js
- A strong `WORKER_TOKEN`
- One machine that can run `server.js` and one machine that can run `worker.js` if you use the split deployment
- Optional Docker if you want the documented Docker topology
- Local Claude Code / Codex / Gemini installs on the Worker machine if you want local AI CLI execution
- A local shell environment compatible with the current Worker assumptions (`/bin/zsh -l -c`)

## Known Limits

- Session assumptions are tied to the author's local CLI storage layout.
- Callback behavior may depend on the author's Docker topology and mounted Docker socket.
- This is not a turnkey enterprise-grade distributed queue.
- Worker-side Claude Code integration is primarily tested on the author's local Mac workflow.

## What It Does

OpenClaw Docker Runner adds a safe execution boundary between an OpenClaw-compatible control plane and the machine that owns real local capability:

- A client or bot submits tasks to `server.js`
- The runner pulls work through a reconciler loop
- The runner executes commands or local AI CLI tasks on the host machine
- Results are sent back to the Task API
- Optional callbacks can push completion messages back to the bot side with hook-first delivery
- Recent lifecycle events stay queryable through the Task API for debugging and audit

```text
Client / Bot / OpenClaw -> Task API -> Host Runner / Reconciler -> Local CLI / Files / Browser / Claude Code
```

## Deployment Modes

| Mode | What runs where | Notes |
|------|------------------|-------|
| Docker Local | OpenClaw and Task API in Docker on the same machine, runner on the host | Best “all on one machine” developer setup |
| Docker + Remote Runner | OpenClaw and Task API in Docker, runner on another host | Best fit when Docker is the product shell but execution must stay near the real machine |
| Cloud + Remote Runner | `server.js` on a cloud host, `worker.js` on the machine with the actual CLI and files | Main remote-control pattern |
| Single Host | `server.js` directly on a host, runner on the same or another host | Possible, but not the primary product story |

Docs:

- [Docker local guide](docs/docker-local.md)
- [Docker local guide (中文)](docs/docker-local.zh.md)
- [Deployment notes](docs/deployment.md)
- [Architecture notes](docs/architecture.md)
- [Claude Code integration](docs/claude-code-integration.md)
- [Security guide](docs/security-guide.md)

## Source-Level Assumptions

These are not theoretical. They are encoded in the current implementation:

- `worker.js` identifies itself as a local Mac Worker.
- `worker.js` executes commands through `/bin/zsh -l -c`.
- `worker.js` resolves Claude sessions under `~/.claude/projects/-Users-<home-name>/`.
- `worker.js` keeps a local provider-session cache in `/tmp/openclaw-runner-session-cache.json` by default.
- `worker.js` defaults `cwd` to `$HOME`.
- `docker/docker-compose.yml` mounts `~/.claude/projects`, `~/.codex/sessions`, and `/var/run/docker.sock`.
- [examples/macos-startup.command](examples/macos-startup.command) starts the Worker with `screen` plus `node worker.js`.

## Quick Start

### 1. Run the Task API

```bash
cd openclaw-worker
npm install
export WORKER_TOKEN="$(openssl rand -hex 32)"
npm run task-api
```

### 2. Start the local runner

```bash
export WORKER_URL="http://YOUR_SERVER_IP:3456"
export WORKER_TOKEN="YOUR_TOKEN"
npm run runner
```

### 3. Or use the Docker setup

```bash
cd docker
docker compose up -d
```

This Docker topology expects host mounts for local session data and whatever callback bridge access your bot side needs. The Docker side is the control plane; the runner side remains the execution plane whether that runner is on the same machine or a remote host.

### 4. Run the smoke test

```bash
npm test
# or
npm run smoke:task-api
npm run smoke:notify
```

This verifies the highest-risk Task API recovery paths:

- pending tasks survive a Task API restart
- stale `running` tasks are requeued to `pending` on restart
- successful and failed task results both emit the expected event lifecycle
- tasks sharing the same CLI session are serialized instead of running concurrently
- `/notify` can forward to a callback-compatible bot API (the smoke test uses a Discord-compatible mock) and correctly surfaces upstream failures

`npm test` is the CI entrypoint and currently runs the same smoke script. `npm run test:tool` keeps the older manual `mac_remote` tool check available for ad hoc testing.

For local smoke tests, the callback target is injectable through `CALLBACK_API_BASE_URL` (legacy `DISCORD_API_BASE_URL` still works). The callback identity can be provided via `CALLBACK_BOT_TOKEN`, with `DISCORD_BOT_TOKEN` kept as a backward-compatible fallback.

## Repository Layout

```text
openclaw-worker/
├── README.md
├── README_CN.md
├── server.js
├── worker.js
├── docker/
│   └── docker-compose.yml
├── docs/
│   ├── architecture.md
│   ├── background.md
│   ├── claude-code-integration.md
│   ├── deployment.md
│   ├── docker-local.md
│   ├── docker-local.zh.md
│   └── security-guide.md
└── examples/
    └── macos-startup.command
```

## Security Model

- No inbound connection to the local runner is required.
- The reconciler loop pulls from the Task API instead of exposing a shell directly to the internet.
- Authentication is token-based.
- The queue provides an audit boundary between bot-side orchestration and local execution.
- The security model is still only as strong as your local runner permissions and deployment hygiene.

## Event API

Recent lifecycle events are available through the Task API:

```bash
curl -H "Authorization: Bearer $WORKER_TOKEN" \
  "http://localhost:3456/events?limit=50"
```

Event stats:

```bash
curl -H "Authorization: Bearer $WORKER_TOKEN" \
  "http://localhost:3456/events/stats"
```

Manual maintenance:

```bash
curl -X POST -H "Authorization: Bearer $WORKER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"vacuum": true}' \
  "http://localhost:3456/events/maintenance"
```

Default event database:

```text
/tmp/openclaw-runner-events.db
```

Override with:

```bash
WORKER_EVENT_DB=/path/to/openclaw-runner-events.db
WORKER_EVENT_RETENTION_DAYS=14
WORKER_MAX_EVENTS=2000
```

Useful filters:

- `taskId`
- `type`

Common event types:

- `task.created`
- `task.started`
- `task.completed`
- `task.failed`
- `task.reconciled`
- `callback.dispatched`
- `callback.sent`
- `callback.failed`

## Task Store

Task queue state and unfetched results are now persisted in SQLite:

```bash
curl -H "Authorization: Bearer $WORKER_TOKEN" \
  "http://localhost:3456/tasks/stats"
```

Default task database:

```text
/tmp/openclaw-runner-tasks.db
```

Override with:

```bash
WORKER_TASK_DB=/path/to/openclaw-runner-tasks.db
WORKER_TASK_RETENTION_MS=1200000
WORKER_RESULT_RETENTION_MS=1800000
```

Behavior notes:

- Pending tasks and unfetched results survive Task API restarts
- Stale `running` tasks are reset to `pending` on Task API boot
- Results are removed after they are fetched or when retention cleanup expires them

## Session Store

Active CLI sessions are now persisted in the same SQLite task database:

```bash
curl -H "Authorization: Bearer $WORKER_TOKEN" \
  "http://localhost:3456/sessions/stats"

curl -H "Authorization: Bearer $WORKER_TOKEN" \
  "http://localhost:3456/sessions/state?limit=50"
```

Override session retention with:

```bash
WORKER_SESSION_RETENTION_MS=1800000
RUNNER_SESSION_CACHE_FILE=/path/to/openclaw-runner-session-cache.json
RUNNER_SESSION_RETENTION_MS=1800000
```

Behavior notes:

- Active session state survives Task API restarts
- `/claude/sessions` now reads from the persisted session store
- Expired sessions are trimmed by retention cleanup
- The runner also keeps a local provider cache for resume mapping and provider-specific session recovery

## Author

Built by **小试AI** ([@AliceLJY](https://github.com/AliceLJY)) · WeChat Public Account: **我的AI小木屋**

Medical background, works in cultural administration, self-taught AI through real-world projects and repeated failures. I write about hands-on AI workflows, failure cases, product thinking, and the human side of technology.

Six content pillars: **Hands-on AI** · **AI Pitfall Diaries** · **AI & Humanity** · **AI Cold Eye** · **AI Musings** · **AI Visual Notes**

## WeChat Public Account

Scan to follow **我的AI小木屋**:

<img src="./assets/wechat_qr.jpg" width="200" alt="WeChat QR Code — 我的AI小木屋">

## License

MIT
