# OpenClaw Worker

> 无需端口转发或 VPN，从云端远程控制你的本地电脑

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)

**OpenClaw Worker** 是一个基于轮询的轻量级架构，让云端服务（Discord 机器人、Slack 机器人、Web 面板）能够安全地在位于 NAT/防火墙后的本地电脑上执行命令，无需端口转发、VPN 或 SSH 隧道。

```
┌─────────────┐     ┌──────────────────────────┐     ┌─────────────────────┐
│   客户端    │────▶│   云端任务 API           │◀────│   本地 Worker       │
│  (Discord)  │     │  (任务队列 + 轮询)       │     │  (执行任务)         │
└─────────────┘     └──────────────────────────┘     └─────────────────────┘
```

## 为什么又一个远程控制方案？

### 问题

你想在任何地方（Discord、Slack、手机）控制家里的电脑，但是：
- **端口转发**会将你的电脑暴露在互联网上
- **VPN/Tailscale** 需要在两端都安装
- **SSH 隧道** (`ssh -R`) 不稳定且需要维护持久连接
- **OpenClaw 原生远程**需要本地安装 OpenClaw 并处理 token mismatch 问题

### 解决方案

**轮询架构**：本地 worker 主动轮询云端 API 获取任务。无需入站连接。

```
云端 API: "有活儿吗？"
Worker:   "有！这是结果..."
```

简单。安全。到处都能用。

## 特性

- 🚀 **无需端口转发**：Worker 轮询云端 API，无需入站连接
- 🔒 **安全**：基于 token 的认证，全程 HTTPS
- ⚡ **并发执行**：同时处理多个任务
- 🌐 **平台无关**：适用于 Discord、Slack 或任何 HTTP 客户端
- 🛠️ **多种任务类型**：
  - Shell 命令
  - 文件读写操作
  - Claude Code CLI 执行
  - 自定义任务类型（可扩展）
- 🔄 **长轮询**：支持超时的高效任务结果获取
- 📦 **零依赖**：纯 Node.js 实现
- 🔌 **自动恢复**：从睡眠唤醒后 Worker 自动重启（macOS）

## 快速开始

### 前置条件

- Node.js 18+
- 一台云服务器（用于运行 Task API）
- 一台要控制的本地电脑

### 1. 部署云端任务 API

在你的云服务器上：

```bash
# 下载 server.js
curl -O https://raw.githubusercontent.com/AliceLJY/openclaw-worker/main/server/server.js

# 安装依赖
npm install express

# 生成安全 token
export WORKER_TOKEN=$(openssl rand -hex 32)
echo "你的 token: $WORKER_TOKEN"  # 保存这个！

# 启动服务器
export WORKER_PORT=3456
node server.js

# 或使用 pm2（生产环境）
pm2 start server.js --name openclaw-api
```

服务器将运行在 `http://YOUR_SERVER_IP:3456`

### 2. 启动本地 Worker

在你的本地电脑上：

```bash
# 下载 worker.js
curl -O https://raw.githubusercontent.com/AliceLJY/openclaw-worker/main/worker/worker.js

# 配置
export WORKER_URL=http://YOUR_SERVER_IP:3456
export WORKER_TOKEN=<第1步的token>

# 启动 worker
node worker.js

# 或使用 screen 后台运行
screen -dmS worker bash -c 'WORKER_URL=http://YOUR_SERVER_IP:3456 WORKER_TOKEN=xxx node worker.js'
```

### 3. 测试连接

```bash
# 提交任务
curl -X POST http://YOUR_SERVER_IP:3456/tasks \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"command": "echo 来自远程的问候！", "timeout": 30000}'

# 响应：{"taskId": "abc-123", "message": "Task created, waiting for worker"}

# 获取结果（30秒长轮询）
curl "http://YOUR_SERVER_IP:3456/tasks/abc-123?wait=30000" \
  -H "Authorization: Bearer YOUR_TOKEN"

# 响应：{"stdout": "来自远程的问候！", "exitCode": 0}
```

## 架构

### 组件

| 组件 | 位置 | 用途 |
|------|------|------|
| **Task API** | 云服务器 | 管理任务队列，接收客户端请求 |
| **Worker** | 本地电脑 | 轮询 API，执行任务，上报结果 |
| **客户端** | 任何地方 | 通过 HTTP 提交任务（Discord bot、脚本等） |

### 任务生命周期

```
1. 客户端提交任务 → Task API 创建任务（状态：pending）
2. Worker 轮询 API → 获取任务，标记为 running
3. Worker 执行任务 → 捕获输出
4. Worker 上报结果 → Task API 存储结果
5. 客户端获取结果 → 长轮询带超时
```

### 安全模型

- **认证**：`Authorization` header 中的 Bearer token
- **无凭证存储**：Worker 不存储密码或密钥
- **沙箱执行**：命令以 worker 用户权限运行
- **传输安全**：生产环境建议使用 HTTPS

## API 参考

### 提交 Shell 命令

```bash
POST /tasks
Authorization: Bearer YOUR_TOKEN
Content-Type: application/json

{
  "command": "ls -la /tmp",
  "timeout": 30000
}
```

### 执行 Claude Code CLI

```bash
POST /claude
Authorization: Bearer YOUR_TOKEN
Content-Type: application/json

{
  "prompt": "列出当前目录的文件并总结",
  "timeout": 120000
}
```

### 文件操作

```bash
# 读取文件
POST /files/read
{"path": "/path/to/file"}

# 写入文件
POST /files/write
{"path": "/path/to/file", "content": "数据", "encoding": "utf8"}
```

### 获取任务结果

```bash
GET /tasks/:taskId?wait=60000
Authorization: Bearer YOUR_TOKEN

# 响应：
{
  "taskId": "abc-123",
  "stdout": "输出内容",
  "stderr": "",
  "exitCode": 0,
  "completedAt": 1234567890
}
```

完整 API 文档见 [docs/api.md](docs/api.md)。

## 集成示例

### Discord Bot

```javascript
const response = await fetch(`${API_URL}/claude`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${TOKEN}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    prompt: userMessage,
    timeout: 120000
  })
});

const { taskId } = await response.json();

// 长轮询获取结果
const result = await fetch(`${API_URL}/tasks/${taskId}?wait=120000`, {
  headers: { 'Authorization': `Bearer ${TOKEN}` }
});

await discordChannel.send(result.stdout);
```

完整实现见 [examples/discord-bot/](examples/discord-bot/)。

### Slack 集成

见 [examples/slack-bot/](examples/slack-bot/)

### Web 控制面板

见 [examples/web-dashboard/](examples/web-dashboard/)

## 配置

### Worker 环境变量

```bash
WORKER_URL=http://YOUR_SERVER_IP:3456  # Task API URL
WORKER_TOKEN=xxx                       # 认证 token
POLL_INTERVAL=500                      # 轮询间隔（毫秒）
MAX_CONCURRENT=3                       # 最大并发任务数
```

### Server 环境变量

```bash
WORKER_TOKEN=xxx    # 认证 token（必须与 worker 匹配）
WORKER_PORT=3456    # 服务器端口
```

## 高级用法

### macOS 唤醒自动启动

```bash
# 安装 sleepwatcher
brew install sleepwatcher

# 创建唤醒脚本
cat > ~/.wakeup << 'EOF'
#!/bin/bash
screen -dmS worker bash -c 'cd ~/openclaw-worker && WORKER_URL=xxx WORKER_TOKEN=xxx node worker.js'
EOF
chmod +x ~/.wakeup

# 启用 sleepwatcher
brew services start sleepwatcher
```

### 生产部署

- 使用 **pm2** 或 **systemd** 管理进程
- 配置**日志轮转**用于长期运行的 worker
- 使用反向代理（nginx/caddy）提供 **HTTPS**
- 在 Task API 上实现**速率限制**
- 通过**健康检查端点**（`/health`）监控

## 为什么选择这种方法？

### 从之前方案的演进

在最终确定这个架构之前，我尝试了几种方案：

**尝试 1：SSH 反向隧道**
```bash
ssh -R 18789:localhost:18789 cloud-server
```
- ❌ 连接经常断开
- ❌ 需要 SSH 访问云服务器
- ❌ OpenClaw token mismatch 问题

**尝试 2：Tailscale Serve**
```bash
tailscale serve --bg 18789
```
- ❌ WebSocket SSL 握手失败
- ❌ 两端都需要安装 Tailscale

**尝试 3：原生 OpenClaw Remote**
- ❌ 令人困惑的双 token 认证
- ❌ 需要本地安装 OpenClaw
- ❌ `exec-approvals` socket 问题

**最终方案：轮询架构**
- ✅ 无需持久连接
- ✅ 适用于任何防火墙/NAT
- ✅ 简单的 HTTP API
- ✅ 自我修复（自动重连）

完整踩坑历程见 [docs/background.md](docs/background.md)。

## 使用场景

- 🤖 **Discord/Slack Bot** 控制本地电脑
- 🎨 **内容自动化**（生成图片、发布文章）
- 📊 **远程监控**（检查 Docker 容器、磁盘空间）
- 🔧 **CI/CD 触发器**从云端到本地开发环境
- 📱 **移动控制**家庭自动化脚本

## 限制

- **非实时**：500ms 轮询间隔（可调整）
- **无状态**：任务之间无持久会话
- **单向**：Worker 无法主动发起任务
- **需要信任**：客户端必须信任云端 API 的安全性

## 贡献

欢迎贡献！请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件。

## 致谢

- 为 [OpenClaw](https://github.com/openclaw/openclaw) 生态系统构建 - 强大的 AI 代理框架
- 源于 OpenClaw 原生远程控制的挑战（SSH 隧道、token 不匹配等问题）
- 与 [baoyu-skills](https://github.com/JimLiu/baoyu-skills) 配合使用效果极佳，可实现内容自动化
- 使用 Claude Code Max 订阅（OAuth 认证，非 API Key）提供本地 AI 能力
- 使用 MiniMax API 供 OpenClaw 进行轻量级路由决策

## 支持

- 📖 [文档](docs/)
- 🐛 [问题追踪](https://github.com/AliceLJY/openclaw-worker/issues)
- 💬 [讨论区](https://github.com/AliceLJY/openclaw-worker/discussions)

---

用 ☕ 制作 [@AliceLJY](https://github.com/AliceLJY)
