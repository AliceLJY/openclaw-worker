# Task API Dockerfile
# 简单的 Node.js 服务，提供任务队列 API

FROM node:22-alpine

WORKDIR /app

# 安装依赖
COPY package.json ./
RUN npm install --production

# 复制源码
COPY server.js ./

# 暴露端口
EXPOSE 3456

# 启动服务
CMD ["node", "server.js"]
