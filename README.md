# OpenClaw Docker Runner

**English** | [简体中文](README_CN.md)

Docker-first local runner and reconciler for OpenClaw CLI orchestration. The core idea is portable, but the production-tested workflow in this repository is still macOS-first.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)

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
- Local runner with real file and CLI access
- Hook-accelerated callback delivery
- Reconciler loop for task pickup, recovery, and audit-safe fallback

Long polling is still used as transport for task pickup, but it is no longer the primary product story.

Recent productized additions:

- SQLite-backed event log with `/events` query API for recent task and callback lifecycle
- `/events/stats` and `/events/maintenance` for retention, vacuum, and audit-facing event ops
- clearer `task.created / task.started / task.completed / task.failed / callback.*` event trail
- `task.reconciled` when a client actually consumes a finished task result
- reconciler naming in scripts and runtime logs, while keeping legacy endpoints for compatibility

## Product Lineage

- `openclaw-cli-pipeline` is archived and should be treated as historical protocol design
- Its multi-turn orchestration model is now absorbed by [`openclaw-cli-bridge`](https://github.com/AliceLJY/openclaw-cli-bridge)
- This repository remains the execution plane: Task API, local runner, reconciler loop, and callback delivery

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
- Session cache is persisted at `/tmp/cc-sessions.json`.
- The default working directory for execution is `$HOME`.

## Prerequisites

- Node.js
- A strong `WORKER_TOKEN`
- One machine that can run `server.js` and one machine that can run `worker.js` if you use the split deployment
- Optional Docker if you want the documented Docker topology
- Local Claude Code / Codex / Gemini installs on the Worker machine if you want local AI CLI execution
- A local shell environment compatible with the current Worker assumptions (`/bin/zsh -l -c`)

## Known Limits

- `server.js` uses an in-memory task queue and in-memory result store.
- Session assumptions are tied to the author's local CLI storage layout.
- Callback behavior may depend on the author's Docker topology and mounted Docker socket.
- This is not a turnkey enterprise-grade distributed queue.
- Worker-side Claude Code integration is primarily tested on the author's local Mac workflow.

## What It Does

OpenClaw Docker Runner adds a queue boundary between cloud orchestration and local execution:

- A client or bot submits tasks to `server.js`
- The local runner pulls work through a reconciler loop
- The runner executes commands or local AI CLI tasks
- Results are sent back to the Task API
- Optional callbacks can push completion messages back to the bot side with hook-first delivery
- Recent lifecycle events stay queryable through the Task API for debugging and audit

```text
Client / Bot -> Task API -> Local Runner / Reconciler -> Local CLI / Files / Claude Code
```

## Deployment Modes

| Mode | What runs where | Notes |
|------|------------------|-------|
| Cloud + Local Runner | `server.js` on cloud, `worker.js` on local machine | Main remote-control pattern |
| Docker Local | OpenClaw and Task API in Docker, runner on local host | Matches the author's main local setup |
| Bare Metal API | `server.js` directly on a host, runner on another machine | Possible, but less documented here |

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
- `worker.js` stores session state in `/tmp/cc-sessions.json`.
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

This Docker topology expects host mounts for local session data and Docker callback access. The Docker side is the control plane; the local runner remains the execution plane.

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

## Author

Built by **小试AI** ([@AliceLJY](https://github.com/AliceLJY)) · WeChat Public Account: **我的AI小木屋**

Medical background, works in cultural administration, self-taught AI through real-world projects and repeated failures. I write about hands-on AI workflows, failure cases, product thinking, and the human side of technology.

Six content pillars: **Hands-on AI** · **AI Pitfall Diaries** · **AI & Humanity** · **AI Cold Eye** · **AI Musings** · **AI Visual Notes**

## WeChat Public Account

Scan to follow **我的AI小木屋**:

<img src="./assets/wechat_qr.jpg" width="200" alt="WeChat QR Code — 我的AI小木屋">

## License

MIT
