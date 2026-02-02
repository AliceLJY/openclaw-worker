# OpenClaw 完整技术架构文档

## 架构总览

```
┌─────────────┐     ┌─────────────────────────────────────────────────┐     ┌─────────────────────────────┐
│   用户      │     │              云端 (腾讯云硅谷)                   │     │        本地 Mac             │
│  (Discord)  │────▶│  Discord Bot ←→ OpenClaw ←→ 云端CC ←→ Task API  │◀────│  Worker ←→ 本地CC/Skills    │
└─────────────┘     └─────────────────────────────────────────────────┘     └─────────────────────────────┘
```

## 组件清单

| 组件 | 位置 | 技术栈 | 作用 |
|------|------|--------|------|
| Discord Bot | 云端 | OpenClaw | 用户入口，消息处理 |
| 云端 CC | 云端 | Claude Code CLI (Max 订阅, OAuth) | 复杂任务思考/分析 |
| Task API | 云端 <YOUR_SERVER_IP>:3456 | Node.js/Express | 任务队列，转发到本地 |
| Worker | 本地 Mac 终端 | Node.js | 轮询任务，调用本地资源 |
| 本地 CC | 本地 Mac | Claude Code CLI (Max 订阅, OAuth) | AI 任务执行 |
| baoyu-skills | 本地 Mac | TypeScript/Bun | Gemini 生图等扩展能力 |

---

## 1. 云端 OpenClaw

### 部署
- 服务器：腾讯云硅谷（国内无法连 Discord）
- 安装：官方一键脚本
- 配置：**MiniMax API**（用于路由决策）
- 注意：本项目**不使用** Anthropic API，而是通过 Claude Code CLI

### 关键配置文件
```
~/.openclaw/openclaw.json  # 网关配置
```

---

## 2. Discord Bot

### 功能
- 接收用户消息
- 调用云端 CC 或本地 CC
- 调度任务到 Task API

### 记忆配置
Bot 需要记住 Task API 的调用方式（见 Bot 记忆章节）

---

## 3. 云端 Claude Code

### 用途
- 复杂问题分析
- 创意生成
- 代码审查

### 认证方式

云端 CC 也使用 **OAuth 登录**（Max 订阅）：

```bash
# 登录（会给出链接，复制到本地浏览器完成认证）
claude login

# 验证登录状态
claude auth status
# 应显示: "Logged in as user@example.com"
```

**注意**：服务器没有浏览器，`claude login` 会输出一个链接，复制到本地浏览器打开完成认证即可。

### 调用方式
通过 OpenClaw 内置能力调用

### 关键：Gateway 必须用 login shell 启动

云端 CC 的 OAuth token 存储在用户环境中，**Gateway 必须用 login shell 启动**才能访问：

```bash
# ✅ 正确启动方式（login shell）
nohup bash -l -c "openclaw gateway --port 18789" > /tmp/gateway.log 2>&1 &

# ❌ 错误启动方式（无法访问 OAuth token）
nohup openclaw gateway --port 18789 > /tmp/gateway.log 2>&1 &
```

### 常见问题

**问题：Bot 调用云端 CC 报 403 Forbidden / 需要登录**

**原因**：
1. 云端 CC 未登录
2. 或 Gateway 未用 login shell 启动

**解决**：
```bash
# 1. 确认云端 CC 已登录
claude auth status

# 2. 如果未登录，执行登录
claude login

# 3. 用 login shell 重启 Gateway
pkill -f openclaw-gateway
nohup bash -l -c "openclaw gateway --port 18789" > /tmp/gateway.log 2>&1 &

# 4. 确认 Gateway 启动成功
sleep 5
ps aux | grep openclaw-gateway
openclaw gateway status
```

---

## 4. Task API (server.js)

### 部署位置
云端服务器 <YOUR_SERVER_IP>:3456

### 技术栈
Node.js + Express，内存任务队列

### API 端点

| 端点 | 方法 | 用途 |
|------|------|------|
| `/claude` | POST | 调用本地 CC |
| `/tasks` | POST | 执行 shell 命令 |
| `/tasks/:id` | GET | 获取结果（支持长轮询） |
| `/files/read` | POST | 读取本地文件 |
| `/files/write` | POST | 写入本地文件 |
| `/health` | GET | 健康检查 |
| `/worker/poll` | GET | Worker 获取任务 |
| `/worker/result` | POST | Worker 上报结果 |

### 认证
Header: `Authorization: Bearer <YOUR_TOKEN>`

### 代码位置
`~/Projects/openclaw-worker/server.js`

---

## 5. 本地 Worker (worker.js)

### 部署位置
本地 Mac，必须在终端运行

### 工作原理
- 每 500ms 轮询 `/worker/poll`
- 获取任务后根据类型执行
- 执行完成上报 `/worker/result`

### 支持的任务类型
- `command`: Shell 命令
- `claude-cli`: 本地 Claude Code
- `file-read`: 读取文件
- `file-write`: 写入文件

### 关键参数
```bash
WORKER_URL=http://<YOUR_SERVER_IP>:3456
WORKER_TOKEN=<YOUR_TOKEN>
MAX_CONCURRENT=3  # 最大并发
POLL_INTERVAL=500  # 轮询间隔(ms)
```

### 代码位置
`~/Projects/openclaw-worker/worker.js`

### 启动方式

**重要**：必须使用 **login shell** (`-l` 参数) 才能访问 Claude OAuth 认证！

```bash
# 方式1：双击桌面快捷方式（推荐）
~/Desktop/启动Worker.command

# 方式2：手动 screen 启动
# ✅ 正确（使用 login shell）
screen -dmS worker bash -l -c 'cd ~/Projects/openclaw-worker && \
  WORKER_URL=http://<YOUR_SERVER_IP>:3456 \
  WORKER_TOKEN=<YOUR_TOKEN> \
  node worker.js'

# ❌ 错误（non-login shell，无法访问 Keychain）
screen -dmS worker bash -c 'node worker.js'
```

**启动脚本内容** (`~/Desktop/启动Worker.command`)：
```bash
#!/bin/bash
# 杀掉旧进程
pkill -f "node worker.js" 2>/dev/null
screen -S worker -X quit 2>/dev/null

# 使用 login shell (-l 参数) 启动
screen -dmS worker bash -l -c 'cd ~/Projects/openclaw-worker && \
  WORKER_URL=http://<YOUR_SERVER_IP>:3456 \
  WORKER_TOKEN=<YOUR_TOKEN> \
  POLL_INTERVAL=500 \
  MAX_CONCURRENT=3 \
  node worker.js'

echo "Worker 已启动！"
echo "查看日志: screen -r worker"
```

### 唤醒自动启动
已配置 sleepwatcher，Mac 唤醒时自动启动 Worker：

**安装 sleepwatcher**：
```bash
brew install sleepwatcher
brew services start sleepwatcher
```

**唤醒脚本** (`~/.wakeup`)：
```bash
#!/bin/bash
# Mac 唤醒时自动重启 Worker
screen -dmS worker bash -l -c 'cd ~/Projects/openclaw-worker && \
  WORKER_URL=http://<YOUR_SERVER_IP>:3456 \
  WORKER_TOKEN=<YOUR_TOKEN> \
  node worker.js'
```

**注意**：唤醒脚本也必须使用 `-l` 参数（login shell）

---

## 6. 本地 Claude Code

### 调用方式
```bash
claude --print --dangerously-skip-permissions "prompt"
```

### 关键参数
- `--print`: 非交互模式，输出结果后退出
- `--dangerously-skip-permissions`: 绕过文件访问限制（图片识别必需）

### 认证方式

Claude Code 支持三种认证方式，本项目使用 **方式1（OAuth）**：

**方式1：OAuth 登录（我们使用的）** ⭐
```bash
claude login  # 浏览器认证
```
- 使用 Claude.ai Max 订阅
- Token 存储在 macOS Keychain
- 云端和本地用同一个订阅账号
- **需要 login shell 才能访问 Keychain**

**方式2：API Key（企业用）**
```bash
claude login --api-key
export ANTHROPIC_API_KEY="your-key"
```
- 按量计费，独立于订阅
- 不依赖 Keychain

**方式3：长期令牌（服务器用）**
```bash
claude setup-token  # 无浏览器
```
- 适合 CI/CD、服务器
- 不需要 login shell

### 常见问题与解决

**问题1：Worker 执行 Claude 任务时报 "Invalid API key"**

**原因**：Worker 启动方式不对，无法访问 Keychain

**解决**：
```bash
# ❌ 错误启动方式（non-login shell）
screen -dmS worker bash -c 'node worker.js'

# ✅ 正确启动方式（login shell）
screen -dmS worker bash -l -c 'node worker.js'
```

关键是 `-l` 参数（login shell），才能加载完整环境和访问 Keychain。

**问题2：403 Forbidden / Not logged in**

**解决**：
```bash
# 重新登录
claude login

# 验证登录状态
claude auth status
# 应显示: "Logged in as user@example.com"

# 测试 Worker 环境能否访问
/bin/bash -l -c "claude auth status"
# 也应显示已登录

# 完全重启 Worker
pkill -f "node worker.js"
screen -S worker -X quit
~/Desktop/启动Worker.command
```

**问题3：LaunchAgent 无法访问 Keychain**

**解决**：不要用 LaunchAgent，用 screen + sleepwatcher 方案：
```bash
# 安装 sleepwatcher
brew install sleepwatcher

# 创建唤醒脚本 ~/.wakeup
screen -dmS worker bash -l -c 'cd ~/Projects/openclaw-worker && ...'

# 启动服务
brew services start sleepwatcher
```

---

## 7. baoyu-skills (扩展能力)

### 位置
`~/content-alchemy-repo/dependencies/baoyu-skills/`

### Gemini 生图
```bash
cd ~/content-alchemy-repo && npx -y bun \
  ./dependencies/baoyu-skills/skills/baoyu-danger-gemini-web/scripts/main.ts \
  --prompt "描述" --image ~/Desktop/output.png
```

### 其他 Skills
- `baoyu-image-gen`: API 生图（需要 Key）
- `baoyu-post-to-wechat`: 发布微信公众号
- `baoyu-url-to-markdown`: URL 转 Markdown

---

## 8. Bot 记忆配置

```
## 本地 Mac 控制能力

API 服务器: http://<YOUR_SERVER_IP>:3456
认证: Bearer <YOUR_TOKEN>

1. 调用本地 Claude Code: POST /claude + GET /tasks/:id?wait=60000
2. 执行 shell 命令: POST /tasks + GET /tasks/:id?wait=30000
3. 读文件: POST /files/read + GET /tasks/:id?wait=10000
4. 写文件: POST /files/write + GET /tasks/:id?wait=10000
5. Gemini 生图: shell 命令调用 baoyu-danger-gemini-web

根据需求自动选择。
```

---

## 9. 已验证能力

| 能力 | 状态 |
|------|------|
| Bot → 本地 CC | ✅ |
| Bot → 云端 CC | ✅ |
| Bot → Shell 命令 | ✅ |
| Bot → 文件读写 | ✅ |
| 云端 CC ↔ 本地 CC 协作 | ✅ |
| 本地 CC 图片识别 | ✅ |
| Gemini 生图 | ✅ |

---

## 10. 关键技术决策

| 问题 | 方案 | 原因 |
|------|------|------|
| 内网穿透 | Worker 轮询 | 无需入站连接 |
| OAuth 认证 | 终端运行 Worker | Keychain 访问权限 |
| 文件权限 | `--dangerously-skip-permissions` | 图片识别必需 |
| 无 API Key | HTTP API + Bot 中转 | 兼容 Max 订阅 |

---

## 11. 文件清单

| 文件 | 位置 | 用途 |
|------|------|------|
| server.js | 云端 ~/openclaw-worker/ | Task API |
| openclaw.json | 云端 ~/.openclaw/ | OpenClaw 配置 |
| worker.js | 本地 ~/Projects/openclaw-worker/ | 本地 Worker |
| 启动Worker.command | 本地 ~/Desktop/ | 快捷启动 Worker |
| .wakeup | 本地 ~/ | 唤醒自动启动脚本 |
| baoyu-skills | 本地 ~/content-alchemy-repo/dependencies/ | 扩展能力 |

### 云端服务启动命令（保存备用）

```bash
# 启动 Gateway（必须用 login shell）
nohup bash -l -c "openclaw gateway --port 18789" > /tmp/gateway.log 2>&1 &

# 启动 Task API（也建议用 login shell）
nohup bash -l -c "node /root/openclaw-worker/server.js" > /tmp/server.log 2>&1 &

# 查看日志
tail -f /tmp/gateway.log
tail -f /tmp/server.log

# 检查状态
openclaw gateway status
openclaw status
```

---

## 12. 换电脑重装步骤

1. **云端服务器**
   - 部署 OpenClaw（官方一键脚本）
   - 登录云端 Claude Code：
     ```bash
     claude login  # 复制链接到本地浏览器完成认证
     claude auth status  # 验证登录成功
     ```
   - 运行 server.js（Task API），设置 `WORKER_TOKEN`：
     ```bash
     nohup bash -l -c "node /root/openclaw-worker/server.js" > /tmp/server.log 2>&1 &
     ```
   - **用 login shell 启动 Gateway**（关键！）：
     ```bash
     nohup bash -l -c "openclaw gateway --port 18789" > /tmp/gateway.log 2>&1 &
     ```
   - 验证服务状态：
     ```bash
     openclaw gateway status  # 应显示 RPC probe: ok
     openclaw status  # 查看完整状态
     ```

2. **本地 Mac**
   - 克隆 `openclaw-worker` 项目：
     ```bash
     git clone https://github.com/AliceLJY/openclaw-worker.git ~/Projects/openclaw-worker
     ```
   - 安装 Node.js 18+
   - 安装并登录 Claude Code：
     ```bash
     brew install claude
     claude login  # OAuth 认证，浏览器登录
     claude auth status  # 验证登录成功
     ```
   - 配置启动脚本 `~/Desktop/启动Worker.command`：
     - 填入 `WORKER_URL` 和 `WORKER_TOKEN`
     - **确保使用 `bash -l -c`（login shell）**
     - 赋予执行权限：`chmod +x ~/Desktop/启动Worker.command`
   - 安装 sleepwatcher：
     ```bash
     brew install sleepwatcher
     brew services start sleepwatcher
     ```
   - 创建唤醒脚本 `~/.wakeup`（也要用 `bash -l -c`）
   - 测试 Worker 环境认证：
     ```bash
     /bin/bash -l -c "claude auth status"  # 应显示已登录
     ```

3. **Bot 配置**
   - 发送 Bot 记忆配置（第8章节）

---

## 13. 注意事项

### Claude Code 认证相关（重要！）

1. **本地 Worker 必须使用 login shell**
   - ✅ 正确：`bash -l -c 'node worker.js'`
   - ❌ 错误：`bash -c 'node worker.js'`
   - 原因：OAuth token 在 Keychain，需要 login shell 才能访问

2. **云端 Gateway 也必须使用 login shell**
   - ✅ 正确：`bash -l -c "openclaw gateway --port 18789"`
   - ❌ 错误：`openclaw gateway --port 18789`
   - 原因：云端 CC 的 OAuth token 也需要 login shell 才能访问

3. **三种认证方式**
   - 方式1：OAuth（`claude login`）- **云端和本地都使用**
   - 方式2：API Key（`claude login --api-key`）- 企业用
   - 方式3：长期令牌（`claude setup-token`）- CI/CD 用

4. **本地认证失败排查**
   ```bash
   # 检查登录状态
   claude auth status

   # 测试 Worker 环境
   /bin/bash -l -c "claude auth status"

   # 重新登录
   claude login

   # 完全重启 Worker
   pkill -f "node worker.js" && ~/Desktop/启动Worker.command
   ```

5. **云端认证失败排查**
   ```bash
   # SSH 到云端服务器后执行
   source ~/.nvm/nvm.sh  # 加载 node 环境

   # 检查登录状态
   claude auth status

   # 如果未登录，执行登录（复制链接到本地浏览器）
   claude login

   # 用 login shell 重启 Gateway
   pkill -f openclaw-gateway
   nohup bash -l -c "openclaw gateway --port 18789" > /tmp/gateway.log 2>&1 &

   # 验证
   sleep 5
   openclaw gateway status
   ```

### 其他注意事项

6. Mac 休眠后 Worker 会停，但 sleepwatcher 会自动重启
7. 云端服务器需在境外（Discord 连接）
8. Token 云端本地保持一致
9. 长任务增加 timeout 参数（Claude 任务建议 120000ms）
10. 云端和本地 CC 使用**同一个 Max 订阅**，无需额外费用
11. 云端服务器重启后需要重新用 login shell 启动 Gateway
