#!/bin/bash
# OpenClaw Worker - macOS Startup Script
#
# Usage:
# 1. Copy this file to ~/Desktop/启动Worker.command
# 2. Replace YOUR_CLOUD_IP and YOUR_TOKEN with actual values
# 3. Make executable: chmod +x ~/Desktop/启动Worker.command
# 4. Double-click to start worker

# Kill old instances
pkill -f "node worker.js" 2>/dev/null
screen -S worker -X quit 2>/dev/null

# Start worker in background with screen
screen -dmS worker bash -c 'cd ~/openclaw-worker && WORKER_URL=http://YOUR_CLOUD_IP:3456 WORKER_TOKEN=YOUR_TOKEN node worker.js'

echo "Worker 已启动！"
echo "查看日志: screen -r worker"
echo "退出日志: Ctrl+A 然后按 D"
echo ""
echo "按任意键关闭此窗口..."
read -n 1
