# OpenClaw Docker Runner

[English](README.md) | **简体中文**

这是一个面向 OpenClaw 兼容 agent 的 Docker-first 执行平面。控制面既可以本地跑在 Docker，也可以部署在远端服务器；真正的 runner 则运行在拥有 CLI、文件、shell 和本地 session 状态的宿主机上。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)

## 测试环境

- MacBook Air M4
- macOS
- Node.js
- Docker
- 本地 Claude Code with OAuth
- 运行在 Docker 或云端的 OpenClaw Bot
- 运行在作者 Mac 上的本地 runner

## 项目定位

这个仓库不应该再被表述成“一个轮询 worker”。

更准确的产品形态是：

- Docker-first control plane
- 运行在宿主机上的执行 runner，拥有真实文件和 CLI 权限
- hook 加速的 callback 回投
- 负责领任务、恢复和兜底的 reconciler 循环

更落地的部署理解是：

- 如果你想单机自托管，就把控制面跑在本地 Docker 里
- 如果你想远端编排，就把控制面跑在云端或远程服务器
- 无论哪种方式，runner 都应该留在真正拥有 Claude Code、Codex、Gemini、本地文件和浏览器上下文的那台机器上

长轮询仍然保留，但它只是领任务的传输实现，不应该再作为产品主叙事。

最近补上的产品化能力：

- SQLite 持久化任务队列和结果存储，Task API 重启后待处理任务不会直接丢失
- SQLite 持久化活跃会话状态，并提供只读 session stats / state 接口
- SQLite 事件日志和 `/events` 查询接口，能看到最近任务与 callback 生命周期
- `/tasks/stats` 用来查看队列规模和未取走结果数量
- `/sessions/stats` 和 `/sessions/state` 用来查看活跃 CLI 会话状态
- `/events/stats` 和 `/events/maintenance`，用于 retention、vacuum 和事件面运维
- 更清晰的 `task.created / task.started / task.completed / task.failed / callback.*` 事件轨迹
- 当客户端真正取走结果时，会补一条 `task.reconciled`
- 脚本和运行时日志已经改成 reconciler 语义，同时保留旧接口兼容

## 产品谱系

- `openclaw-cli-pipeline` 已归档，应被视为历史阶段的协议设计
- 它的多轮编排模型现在已经并入 [`openclaw-cli-bridge`](https://github.com/AliceLJY/openclaw-cli-bridge)
- 这个仓库继续负责执行平面：Task API、本地 runner、reconciler 循环，以及 callback 回投

## 兼容性说明

- `server` 这一侧相对通用。
- `worker` 这一侧主要在 macOS 上实测。
- 某些功能默认依赖 macOS shell、带 Keychain 气质的本地 Claude 工作流，以及作者机器上的 Claude 本地 session 布局。
- 核心架构原则上可移植，但作者的生产实测路径是 macOS + Docker + 本地 Claude Code。
- Linux 和 Windows 不是作者的主要实测路径。

## 架构假设

- `task-api` 和 `worker` 是分离进程。
- Bot 可以跑在 Docker 里，也可以跑在云端。
- 真正有文件访问和本地 CLI 工具的是本地机器上的 Worker。
- 回调通知是否可用，可能取决于你的 Docker 容器访问拓扑。
- Worker 主流程会通过 `/bin/zsh -l -c` 执行 shell 命令。
- Claude session 恢复逻辑默认依赖本地 `~/.claude/projects/...` 存储布局。
- Session 缓存会写到 `/tmp/cc-sessions.json`。
- 执行默认工作目录是 `$HOME`。

## 前置条件

- Node.js
- 一个足够强的 `WORKER_TOKEN`
- 如果采用分离部署，需要一台运行 `server.js` 的机器和一台运行 `worker.js` 的机器
- 如果要走文档里的 Docker 方案，需要可用的 Docker
- 如果要执行本地 AI CLI 任务，Worker 所在机器需要本地安装 Claude Code / Codex / Gemini
- 当前 Worker 主流程默认依赖兼容 `/bin/zsh -l -c` 的本地 shell 环境

## 已知限制

- Session 假设绑定在作者自己的本地 CLI 存储布局上。
- 回调路径可能依赖作者当前的 Docker 拓扑和挂载的 Docker socket。
- 这不是一个开箱即用的企业级分布式队列。
- Worker 侧的 Claude Code 集成主要在作者自己的本地 Mac 工作流里实测。

## 它是干什么的

OpenClaw Docker Runner 在 OpenClaw 兼容控制面和真实宿主机能力之间，加了一层安全的执行边界：

- Client 或 Bot 把任务提交给 `server.js`
- runner 通过 reconciler 循环领取任务
- runner 在宿主机上执行命令或本地 AI CLI 任务
- 结果回传给 Task API
- 可选回调会通过 hook-first 路径把完成消息再推回 Bot 侧
- 最近事件会保留在 Task API 中，便于调试和审计

```text
Client / Bot / OpenClaw -> Task API -> Host Runner / Reconciler -> Local CLI / Files / Browser / Claude Code
```

## 部署模式

| 模式 | 分别跑在哪里 | 说明 |
|------|--------------|------|
| Docker Local | OpenClaw 和 Task API 在同一台机器的 Docker 中，runner 在宿主机 | 最适合单机自托管和本地开发 |
| Docker + Remote Runner | OpenClaw 和 Task API 在 Docker，runner 在另一台宿主机 | 最适合把 Docker 当产品壳、把执行留在真实机器侧 |
| Cloud + Remote Runner | `server.js` 跑在云端或远程服务器，`worker.js` 跑在真正有 CLI 和文件权限的机器上 | 主要远控形态 |
| Single Host | `server.js` 直接跑在主机上，runner 跑在同机或另一台主机上 | 可以这么用，但不是主产品叙事 |

文档：

- [Docker 本地指南](docs/docker-local.md)
- [Docker 本地指南（中文）](docs/docker-local.zh.md)
- [部署说明](docs/deployment.md)
- [架构说明](docs/architecture.md)
- [Claude Code 集成](docs/claude-code-integration.md)
- [安全指南](docs/security-guide.md)

## 源码级假设

这些不是泛泛而谈，而是当前实现里已经写死或明确依赖的前提：

- `worker.js` 开头就把自己定义成 Mac 本地 Worker。
- `worker.js` 通过 `/bin/zsh -l -c` 执行命令。
- `worker.js` 会在 `~/.claude/projects/-Users-<home-name>/` 下解析 Claude session。
- `worker.js` 会把 session 状态写到 `/tmp/cc-sessions.json`。
- `worker.js` 默认把 `$HOME` 当作 `cwd`。
- `docker/docker-compose.yml` 会挂载 `~/.claude/projects`、`~/.codex/sessions` 和 `/var/run/docker.sock`。
- [examples/macos-startup.command](examples/macos-startup.command) 默认用 `screen` 加 `node worker.js` 启动 Worker。

## 快速开始

### 1. 启动 Task API

```bash
cd openclaw-worker
npm install
export WORKER_TOKEN="$(openssl rand -hex 32)"
npm run task-api
```

### 2. 启动本地 runner

```bash
export WORKER_URL="http://YOUR_SERVER_IP:3456"
export WORKER_TOKEN="YOUR_TOKEN"
npm run runner
```

### 3. 或使用 Docker 拓扑

```bash
cd docker
docker compose up -d
```

这个 Docker 拓扑默认需要宿主机 session 数据挂载和 Docker 回调访问。Docker 侧是控制平面；runner 侧始终是执行平面，不管它和 Docker 在同一台机器还是远端机器。

## 仓库结构

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

## 安全模型

- 本地 runner 不需要暴露入站端口。
- reconciler 循环通过 Task API 领取任务，而不是直接把 shell 暴露到公网。
- 认证方式是基于 token。
- 任务队列在 Bot 侧编排和本地执行之间提供了一层审计边界。
- 这套安全性最终仍取决于你给本地 runner 的权限和你的部署卫生。

## Event API

最近的生命周期事件可以直接通过 Task API 查询：

```bash
curl -H "Authorization: Bearer $WORKER_TOKEN" \
  "http://localhost:3456/events?limit=50"
```

事件统计：

```bash
curl -H "Authorization: Bearer $WORKER_TOKEN" \
  "http://localhost:3456/events/stats"
```

手动维护：

```bash
curl -X POST -H "Authorization: Bearer $WORKER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"vacuum": true}' \
  "http://localhost:3456/events/maintenance"
```

默认事件数据库：

```text
/tmp/openclaw-runner-events.db
```

如需覆盖：

```bash
WORKER_EVENT_DB=/path/to/openclaw-runner-events.db
WORKER_EVENT_RETENTION_DAYS=14
WORKER_MAX_EVENTS=2000
```

常用过滤参数：

- `taskId`
- `type`

常见事件类型：

- `task.created`
- `task.started`
- `task.completed`
- `task.failed`
- `task.reconciled`
- `callback.dispatched`
- `callback.sent`
- `callback.failed`

## Task Store

任务队列状态和未取走的结果现在会持久化到 SQLite：

```bash
curl -H "Authorization: Bearer $WORKER_TOKEN" \
  "http://localhost:3456/tasks/stats"
```

默认任务数据库：

```text
/tmp/openclaw-runner-tasks.db
```

如需覆盖：

```bash
WORKER_TASK_DB=/path/to/openclaw-runner-tasks.db
WORKER_TASK_RETENTION_MS=1200000
WORKER_RESULT_RETENTION_MS=1800000
```

行为说明：

- Pending 任务和未取走结果会跨 Task API 重启保留
- 启动时会把陈旧的 `running` 任务重置回 `pending`
- 结果在被取走后会删除；超出 retention 后也会被清理

## Session Store

活跃 CLI 会话状态现在也会持久化到同一个 SQLite 任务库里：

```bash
curl -H "Authorization: Bearer $WORKER_TOKEN" \
  "http://localhost:3456/sessions/stats"

curl -H "Authorization: Bearer $WORKER_TOKEN" \
  "http://localhost:3456/sessions/state?limit=50"
```

如需覆盖 session retention：

```bash
WORKER_SESSION_RETENTION_MS=1800000
```

行为说明：

- 活跃 session 状态会跨 Task API 重启保留
- `/claude/sessions` 现在也改成读持久化 session store
- 过期 session 会在后台清理中自动 trim

## 作者

作者是 **小试AI** ([@AliceLJY](https://github.com/AliceLJY)) · 微信公众号：**我的AI小木屋**

医学出身，文化口工作，靠真实项目和反复踩坑把 AI 工具真正用起来。主要写 AI 实操、失败案例、产品思路，以及技术背后的人味。

六个内容方向：**AI 实操手账** · **AI 踩坑实录** · **AI 照见众生** · **AI 冷眼旁观** · **AI 胡思乱想** · **AI 视觉笔记**。

## 公众号二维码

扫码关注 **我的AI小木屋**：

<img src="./assets/wechat_qr.jpg" width="200" alt="微信公众号二维码 — 我的AI小木屋">

## License

MIT
