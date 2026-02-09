#!/bin/bash
#
# 部署脚本：上传文件到腾讯云服务器
#

set -e

# ========== 配置 ==========
# 改成你的腾讯云服务器信息
SERVER_IP="${SERVER_IP:-你的腾讯云IP}"
SERVER_USER="${SERVER_USER:-root}"
REMOTE_DIR="${REMOTE_DIR:-/root/openclaw-worker}"

# 本地项目目录
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"

# ========== 颜色输出 ==========
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# ========== 检查配置 ==========
if [[ "$SERVER_IP" == "你的腾讯云IP" ]]; then
    log_error "请先配置服务器 IP！"
    echo ""
    echo "方式 1：编辑此脚本，修改 SERVER_IP"
    echo "方式 2：通过环境变量运行："
    echo "  SERVER_IP=1.2.3.4 ./deploy.sh"
    echo ""
    exit 1
fi

# ========== 开始部署 ==========
echo ""
echo "========================================"
echo "  OpenClaw Worker 部署脚本"
echo "========================================"
echo "服务器: ${SERVER_USER}@${SERVER_IP}"
echo "远程目录: ${REMOTE_DIR}"
echo "本地目录: ${LOCAL_DIR}"
echo ""

# 1. 测试 SSH 连接
log_info "测试 SSH 连接..."
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "${SERVER_USER}@${SERVER_IP}" "echo ok" &>/dev/null; then
    log_error "SSH 连接失败！请检查："
    echo "  1. 服务器 IP 是否正确"
    echo "  2. SSH 密钥是否配置"
    echo "  3. 服务器是否开放 22 端口"
    exit 1
fi
log_info "SSH 连接成功"

# 2. 创建远程目录
log_info "创建远程目录..."
ssh "${SERVER_USER}@${SERVER_IP}" "mkdir -p ${REMOTE_DIR}"

# 3. 上传文件
log_info "上传文件..."
scp -r \
    "${LOCAL_DIR}/server.js" \
    "${LOCAL_DIR}/mac-remote-tool.js" \
    "${LOCAL_DIR}/package.json" \
    "${SERVER_USER}@${SERVER_IP}:${REMOTE_DIR}/"

# 4. 远程安装依赖（加载 nvm）
log_info "安装依赖..."
ssh "${SERVER_USER}@${SERVER_IP}" "source ~/.nvm/nvm.sh && cd ${REMOTE_DIR} && npm install --production"

# 5. 生成安全 Token（如果不存在）
log_info "检查 Token 配置..."
TOKEN_FILE="${REMOTE_DIR}/.env"
TOKEN_EXISTS=$(ssh "${SERVER_USER}@${SERVER_IP}" "test -f ${TOKEN_FILE} && echo yes || echo no")

if [[ "$TOKEN_EXISTS" == "no" ]]; then
    log_warn "生成新的安全 Token..."
    NEW_TOKEN=$(openssl rand -hex 32)
    ssh "${SERVER_USER}@${SERVER_IP}" "cat > ${TOKEN_FILE}" << EOF
WORKER_TOKEN=${NEW_TOKEN}
WORKER_PORT=3456
EOF
    echo ""
    echo "========================================"
    echo -e "${YELLOW}重要：请保存以下 Token，本地 Worker 需要用${NC}"
    echo "========================================"
    echo -e "WORKER_TOKEN=${GREEN}${NEW_TOKEN}${NC}"
    echo "========================================"
    echo ""
else
    log_info "Token 已存在，跳过生成"
    echo ""
    echo "现有 Token："
    ssh "${SERVER_USER}@${SERVER_IP}" "cat ${TOKEN_FILE}"
    echo ""
fi

# 6. 提示启动方式
echo ""
log_info "部署完成！"
echo ""
echo "========================================"
echo "  下一步操作"
echo "========================================"
echo ""
echo "1. 登录服务器启动任务 API："
echo "   ssh ${SERVER_USER}@${SERVER_IP}"
echo "   cd ${REMOTE_DIR}"
echo "   source .env && node server.js"
echo ""
echo "   或用 pm2 后台运行："
echo "   pm2 start server.js --name worker-api"
echo ""
echo "2. 本地启动 Worker（在 Mac 上运行）："
echo "   cd ${LOCAL_DIR}"
echo "   export WORKER_URL=\"http://${SERVER_IP}:3456\""
echo "   export WORKER_TOKEN=\"你的token\""
echo "   node worker.js"
echo ""
echo "3. 确保腾讯云安全组开放 3456 端口"
echo ""
