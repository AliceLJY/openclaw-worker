# Changelog

All notable changes to this project will be documented in this file.

## [2026-03-08] - Persistent Task Store

### Added
- **任务持久化**：`server.js` 现在把 task queue 和未取走结果落到 SQLite，不再只活在内存里
- **队列统计面**：新增 `/tasks/stats`，可查看任务状态分布和未取走结果数量
- **任务库配置**：支持 `WORKER_TASK_DB`、`WORKER_TASK_RETENTION_MS`、`WORKER_RESULT_RETENTION_MS`

### Changed
- **恢复策略**：Task API 启动时会把陈旧的 `running` 任务重置为 `pending`
- **健康面**：`/health` 现在会返回 task db 路径、状态分布和 retention 配置
- **README**：文档补齐 task store、持久化结果和 requeue 语义

## [2026-03-08] - Event Ops and Reconcile Audit

### Added
- **事件运维面**：新增 `/events/stats` 和 `/events/maintenance`，可以查看统计信息并执行手动 vacuum / trim
- **保留策略**：支持 `WORKER_EVENT_RETENTION_DAYS` 和 `WORKER_MAX_EVENTS` 控制事件保留
- **调和审计**：客户端真正取走结果时，会补记 `task.reconciled`

### Changed
- **自动维护**：Task API 启动时和后台清理循环中都会自动 trim 事件库
- **健康面**：`/health` 现在会返回事件库路径、保留天数、大小和上限
- **README**：文档补齐 event ops、retention 和 reconcile 语义
## [2026-03-08] - SQLite Event Store

### Added
- **SQLite 事件库**：`/events` 现在基于 SQLite 持久化，而不是进程内存
- **环境变量**：支持用 `WORKER_EVENT_DB` 覆盖默认事件库路径

### Changed
- **审计面**：Task API 重启后，近期事件仍然可查询

## [2026-03-08] - Event API and Reconciler Surface

### Added
- **Event API**：新增 `/events` 查询接口，用于查看最近任务与 callback 生命周期
- **事件流**：补充 `task.created`、`task.started`、`task.completed`、`task.failed`、`callback.*` 事件记录

### Changed
- **事件存储**：事件日志从内存记录提升为 SQLite 持久化
- **任务状态**：`/worker/result` 现在会按退出码写入 `completed` / `failed`
- **产品口径**：README 明确了 event / reconciler 面，不再只有 task queue 叙事

## [2026-03-08] - Pipeline 谱系收口

### Changed
- **产品谱系**：明确 `openclaw-cli-pipeline` 已归档，并将其定位为历史协议设计
- **现役入口**：将多轮编排入口统一指向 `openclaw-cli-bridge`
- **架构文档**：补充 `Docker control plane + local runner / reconciler` 的产品口径

## [2026-03-08] - Docker Runner 命名收口

### Changed
- **产品口径**：对外定位从“polling worker”收口为 `Docker-first local runner / reconciler`
- **README**：统一强调 Docker control plane + local execution plane，而不是把轮询当主卖点
- **脚本命名**：新增 `npm run task-api`、`npm run runner`、`npm run reconciler` 作为产品化别名，同时保留 `server` / `worker` 兼容脚本
- **运行时命名**：`worker.js` 启动日志和主循环命名改为 reconciler 语义，保留 `/worker/poll` 接口兼容

### Notes
- 这次主要是命名和叙事收口，不是 breaking API 变更
- 现有接入方仍可继续使用 `worker.js`、`/worker/poll`、`npm run worker`

## [2026-02-22] - Session 检测修复

### Fixed
- **Session ID 冲突**：Claude Code CLI 2.x 对 `--session-id`（新建）和 `--resume`（续接）做了严格区分。Worker 原先用内存 Set 跟踪 session 状态，重启后丢失 → 已有 session 被当新建 → 报错 "Session ID already in use"。改为检查磁盘 session 文件是否存在来判断
- **stderr 日志**：CC 执行的 stderr 输出现在会写入 `/tmp/cc-live.log`（之前只记录 stdout）
- **CLAUDECODE 环境变量**：spawn CC 子进程时显式清除 `CLAUDECODE` 环境变量，防止嵌套检测误判

---

## [2026-02-07] - 架构更新

### Changed
- **云端服务器**：从腾讯云迁移到 AWS EC2
- **自动启动方案**：从 sleepwatcher（唤醒启动）改为 launchd（开机启动 + 崩溃重启）
- **云端 AI 模型**：云端不再运行 Claude Code，改用 MiniMax M2.5（节省内存，原 Kimi K2.5 已替换）

### Added
- **进阶指南**：
  - `examples/multi-persona.md` - 多频道人设配置
  - `docs/security-guide.md` - Prompt 注入防御指南
  - `examples/cron-tasks.md` - 定时任务配置示例
  - `docs/claude-code-integration.md` - Claude Code 集成最佳实践
- **迁移指南**：从腾讯云迁移到 AWS、从 sleepwatcher 迁移到 launchd
- **双 Worker 架构**：支持同时连接本地 Docker Bot 和云端 AWS Bot

### Removed
- sleepwatcher 相关配置（已过时）
- 云端 Claude Code 相关文档（不再使用）

---

## [2026-02-05] - 初始版本

### Features
- 安全优先的任务队列架构
- Worker 轮询模式，无需端口转发
- 支持 Shell 命令、文件操作、Claude Code CLI
- Discord Bot 集成
- Docker 本地部署方案
