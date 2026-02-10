# OpenClaw 本地 Docker 部署方案

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

### 与云端方案的对比

| 项目 | 云端方案 | 本地 Docker 方案 |
|------|----------|------------------|
| OpenClaw 位置 | 腾讯云 | 本地 Docker |
| Task API 位置 | 腾讯云 | 本地 Docker |
| Worker 位置 | 本地 Mac | 本地 Mac |
| CC 位置 | 本地 Mac | 本地 Mac |
| 网络延迟 | 有（跨网络）| 无（localhost）|
| 稳定性 | 依赖云端 | 本地可控 |
| 安全隔离 | 中 | 高（Docker 隔离）|

### 为什么 CC 不装在 Docker 里？

1. **Keychain 访问**：CC 的 OAuth token 存在 macOS Keychain，Docker 内无法访问
2. **认证问题**：Docker 是 Linux 环境，无法使用 macOS 的安全存储
3. **权限控制**：CC 权限在本地，即使 OpenClaw 被攻击也无法直接执行系统命令

---

## 快速部署

### 1. 运行安装脚本

```bash
cd ~/Projects/openclaw-docker
./setup.sh
```

脚本会自动：
- 检查 Docker 环境
- 创建配置目录
- 生成安全 Token
- 构建并启动服务

### 2. 配置 OpenClaw

```bash
# 运行 onboard 配置向导
docker compose run --rm openclaw-cli onboard

# 配置 Discord（需要 Bot Token）
docker compose run --rm openclaw-cli channel add discord
```

### 3. 启动本地 Worker

```bash
# 方式1：双击启动
open ~/Projects/openclaw-docker/start-worker.command

# 方式2：命令行启动
~/Projects/openclaw-docker/start-worker.command
```

### 4. 验证

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
~/Projects/openclaw-docker/
├── docker-compose.yml      # Docker 编排配置
├── .env                    # 环境变量（Token 等）
├── .env.example            # 环境变量示例
├── setup.sh                # 部署脚本
├── start-worker.command    # Worker 启动脚本
├── README.md               # 本文档
└── task-api/
    ├── Dockerfile          # Task API 镜像
    ├── package.json        # 依赖配置
    └── server.js           # Task API 源码
```

---

## 常用命令

```bash
# 查看服务状态（需指定项目名区分 local 和 antigravity）
docker compose -p openclaw-local ps

# 查看日志
docker compose -p openclaw-local logs -f                    # 所有服务
docker compose -p openclaw-local logs -f openclaw-gateway   # 仅网关
docker compose -p openclaw-local logs -f task-api           # 仅 Task API
docker compose -p openclaw-local logs -f autoheal           # Autoheal 日志

# 重启服务
docker compose -p openclaw-local restart

# 停止服务
docker compose -p openclaw-local down

# 完全清理（包括数据）
docker compose -p openclaw-local down -v
```

> **注意**：如果同目录下有多个 compose 文件（如 antigravity），必须用 `-p` 指定项目名，否则会互相覆盖。

---

## 配置说明

### .env 文件

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

### 5. WiFi 断线后 Bot 自动恢复（Autoheal）

Gateway 容器配置了 autoheal 自动恢复机制：

- **健康检查**：双重检测 — HTTP `/health` API 可达 **且** 当天日志包含 `logged in to discord`
- **自动重启**：autoheal 容器每 30 秒检查一次，连续 3 次不健康则自动重启 gateway
- **启动等待**：start_period 90 秒，给 Discord 登录留够时间

```bash
# 查看健康状态
docker inspect --format='{{.State.Health.Status}}' openclaw-gateway

# 查看 autoheal 日志
docker logs autoheal-gateway --tail 20

# 手动触发重启（如果自动恢复失败）
docker restart openclaw-gateway
```

**已知问题**：WiFi 恢复后如果 DNS 还没通，autoheal 可能重启太早导致 Discord 登录失败。通常等 1-2 分钟会自动再试成功。如果持续失败，检查 Discord 是否有频率限制（rate limit）。

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
5. **Autoheal**：Gateway 容器配有自动恢复，WiFi 断线后无需手动干预
