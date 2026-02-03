# Docker 本地部署方案

> 把 OpenClaw 装在 Docker 里，通过 Worker 调用本地 Claude Code。
>
> **适用场景**：本地使用，追求低延迟，不想暴露服务到公网。

## 架构说明

```
┌─────────────────────────────────────────────────────────┐
│                      本地 Mac                           │
│                                                         │
│  ┌──────────────────────┐      ┌──────────────────────┐ │
│  │   Docker Container   │      │     本地环境          │ │
│  │                      │      │                      │ │
│  │   - OpenClaw         │ HTTP │   - Worker           │ │
│  │   - Discord Bot      │─────▶│   - Claude Code      │ │
│  │   - Task API         │      │   - Keychain 访问    │ │
│  │                      │      │                      │ │
│  │   (无 CC，无敏感权限) │      │   (有 CC 权限)       │ │
│  └──────────────────────┘      └──────────────────────┘ │
│         ↑                                               │
│         │ VPN                                           │
│         ↓                                               │
│      Discord                                            │
└─────────────────────────────────────────────────────────┘
```

## 与云端方案的对比

| 项目 | 云端方案 | Docker 本地方案 |
|------|----------|------------------|
| OpenClaw 位置 | 云服务器 | 本地 Docker |
| Task API 位置 | 云服务器 | 本地 Docker |
| Worker 位置 | 本地 Mac | 本地 Mac |
| CC 位置 | 本地 Mac | 本地 Mac |
| 网络延迟 | 有（跨网络）| 无（localhost）|
| 稳定性 | 依赖云端 | 本地可控 |
| 远程访问 | ✅ 支持 | ❌ 仅本地 |
| 安全隔离 | 中 | 高（Docker 隔离）|

### 为什么 CC 不装在 Docker 里？

1. **Keychain 访问**：Claude Code 的 OAuth token 存在 macOS Keychain，Docker 内无法访问
2. **认证问题**：Docker 是 Linux 环境，无法使用 macOS 的安全存储
3. **权限控制**：CC 权限在本地，即使 OpenClaw 被攻击也无法直接执行系统命令

---

## 快速部署

### 前置条件

- Docker Desktop 已安装
- Claude Code 已登录（`claude auth status` 确认）
- Discord Bot Token（如果要用 Discord）

### 1. 进入 docker 目录

```bash
cd docker
```

### 2. 运行安装脚本

```bash
./setup.sh
```

脚本会自动：
- 检查 Docker 环境
- 创建配置目录
- 生成安全 Token
- 构建并启动服务

### 3. 配置 OpenClaw

```bash
# 运行 onboard 配置向导
docker compose run --rm openclaw-cli onboard

# 配置 Discord（需要 Bot Token）
docker compose run --rm openclaw-cli channels add
```

### 4. 启动本地 Worker

```bash
# 方式1：双击启动
open start-worker.command

# 方式2：命令行启动
./start-worker.command
```

### 5. 验证

```bash
# 检查 Docker 服务
docker compose ps

# 检查 Task API
curl http://localhost:3456/health

# 检查 Worker
screen -r worker
```

---

## 文件结构

```
docker/
├── docker-compose.yml      # Docker 编排配置
├── .env.example            # 环境变量示例
├── setup.sh                # 部署脚本
├── start-worker.command    # Worker 启动脚本（macOS 可双击）
└── task-api/
    ├── Dockerfile          # Task API 镜像
    ├── package.json        # 依赖配置
    └── server.js           # Task API 源码
```

---

## 常用命令

```bash
# 查看服务状态
docker compose ps

# 查看日志
docker compose logs -f                    # 所有服务
docker compose logs -f openclaw-gateway   # 仅网关
docker compose logs -f task-api           # 仅 Task API

# 重启服务
docker compose restart

# 停止服务
docker compose down

# 完全清理（包括数据）
docker compose down -v
```

---

## 配置说明

### 环境变量（.env）

| 变量 | 说明 |
|------|------|
| `OPENCLAW_GATEWAY_TOKEN` | OpenClaw Web UI 访问 Token |
| `WORKER_TOKEN` | Worker 与 Task API 通信 Token |
| `OPENCLAW_CONFIG_DIR` | OpenClaw 配置目录 |
| `OPENCLAW_WORKSPACE_DIR` | 工作区目录 |

### 端口映射

| 端口 | 服务 | 用途 |
|------|------|------|
| 18789 | OpenClaw Gateway | Web UI |
| 18790 | OpenClaw Bridge | 内部通信 |
| 3456 | Task API | Worker 通信 |

---

## 故障排查

### 1. Docker 服务无法启动

```bash
# 查看详细日志
docker compose logs openclaw-gateway

# 检查端口占用
lsof -i :18789
lsof -i :3456
```

### 2. Worker 无法连接 Task API

```bash
# 检查 Task API 是否运行
curl http://localhost:3456/health

# 检查 Token 是否一致
grep WORKER_TOKEN .env
```

### 3. CC 认证失败

```bash
# 检查 CC 登录状态
claude auth status

# 重新登录
claude login

# 测试 Worker 环境
/bin/bash -l -c "claude auth status"
```

### 4. Discord 连接失败

确保 VPN 已开启，Discord 需要翻墙。

---

## 与云端方案并存

如果你想保留云端方案作为备份：

1. 本地 Docker 方案使用端口 `3456`
2. 云端方案使用云端 IP + 端口

切换方式：修改 Worker 的 `WORKER_URL` 环境变量即可。

---

## 安全说明

1. **Docker 隔离**：OpenClaw 在容器内运行，无法直接访问系统
2. **权限分离**：CC 权限在 Worker，不在 Docker 内
3. **Token 保护**：`.env` 文件包含敏感 Token，不要提交到 Git
4. **本地网络**：所有通信都在 localhost，不暴露到公网

---

## 常见问题

### Q: Docker 方案和云端方案能同时用吗？

可以。Worker 通过 `WORKER_URL` 决定连接哪个 Task API：
- `http://localhost:3456` → 本地 Docker
- `https://your-cloud-server:3456` → 云端

### Q: 为什么不直接在本地装 OpenClaw？

Docker 提供了额外的安全隔离。即使 OpenClaw 被恶意 prompt 攻击，它也无法直接执行系统命令——必须通过 Task API + Worker 的审计通道。

### Q: 延迟有多低？

本地通信约 1-5ms，比云端方案（100-300ms）快很多。适合需要频繁交互的场景。
