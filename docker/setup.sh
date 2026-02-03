#!/bin/bash
# OpenClaw 本地 Docker 部署脚本
# 架构：Docker(OpenClaw + Task API) <-> 本地 Worker <-> 本地 CC

set -e

echo "=========================================="
echo "  OpenClaw 本地 Docker 部署"
echo "=========================================="
echo ""

# 检查 Docker
if ! command -v docker &> /dev/null; then
    echo "错误: 未安装 Docker"
    exit 1
fi

if ! command -v docker compose &> /dev/null; then
    echo "错误: 未安装 Docker Compose"
    exit 1
fi

echo "✓ Docker 环境检查通过"

# 创建配置目录
OPENCLAW_CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$HOME/.openclaw-docker}"
OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$HOME/openclaw-workspace}"

mkdir -p "$OPENCLAW_CONFIG_DIR"
mkdir -p "$OPENCLAW_WORKSPACE_DIR"

echo "✓ 创建目录:"
echo "  - 配置: $OPENCLAW_CONFIG_DIR"
echo "  - 工作区: $OPENCLAW_WORKSPACE_DIR"

# 生成 Token（如果没有 .env）
if [ ! -f .env ]; then
    echo ""
    echo "生成配置文件 .env ..."

    # 生成随机 Token
    GATEWAY_TOKEN=$(openssl rand -hex 32 2>/dev/null || python3 -c "import secrets; print(secrets.token_hex(32))")
    WORKER_TOKEN=$(openssl rand -hex 16 2>/dev/null || python3 -c "import secrets; print(secrets.token_hex(16))")

    cat > .env << EOF
# OpenClaw Docker 本地部署配置
# 生成于 $(date)

# OpenClaw 网关 Token
OPENCLAW_GATEWAY_TOKEN=$GATEWAY_TOKEN

# Worker 通信 Token（本地 Worker 需要使用相同的值）
WORKER_TOKEN=$WORKER_TOKEN

# 配置目录
OPENCLAW_CONFIG_DIR=$OPENCLAW_CONFIG_DIR

# 工作区目录
OPENCLAW_WORKSPACE_DIR=$OPENCLAW_WORKSPACE_DIR
EOF

    echo "✓ 已生成 .env 文件"
    echo ""
    echo "重要信息（请保存）:"
    echo "  WORKER_TOKEN=$WORKER_TOKEN"
    echo ""
else
    echo "✓ 使用已有的 .env 配置"
    source .env
fi

# 构建并启动
echo ""
echo "构建 Docker 镜像..."
docker compose build

echo ""
echo "启动服务..."
docker compose up -d openclaw-gateway task-api

echo ""
echo "=========================================="
echo "  部署完成！"
echo "=========================================="
echo ""
echo "服务状态:"
docker compose ps

echo ""
echo "访问地址:"
echo "  - OpenClaw Web UI: http://localhost:18789"
echo "  - Task API: http://localhost:3456"
echo ""
echo "下一步:"
echo "  1. 运行 'docker compose run --rm openclaw-cli onboard' 配置 OpenClaw"
echo "  2. 修改本地 Worker 的 WORKER_URL 为 http://localhost:3456"
echo "  3. 启动本地 Worker"
echo ""
echo "常用命令:"
echo "  查看日志: docker compose logs -f"
echo "  停止服务: docker compose down"
echo "  重启服务: docker compose restart"
