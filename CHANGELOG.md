# Changelog

All notable changes to this project will be documented in this file.

## [2026-02-07] - 架构更新

### Changed
- **云端服务器**：从腾讯云迁移到 AWS EC2
- **自动启动方案**：从 sleepwatcher（唤醒启动）改为 launchd（开机启动 + 崩溃重启）
- **云端 AI 模型**：云端不再运行 Claude Code，改用 Kimi K2.5（节省内存）

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
