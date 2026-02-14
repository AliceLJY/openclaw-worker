# OpenClaw 完整技术架构文档

## 架构总览

```
┌─────────────┐     ┌─────────────────────────────────────────────────┐     ┌─────────────────────────────┐
│   用户      │     │              云端 (AWS)                          │     │        本地 Mac             │
│  (Discord)  │────▶│  Discord Bot ←→ OpenClaw ←→ Task API            │◀────│  Worker ←→ 本地CC/Skills    │
└─────────────┘     └─────────────────────────────────────────────────┘     └─────────────────────────────┘
```

## 组件清单

| 组件 | 位置 | 技术栈 | 作用 |
|------|------|--------|------|
| Discord Bot | 云端 AWS | OpenClaw + MiniMax M2.5 | 用户入口，消息处理 |
| Task API | 云端/本地 | Node.js/Express | 任务队列，转发到本地 |
| Worker | 本地 Mac | Node.js | 轮询任务，调用本地资源 |
| 本地 CC | 本地 Mac | Claude Code CLI (Max 订阅, OAuth) | AI 任务执行 |
| baoyu-skills | 本地 Mac | TypeScript/Bun | Gemini 生图等扩展能力 |

---

## 1. 云端 OpenClaw (AWS)

### 部署
- 服务器：**AWS EC2**（海外服务器，可连接 Discord）
- 安装：官方一键脚本
- 配置：**MiniMax M2.5**（用于 Bot 对话和路由决策）
- 注意：云端**不运行 Claude Code**（节省内存），复杂任务通过 Task API 转发到本地

### 关键配置文件
```
~/.openclaw/openclaw.json  # 主配置（含 Discord Token）
~/.openclaw/cron/jobs.json # 定时任务
~/.openclaw/workspace/     # 记忆和人设文件
```

### 为什么不用云端 Claude Code？
- 云端服务器内存有限
- MiniMax M2.5 足够处理日常对话和路由
- 复杂任务（写文章、生成图片）转发到本地 Mac 执行

---

## 2. Discord Bot

### 功能
- 接收用户消息
- 根据频道切换人设（#mean 毒舌、#chat 贴心...）
- 简单任务直接用 MiniMax M2.5 回复
- 复杂任务调度到 Task API → 本地 Claude Code

### 记忆配置
Bot 需要记住 Task API 的调用方式（见 Bot 记忆章节）

---

## 3. Task API

### 部署位置
- **云端模式**：运行在 AWS 服务器上
- **本地模式**：运行在本地 Docker 容器中

### 作用
作为云端 Bot 和本地 Worker 之间的桥梁：
1. 云端 Bot 提交任务到 Task API
2. 本地 Worker 轮询 Task API 获取任务
3. Worker 在本地执行，结果返回给 Bot

---

## 4. 本地 Worker

### 部署
- 运行在本地 Mac
- 使用 **launchd** 实现开机自启和崩溃重启

### Worker 配置 (launchd)

创建文件 `~/Library/LaunchAgents/com.openclaw.worker.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.openclaw.worker</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-l</string>
        <string>-c</string>
        <string>sleep 30 &amp;&amp; cd /path/to/openclaw-worker &amp;&amp; WORKER_URL=http://YOUR_SERVER:3456 WORKER_TOKEN=YOUR_TOKEN /opt/homebrew/bin/node worker.js</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>/tmp/openclaw-worker.log</string>

    <key>StandardErrorPath</key>
    <string>/tmp/openclaw-worker.err</string>
</dict>
</plist>
```

### 配置说明

| 字段 | 作用 |
|------|------|
| `RunAtLoad` | 登录时自动启动 |
| `KeepAlive` | 崩溃后自动重启 |
| `sleep 30` | 等待网络就绪 |
| `-l` (login shell) | 加载用户环境变量（Claude Code OAuth 需要） |

### 加载/管理

```bash
# 加载（启用）
launchctl load ~/Library/LaunchAgents/com.openclaw.worker.plist

# 卸载（停用）
launchctl unload ~/Library/LaunchAgents/com.openclaw.worker.plist

# 查看状态
launchctl list | grep openclaw

# 查看日志
tail -f /tmp/openclaw-worker.log
```

---

## 5. 本地 Claude Code

### 用途
- 写文章（调用 content-alchemy 技能）
- 复杂推理任务
- 需要本地文件访问的操作

### 认证方式
使用 **OAuth 登录**（Claude Max 订阅）：

```bash
# 登录
claude login

# 验证
claude auth status
```

---

## 6. 双 Worker 架构（可选）

如果你同时运行本地 Docker Bot 和云端 AWS Bot，可以配置两个 Worker：

### 本地 Worker（连接 Docker Bot）
```
WORKER_URL=http://localhost:3456
```

### 云端 Worker（连接 AWS Bot）
```
WORKER_URL=http://YOUR_AWS_IP:3456
```

两个 Worker 可以同时运行，各自轮询不同的 Task API。

---

## 完整数据流

```
用户发消息 → Discord → AWS OpenClaw Bot
                              │
                              ├─ 简单问题 → MiniMax M2.5 直接回复
                              │
                              └─ 复杂任务 → Task API
                                              │
                                              ▼
                                     本地 Worker 轮询获取
                                              │
                                              ▼
                                     执行（Claude Code / Skills）
                                              │
                                              ▼
                                     结果返回 Task API
                                              │
                                              ▼
                                     Bot 回复用户
```

---

## 文件清单

| 文件 | 位置 | 作用 |
|------|------|------|
| openclaw.json | 云端 ~/.openclaw/ | 主配置（Discord Token、模型） |
| jobs.json | 云端 ~/.openclaw/cron/ | 定时任务 |
| MEMORY.md | 云端 ~/.openclaw/workspace/ | 频道人设、交互规则 |
| SOUL.md | 云端 ~/.openclaw/workspace/ | Bot 人格 |
| com.openclaw.worker.plist | 本地 ~/Library/LaunchAgents/ | Worker 自动启动配置 |
| worker.js | 本地项目目录 | Worker 主程序 |

---

## 常见问题

### Q: 电脑重启后 Worker 没自动启动？

检查 launchd 配置：
```bash
launchctl list | grep openclaw
# 应该看到 com.openclaw.worker
```

如果没有，重新加载：
```bash
launchctl load ~/Library/LaunchAgents/com.openclaw.worker.plist
```

### Q: Worker 启动了但连不上 Task API？

1. 检查 `WORKER_URL` 是否正确
2. 检查服务器防火墙是否开放 3456 端口
3. 查看日志：`tail -f /tmp/openclaw-worker.log`

### Q: Claude Code 报 403 / 需要登录？

```bash
# 重新登录
claude login

# 确认登录状态
claude auth status
```

### Q: 为什么用 `sleep 30`？

Mac 启动后网络需要几秒才能就绪，`sleep 30` 确保网络可用后再启动 Worker。

---

## 迁移指南

### 从腾讯云迁移到 AWS

1. 在 AWS 创建 EC2 实例
2. 安装 OpenClaw：`curl -fsSL https://openclaw.com/install.sh | bash`
3. 复制配置文件（MEMORY.md、SOUL.md、jobs.json 等）
4. 更新本地 Worker 的 `WORKER_URL` 指向新服务器
5. 重新加载 launchd 配置

### 从 sleepwatcher 迁移到 launchd

旧方案（sleepwatcher）只在睡眠唤醒时启动，**不推荐**。

新方案（launchd）优势：
- 开机自动启动
- 崩溃自动重启
- 系统原生支持，更稳定

删除旧配置：
```bash
# 删除 sleepwatcher 相关
rm ~/.wakeup
brew uninstall sleepwatcher
```

---

*最后更新：2026-02-14*
