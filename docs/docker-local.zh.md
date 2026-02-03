# Docker 本地部署方案

> OpenClaw 装在 Docker，通过 Worker 调用本地 Claude Code。
>
> **适用场景**：本地使用，低延迟，不暴露公网。

## 架构

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
└─────────────────────────────────────────────────────────┘
```

## 对比

| 项目 | 云端方案 | Docker 本地 |
|------|----------|-------------|
| OpenClaw | 云服务器 | 本地 Docker |
| Task API | 云服务器 | 本地 Docker |
| Worker | 本地 | 本地 |
| 延迟 | 100-300ms | 1-5ms |
| 远程访问 | ✅ | ❌ |

### 为什么 CC 不装 Docker 里？

- **Keychain**：Claude Code OAuth token 存 macOS Keychain，Docker 内无法访问
- **权限隔离**：CC 在本地，OpenClaw 被攻击也无法直接执行系统命令

---

## 部署

### 前置条件

- Docker Desktop
- Claude Code 已登录（`claude auth status`）
- Discord Bot Token（可选）

### 步骤

```bash
# 1. Clone 仓库
git clone https://github.com/AliceLJY/openclaw-worker.git
cd openclaw-worker/docker

# 2. 运行安装脚本
./setup.sh

# 3. 配置 OpenClaw
docker compose run --rm openclaw-cli onboard
docker compose run --rm openclaw-cli channels add  # Discord

# 4. 启动 Worker
./start-worker.command

# 5. 验证
docker compose ps
curl http://localhost:3456/health
```

---

## 文件结构

```
docker/
├── docker-compose.yml      # Docker 编排
├── .env.example            # 环境变量模板
├── setup.sh                # 部署脚本
├── start-worker.command    # Worker 启动（macOS 可双击）
└── task-api/
    ├── Dockerfile
    ├── package.json
    └── server.js
```

---

## 常用命令

```bash
docker compose ps                         # 状态
docker compose logs -f                    # 日志
docker compose restart                    # 重启
docker compose down                       # 停止
docker compose down -v                    # 清理
```

---

## 端口

| 端口 | 服务 |
|------|------|
| 18789 | OpenClaw Web UI |
| 18790 | OpenClaw Bridge |
| 3456 | Task API |

---

## 故障排查

```bash
# Docker 日志
docker compose logs openclaw-gateway

# 端口占用
lsof -i :18789
lsof -i :3456

# Task API
curl http://localhost:3456/health

# CC 认证
claude auth status
```

---

## 安全

- Docker 隔离：OpenClaw 无法直接访问系统
- 权限分离：CC 权限在 Worker，不在 Docker
- 本地网络：不暴露公网
