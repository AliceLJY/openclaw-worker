# OpenClaw Worker

> Remote control your local computer from cloud services without port forwarding or VPN.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)

**OpenClaw Worker** is a lightweight polling-based architecture that enables cloud services (Discord bots, Slack bots, web dashboards) to securely execute commands on local computers behind NAT/firewall without requiring port forwarding, VPN, or SSH tunnels.

```
┌─────────────┐     ┌──────────────────────────┐     ┌─────────────────────┐
│   Client    │────▶│   Cloud Task API         │◀────│   Local Worker      │
│  (Discord)  │     │  (Task Queue + Polling)  │     │  (Executes Tasks)   │
└─────────────┘     └──────────────────────────┘     └─────────────────────┘
```

## Why Another Remote Control Solution?

### The Problem

You want to control your home computer from anywhere (Discord, Slack, phone), but:
- **Port forwarding** exposes your computer to the internet
- **VPN/Tailscale** requires installation on both ends
- **SSH tunnels** (`ssh -R`) are fragile and require maintaining persistent connections
- **OpenClaw native remote** requires installing OpenClaw locally and dealing with token mismatch issues

### The Solution

**Polling architecture**: The local worker actively polls the cloud API for tasks. No inbound connections needed.

```
Cloud API: "Got work?"
Worker:    "Yep, sending results..."
```

Simple. Secure. Works everywhere.

## Features

- 🚀 **No Port Forwarding**: Worker polls cloud API, no inbound connections
- 🔒 **Secure**: Token-based authentication, all traffic HTTPS
- ⚡ **Concurrent Execution**: Handle multiple tasks simultaneously
- 🌐 **Platform Agnostic**: Works with Discord, Slack, or any HTTP client
- 🛠️ **Multiple Task Types**:
  - Shell commands
  - File read/write operations
  - Claude Code CLI execution
  - Custom task types (extensible)
- 🔄 **Long Polling**: Efficient task result retrieval with timeout support
- 📦 **Zero Dependencies**: Pure Node.js implementation
- 🔌 **Auto-recovery**: Worker auto-restarts on wake from sleep (macOS)

## Quick Start

### Prerequisites

- Node.js 18+
- A cloud server (for Task API)
- A local computer to control

### 1. Deploy Cloud Task API

On your cloud server:

```bash
# Download server.js
curl -O https://raw.githubusercontent.com/AliceLJY/openclaw-worker/main/server/server.js

# Install dependencies
npm install express

# Generate secure token
export WORKER_TOKEN=$(openssl rand -hex 32)
echo "Your token: $WORKER_TOKEN"  # Save this!

# Start server
export WORKER_PORT=3456
node server.js

# Or use pm2 for production
pm2 start server.js --name openclaw-api
```

Server will run on `http://YOUR_SERVER_IP:3456`

### 2. Start Local Worker

On your local computer:

```bash
# Download worker.js
curl -O https://raw.githubusercontent.com/AliceLJY/openclaw-worker/main/worker/worker.js

# Configure
export WORKER_URL=http://YOUR_SERVER_IP:3456
export WORKER_TOKEN=<token_from_step_1>

# Start worker
node worker.js

# Or run in background with screen
screen -dmS worker bash -c 'WORKER_URL=http://YOUR_SERVER_IP:3456 WORKER_TOKEN=xxx node worker.js'
```

### 3. Test Connection

```bash
# Submit a task
curl -X POST http://YOUR_SERVER_IP:3456/tasks \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"command": "echo Hello from remote!", "timeout": 30000}'

# Response: {"taskId": "abc-123", "message": "Task created, waiting for worker"}

# Get result (with 30s long polling)
curl "http://YOUR_SERVER_IP:3456/tasks/abc-123?wait=30000" \
  -H "Authorization: Bearer YOUR_TOKEN"

# Response: {"stdout": "Hello from remote!", "exitCode": 0}
```

## Architecture

### Components

| Component | Location | Purpose |
|-----------|----------|---------|
| **Task API** | Cloud server | Manages task queue, receives requests from clients |
| **Worker** | Local computer | Polls API, executes tasks, reports results |
| **Client** | Anywhere | Submits tasks via HTTP (Discord bot, scripts, etc.) |

### Task Lifecycle

```
1. Client submits task → Task API creates task (status: pending)
2. Worker polls API → Gets task, marks as running
3. Worker executes task → Captures output
4. Worker reports result → Task API stores result
5. Client retrieves result → Long polling with timeout
```

### Security Model

- **Authentication**: Bearer token in `Authorization` header
- **No Credentials Storage**: Worker doesn't store passwords or keys
- **Sandboxed Execution**: Commands run with worker's user permissions
- **Transport Security**: Use HTTPS in production (recommended)

## API Reference

### Submit Shell Command

```bash
POST /tasks
Authorization: Bearer YOUR_TOKEN
Content-Type: application/json

{
  "command": "ls -la /tmp",
  "timeout": 30000
}
```

### Execute Claude Code CLI

```bash
POST /claude
Authorization: Bearer YOUR_TOKEN
Content-Type: application/json

{
  "prompt": "List files in current directory and summarize",
  "timeout": 120000
}
```

### File Operations

```bash
# Read file
POST /files/read
{"path": "/path/to/file"}

# Write file
POST /files/write
{"path": "/path/to/file", "content": "data", "encoding": "utf8"}
```

### Get Task Result

```bash
GET /tasks/:taskId?wait=60000
Authorization: Bearer YOUR_TOKEN

# Response:
{
  "taskId": "abc-123",
  "stdout": "output here",
  "stderr": "",
  "exitCode": 0,
  "completedAt": 1234567890
}
```

See [docs/api.md](docs/api.md) for complete API documentation.

## Integration Examples

### Discord Bot

```javascript
const response = await fetch(`${API_URL}/claude`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${TOKEN}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    prompt: userMessage,
    timeout: 120000
  })
});

const { taskId } = await response.json();

// Long poll for result
const result = await fetch(`${API_URL}/tasks/${taskId}?wait=120000`, {
  headers: { 'Authorization': `Bearer ${TOKEN}` }
});

await discordChannel.send(result.stdout);
```

See [examples/discord-bot/](examples/discord-bot/) for complete implementation.

### Slack Integration

See [examples/slack-bot/](examples/slack-bot/)

### Web Dashboard

See [examples/web-dashboard/](examples/web-dashboard/)

## Configuration

### Worker Environment Variables

```bash
WORKER_URL=http://YOUR_SERVER_IP:3456  # Task API URL
WORKER_TOKEN=xxx                       # Auth token
POLL_INTERVAL=500                      # Polling interval (ms)
MAX_CONCURRENT=3                       # Max concurrent tasks
```

### Server Environment Variables

```bash
WORKER_TOKEN=xxx    # Auth token (must match worker)
WORKER_PORT=3456    # Server port
```

## Advanced Usage

### Auto-start on Wake (macOS)

```bash
# Install sleepwatcher
brew install sleepwatcher

# Create wake script
cat > ~/.wakeup << 'EOF'
#!/bin/bash
screen -dmS worker bash -c 'cd ~/openclaw-worker && WORKER_URL=xxx WORKER_TOKEN=xxx node worker.js'
EOF
chmod +x ~/.wakeup

# Enable sleepwatcher
brew services start sleepwatcher
```

### Production Deployment

- Use **pm2** or **systemd** to manage processes
- Set up **log rotation** for long-running workers
- Use **HTTPS** with reverse proxy (nginx/caddy)
- Implement **rate limiting** on Task API
- Monitor with **health check endpoint** (`/health`)

## Why This Approach?

### Evolution from Previous Solutions

I originally tried several approaches before landing on this architecture:

**Attempt 1: SSH Reverse Tunnel**
```bash
ssh -R 18789:localhost:18789 cloud-server
```
- ❌ Connections drop frequently
- ❌ Requires SSH access to cloud server
- ❌ OpenClaw token mismatch issues

**Attempt 2: Tailscale Serve**
```bash
tailscale serve --bg 18789
```
- ❌ SSL handshake failures with WebSocket
- ❌ Requires Tailscale on both ends

**Attempt 3: Native OpenClaw Remote**
- ❌ Confusing dual-token authentication
- ❌ Requires installing OpenClaw locally
- ❌ `exec-approvals` socket issues

**Final Solution: Polling Architecture**
- ✅ No persistent connections
- ✅ Works behind any firewall/NAT
- ✅ Simple HTTP API
- ✅ Self-healing (auto-reconnect)

See [docs/background.md](docs/background.md) for the complete journey.

## Use Cases

- 🤖 **Discord/Slack Bot** controlling local computer
- 🎨 **Content automation** (generate images, publish articles)
- 📊 **Remote monitoring** (check Docker containers, disk space)
- 🔧 **CI/CD triggers** from cloud to local dev environment
- 📱 **Mobile control** of home automation scripts

## Limitations

- **Not real-time**: 500ms polling interval (adjustable)
- **Stateless**: No persistent sessions between tasks
- **Single-direction**: Worker can't initiate tasks on its own
- **Trust required**: Client must trust cloud API security

## Contributing

Contributions welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Acknowledgments

- Inspired by the need for simple remote control without VPN complexity
- Built for the [OpenClaw](https://github.com/openclaw/openclaw) ecosystem
- Works great with [baoyu-skills](https://github.com/JimLiu/baoyu-skills) for content automation

## Support

- 📖 [Documentation](docs/)
- 🐛 [Issue Tracker](https://github.com/AliceLJY/openclaw-worker/issues)
- 💬 [Discussions](https://github.com/AliceLJY/openclaw-worker/discussions)

---

Made with ☕ by [@AliceLJY](https://github.com/AliceLJY)
