#!/bin/bash
# 电脑唤醒后自动重启 openclaw-gateway 容器

sleep 5  # 等待网络恢复
docker restart openclaw-gateway
