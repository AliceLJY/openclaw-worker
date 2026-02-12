# OpenClaw Worker Setup Wizard

**Description**: Interactive deployment guide for openclaw-worker (Task API + Worker). Walks you through environment assessment, configuration, deployment, and verification -- from zero to a running worker system.

**When to use**: When setting up openclaw-worker for the first time, reconfiguring an existing deployment, or migrating between deployment modes (Docker local vs cloud vs bare metal).

> 中文简介：交互式部署向导，帮你从零开始部署 openclaw-worker 系统（Task API + Worker），支持 Docker 本地、云端、裸机三种模式。

---

## Instructions for Claude Code

You are acting as a deployment assistant for the openclaw-worker system. Follow the phases below in order. At each decision point, **ask the user** before proceeding. Do not skip phases or make assumptions about the user's environment.

The openclaw-worker repo reference files:
- `server.js` -- Task API server (Express.js, zero external deps besides express)
- `worker.js` -- Local worker that polls Task API and executes tasks
- `mcp-server.js` -- MCP server for Claude Code integration
- `docker/` -- Docker Compose configs, Dockerfile, setup scripts
- `docs/deployment.md` -- Detailed deployment guide
- `docs/security-guide.md` -- Security best practices
- `docs/architecture.md` -- Full architecture documentation

---

## Phase 1: Environment Assessment

### 1.1 Check Prerequisites

Run these checks and report results to the user:

```bash
# Check Node.js
node --version 2>/dev/null || echo "Node.js: NOT INSTALLED"

# Check Docker
docker --version 2>/dev/null || echo "Docker: NOT INSTALLED"
docker compose version 2>/dev/null || echo "Docker Compose: NOT INSTALLED"

# Check Bun (optional, used by some skills)
bun --version 2>/dev/null || echo "Bun: not installed (optional)"

# Check Claude Code CLI (needed for claude-cli task type)
claude --version 2>/dev/null || echo "Claude Code: not installed (optional, needed for claude-cli tasks)"

# Check platform
uname -s && uname -m
```

Report the results and note any missing prerequisites.

### 1.2 Check for Existing Installation

```bash
# Check for existing worker processes
ps aux | grep -E "(worker\.js|server\.js)" | grep -v grep

# Check for existing Docker containers
docker ps --filter "name=openclaw" --format "{{.Names}}\t{{.Status}}" 2>/dev/null

# Check for existing config files
ls -la ~/.openclaw-docker/.env 2>/dev/null
ls -la ~/Library/LaunchAgents/com.openclaw.worker*.plist 2>/dev/null
```

If an existing installation is found, ask the user whether they want to:
- **Reconfigure** the existing setup
- **Start fresh** (will need to stop existing services first)
- **Add a second deployment** (e.g., add Docker local alongside existing cloud)

### 1.3 Choose Deployment Mode

Ask the user:

> Which deployment mode do you want?
>
> 1. **Docker Local** -- OpenClaw + Task API in Docker, Worker on host. Best for local use with extra security isolation. Low latency (localhost). See `docs/docker-local.md`.
>
> 2. **Cloud + Local Worker** -- Task API on a cloud server, Worker on your local machine. Best for remote access from anywhere (Discord/Slack from phone). See `docs/deployment.md`.
>
> 3. **Bare Metal (Local)** -- Task API and Worker both run directly on your machine. Simplest setup, no Docker required. Good for development/testing.
>
> (If you already have an OpenClaw bot running in Docker or cloud, you probably just need the Worker part -- let me know.)

Proceed to the corresponding phase based on the user's choice.

---

## Phase 2A: Docker Local Deployment

> This deploys OpenClaw Gateway + Task API inside Docker containers, with the Worker running on the host machine. All communication stays on localhost.

### 2A.1 Get the Code

```bash
# Clone the repo (if not already cloned)
git clone https://github.com/AliceLJY/openclaw-worker.git
cd openclaw-worker/docker
```

### 2A.2 Run the Setup Script

The repo includes a setup script at `docker/setup.sh` that handles most of the work:

```bash
chmod +x setup.sh
./setup.sh
```

This script will:
1. Verify Docker and Docker Compose are installed
2. Create config directories (`~/.openclaw-docker`, `~/openclaw-workspace`)
3. Generate `.env` with random tokens (OPENCLAW_GATEWAY_TOKEN, WORKER_TOKEN)
4. Build the Task API Docker image
5. Start services (openclaw-gateway + task-api)

**IMPORTANT**: Save the `WORKER_TOKEN` that the script outputs. The Worker needs it.

### 2A.3 Configure OpenClaw (if using Discord/Slack bot)

If the user wants a Discord/Slack bot:

```bash
# Run the OpenClaw onboard wizard
docker compose run --rm openclaw-cli onboard

# Add Discord channel (requires Discord Bot Token)
docker compose run --rm openclaw-cli channels add
```

If the user only needs the Task API (no bot), skip this step.

### 2A.4 Start the Worker

```bash
# Option 1: Use the included startup script
chmod +x start-worker.command
./start-worker.command

# Option 2: Manual start
cd .. # back to repo root
WORKER_URL=http://localhost:3456 \
WORKER_TOKEN=<token-from-setup> \
node worker.js
```

The Worker supports these task types:
- **Shell commands** (`command` field) -- execute any shell command
- **File read/write** (`type: file-read` / `type: file-write`) -- file operations
- **Claude Code CLI** (`type: claude-cli`) -- invoke local Claude Code

### 2A.5 Verify Docker Deployment

Run these verification steps:

```bash
# 1. Check Docker services are running
docker compose ps

# 2. Check Task API health
curl -s http://localhost:3456/health
# Expected: {"status":"ok","tasks":0,"results":0}

# 3. Check Worker is connected (look for polling activity in logs)
# If using screen:
screen -ls | grep worker

# 4. Submit a test task
export WORKER_TOKEN=<your-token>
TASK_RESPONSE=$(curl -s -X POST http://localhost:3456/tasks \
  -H "Authorization: Bearer $WORKER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"command": "echo Hello from openclaw-worker!", "timeout": 10000}')
echo "$TASK_RESPONSE"

# 5. Get the result (extract taskId from response above)
TASK_ID=$(echo "$TASK_RESPONSE" | grep -o '"taskId":"[^"]*"' | cut -d'"' -f4)
curl -s "http://localhost:3456/tasks/$TASK_ID?wait=10000" \
  -H "Authorization: Bearer $WORKER_TOKEN"
# Expected: {"taskId":"...","stdout":"Hello from openclaw-worker!\n","stderr":"","exitCode":0,...}
```

If all checks pass, the Docker local deployment is complete.

Proceed to **Phase 4** (Security Configuration) and **Phase 5** (Auto-start Setup).

---

## Phase 2B: Cloud + Local Worker Deployment

> This deploys the Task API on a remote cloud server. The local Worker polls it from your machine. Good for remote access via Discord/phone.

### 2B.1 Choose Cloud Provider

Ask the user:
> Which cloud provider are you using? (AWS, GCP, Azure, DigitalOcean, Hetzner, or other?)
> Do you already have a server running? If so, what OS? (Ubuntu recommended)

For Discord bot usage, the server must be able to reach Discord's API (no firewall blocking it).

### 2B.2 Deploy Task API to Cloud Server

SSH into the cloud server and run:

```bash
# Install Node.js 18+ (Ubuntu/Debian)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Create project directory
mkdir -p ~/openclaw-worker && cd ~/openclaw-worker

# Download server.js
curl -O https://raw.githubusercontent.com/AliceLJY/openclaw-worker/main/server.js

# Install dependencies
npm install express

# Generate a secure token
export WORKER_TOKEN=$(openssl rand -hex 32)
echo "WORKER_TOKEN=$WORKER_TOKEN" > .env
echo ""
echo "========================================="
echo "SAVE THIS TOKEN (Worker needs it):"
echo "$WORKER_TOKEN"
echo "========================================="
```

### 2B.3 Start Task API as a Service

**Option A: systemd (recommended for Linux servers)**

```bash
sudo tee /etc/systemd/system/openclaw-task-api.service > /dev/null <<EOF
[Unit]
Description=OpenClaw Task API
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$HOME/openclaw-worker
EnvironmentFile=$HOME/openclaw-worker/.env
Environment="WORKER_PORT=3456"
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable openclaw-task-api
sudo systemctl start openclaw-task-api
sudo systemctl status openclaw-task-api
```

**Option B: pm2**

```bash
npm install -g pm2
WORKER_TOKEN=$WORKER_TOKEN WORKER_PORT=3456 pm2 start server.js --name openclaw-task-api
pm2 save
pm2 startup  # follow the instructions it prints
```

### 2B.4 Configure Firewall

```bash
# Allow Task API port
sudo ufw allow 3456/tcp

# Verify Task API is reachable
curl http://localhost:3456/health
```

Ask the user: Do you want to set up HTTPS with nginx? (Recommended for production. See `docs/deployment.md` for the nginx + certbot setup.)

### 2B.5 Set Up Local Worker

On the user's local machine:

```bash
# Clone repo (if not already)
git clone https://github.com/AliceLJY/openclaw-worker.git
cd openclaw-worker

# Test connection to cloud Task API
curl -s http://YOUR_CLOUD_IP:3456/health

# Start worker
WORKER_URL=http://YOUR_CLOUD_IP:3456 \
WORKER_TOKEN=<token-from-cloud-setup> \
node worker.js
```

### 2B.6 Verify Cloud Deployment

From the cloud server:

```bash
# Submit test task
curl -s -X POST http://localhost:3456/tasks \
  -H "Authorization: Bearer $WORKER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"command": "hostname && date", "timeout": 15000}'

# Get result (replace TASK_ID)
curl -s "http://localhost:3456/tasks/TASK_ID?wait=15000" \
  -H "Authorization: Bearer $WORKER_TOKEN"
```

The result should show your local machine's hostname, confirming the cloud-to-local pipeline works.

Proceed to **Phase 4** (Security) and **Phase 5** (Auto-start).

---

## Phase 2C: Bare Metal (Local) Deployment

> Both Task API and Worker run directly on your machine. No Docker needed. Simplest setup.

### 2C.1 Install Dependencies

```bash
# macOS
brew install node

# Linux (Ubuntu/Debian)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2C.2 Get the Code and Install

```bash
git clone https://github.com/AliceLJY/openclaw-worker.git
cd openclaw-worker
npm install
```

### 2C.3 Generate Token

```bash
# Generate a shared secret
export WORKER_TOKEN=$(openssl rand -hex 32)
echo "WORKER_TOKEN=$WORKER_TOKEN"
# Save this -- both server and worker need it
```

### 2C.4 Start Task API

```bash
# Terminal 1: Start the Task API
WORKER_TOKEN=$WORKER_TOKEN WORKER_PORT=3456 node server.js
```

You should see:
```
Task API running on port 3456
Auth token: xxxxxxxx...
```

### 2C.5 Start Worker

```bash
# Terminal 2: Start the Worker
WORKER_URL=http://127.0.0.1:3456 \
WORKER_TOKEN=$WORKER_TOKEN \
node worker.js
```

You should see the worker start polling for tasks.

### 2C.6 Verify Bare Metal Deployment

```bash
# Terminal 3: Submit a test task
curl -s -X POST http://127.0.0.1:3456/tasks \
  -H "Authorization: Bearer $WORKER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"command": "echo It works! && date", "timeout": 10000}'

# Get result
TASK_ID=<from-response>
curl -s "http://127.0.0.1:3456/tasks/$TASK_ID?wait=10000" \
  -H "Authorization: Bearer $WORKER_TOKEN"
```

---

## Phase 3: Claude Code CLI Integration (Optional)

If the user wants to execute Claude Code tasks remotely (the `claude-cli` task type):

### 3.1 Verify Claude Code is Installed

```bash
claude --version
```

If not installed:
```bash
# macOS
brew install claude

# Or via npm
npm install -g @anthropic-ai/claude-code
```

### 3.2 Authenticate Claude Code

```bash
# OAuth login (recommended for personal use with Max subscription)
claude login

# Verify authentication
claude auth status
```

**Important**: The Worker must run in a **login shell** (`bash -l` or `zsh -l`) to access macOS Keychain where OAuth tokens are stored. This is already handled in the startup scripts, but if you run the worker manually, use:

```bash
/bin/bash -l -c "WORKER_URL=... WORKER_TOKEN=... node worker.js"
```

### 3.3 Test Claude Code via Task API

```bash
# Submit a Claude Code task
TASK_RESPONSE=$(curl -s -X POST http://localhost:3456/claude \
  -H "Authorization: Bearer $WORKER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "What is 2+2? Reply with just the number.", "timeout": 60000}')
echo "$TASK_RESPONSE"

TASK_ID=$(echo "$TASK_RESPONSE" | grep -o '"taskId":"[^"]*"' | cut -d'"' -f4)

# Wait for result
curl -s "http://localhost:3456/tasks/$TASK_ID?wait=60000" \
  -H "Authorization: Bearer $WORKER_TOKEN"
```

---

## Phase 4: Security Configuration

### 4.1 Token Security

The `WORKER_TOKEN` / `API_SECRET` is the single authentication credential. Generate a strong one:

```bash
# Generate 32-byte hex token (64 characters)
openssl rand -hex 32
```

**Rules**:
- Never commit tokens to git (`.env` is in `.gitignore`)
- Rotate tokens periodically: generate a new token, update both server and worker, restart both
- Use different tokens for different deployments (Docker local vs cloud)

### 4.2 HTTPS (Cloud Deployments)

For cloud deployments, set up HTTPS with a reverse proxy. See `docs/deployment.md` for the full nginx + Let's Encrypt setup.

Minimal nginx config:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3456;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_read_timeout 120s;  # Must be > long poll wait time
    }
}
```

Then: `sudo certbot --nginx -d your-domain.com`

### 4.3 Allowed Origins (Cloud Deployments)

If exposing the Task API to the internet, restrict which IPs can access it:

```bash
# UFW: only allow your home IP
sudo ufw allow from YOUR_HOME_IP to any port 3456

# Or use nginx IP restriction
```

### 4.4 Security Principles

Reference `docs/security-guide.md` for prompt injection defense. Key points:

1. **Task queue = audit trail** -- every operation is logged with timestamp
2. **Worker permissions** -- the worker runs with the user's permissions, not root
3. **Network isolation** -- Docker deployments add container-level isolation
4. **No credential storage** -- Worker does not store passwords; OAuth tokens are in macOS Keychain

---

## Phase 5: Auto-Start Setup

### 5.1 macOS: launchd (Recommended)

Create a launchd plist for the Worker:

```bash
cat > ~/Library/LaunchAgents/com.openclaw.worker.plist << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.openclaw.worker</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-l</string>
        <string>-c</string>
        <string>sleep 30 &amp;&amp; cd /path/to/openclaw-worker &amp;&amp; WORKER_URL=http://YOUR_SERVER:3456 WORKER_TOKEN=YOUR_TOKEN node worker.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/openclaw-worker.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/openclaw-worker.err</string>
</dict>
</plist>
PLIST
```

**Ask the user** for their actual values:
- Path to the openclaw-worker directory
- WORKER_URL (localhost:3456 for Docker local, cloud IP for cloud mode)
- WORKER_TOKEN

Then substitute them in the plist and load it:

```bash
launchctl load ~/Library/LaunchAgents/com.openclaw.worker.plist

# Verify
launchctl list | grep openclaw
tail -f /tmp/openclaw-worker.log
```

Key settings explained (see `docs/architecture.md`):
- `RunAtLoad: true` -- start on login
- `KeepAlive: true` -- auto-restart on crash
- `sleep 30` -- wait for network after boot
- `-l` (login shell) -- needed for Claude Code OAuth/Keychain access

### 5.2 Linux: systemd

```bash
sudo tee /etc/systemd/system/openclaw-worker.service > /dev/null <<EOF
[Unit]
Description=OpenClaw Worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=/path/to/openclaw-worker
Environment="WORKER_URL=http://YOUR_SERVER:3456"
Environment="WORKER_TOKEN=YOUR_TOKEN"
ExecStart=/usr/bin/node worker.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable openclaw-worker
sudo systemctl start openclaw-worker
```

### 5.3 Docker Local: Auto-start with Docker

If using Docker local deployment, Docker Desktop handles container auto-start via `restart: always` in docker-compose.yml. You only need auto-start for the Worker (which runs on the host).

---

## Phase 6: MCP Server Setup (Optional)

If the user wants to use the MCP server to give Claude Code (or other MCP clients) remote Mac execution capabilities:

### 6.1 Understand the MCP Server

The `mcp-server.js` file provides a single MCP tool (`mac_remote`) that executes shell commands on the remote Mac via the Task API. This is useful when:
- You have Claude Code running on a cloud server and want it to execute commands on your local Mac
- You want to expose the worker as an MCP tool for any MCP-compatible client

### 6.2 Configure MCP Server

Add to your Claude Code MCP config (`~/.claude/mcp.json` or project-level):

```json
{
  "mcpServers": {
    "mac-remote": {
      "command": "node",
      "args": ["/path/to/openclaw-worker/mcp-server.js"],
      "env": {
        "MAC_WORKER_URL": "http://YOUR_TASK_API:3456",
        "MAC_WORKER_TOKEN": "your-token-here"
      }
    }
  }
}
```

### 6.3 Test MCP Integration

After configuring, restart Claude Code and verify the `mac_remote` tool is available. Ask Claude Code to run a simple command on your Mac to confirm it works.

---

## Phase 7: Summary and Next Steps

After completing the setup, provide the user with:

1. **What is running**:
   - Task API: where it is, what port, how to check health
   - Worker: where it is, how to view logs
   - Auto-start: whether it is configured

2. **Key files and configs**:
   - `.env` location (contains tokens -- do not commit to git)
   - Log file locations
   - Startup script / plist / systemd unit locations

3. **Useful commands**:
   ```bash
   # Check Task API health
   curl http://localhost:3456/health

   # View worker logs (macOS launchd)
   tail -f /tmp/openclaw-worker.log

   # View worker logs (screen)
   screen -r worker

   # Submit a test task
   curl -X POST http://localhost:3456/tasks \
     -H "Authorization: Bearer $WORKER_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"command": "echo hello", "timeout": 10000}'

   # Docker: check services
   docker compose ps

   # Docker: view logs
   docker compose logs -f
   ```

4. **Next steps to suggest**:
   - Set up a Discord/Slack bot with OpenClaw to submit tasks (see `docs/claude-code-integration.md`)
   - Configure cron tasks for automation (see `examples/cron-tasks.md`)
   - Set up multi-persona Discord channels (see `examples/multi-persona.md`)
   - Review security guide (see `docs/security-guide.md`)

---

## Troubleshooting Reference

If the user encounters issues at any point, use these diagnostics:

### Worker cannot connect to Task API

```bash
# 1. Is the Task API running?
curl -s http://TASK_API_HOST:3456/health

# 2. Is the port reachable? (cloud deployments)
nc -zv TASK_API_HOST 3456

# 3. Is the token correct?
curl -s -H "Authorization: Bearer $WORKER_TOKEN" http://TASK_API_HOST:3456/health
# If 401: token mismatch

# 4. Firewall blocking? (cloud)
sudo ufw status
```

### Claude Code tasks fail with 403 or auth errors

```bash
# 1. Is Claude Code logged in?
claude auth status

# 2. Is Worker using login shell?
# The worker MUST run with bash -l or zsh -l for Keychain access
/bin/bash -l -c "claude auth status"

# 3. Re-login if needed
claude login
# Then restart the worker
```

### Tasks stuck in "pending" state

```bash
# Worker is not polling. Check:
# 1. Is worker process running?
ps aux | grep worker.js

# 2. Check worker logs for connection errors
tail -50 /tmp/openclaw-worker.log

# 3. Is worker pointing to the right Task API?
# Check WORKER_URL in the worker's environment
```

### Docker containers not starting

```bash
# Check docker compose logs
docker compose logs

# Check for port conflicts
lsof -i :3456
lsof -i :18789

# Rebuild if needed
docker compose build --no-cache
docker compose up -d
```
