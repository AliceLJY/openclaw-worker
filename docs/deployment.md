# Deployment Guide

This guide covers deploying OpenClaw Worker in a real-world setup.

## Architecture Philosophy

### The Security Problem: Why Not Run OpenClaw Locally?

OpenClaw is incredibly powerful. When running locally, it has access to:
- 📁 Your entire file system (read/write)
- ⚙️ System commands (execute anything)
- 🎯 Application control (Obsidian, Notes, Things, etc.)
- 📷 Hardware access (camera, microphone, screen recording)
- 🔐 Sensitive data (documents, credentials, personal files)

**That's a lot of trust.** If OpenClaw gets compromised through:
- Prompt injection attacks
- Malicious skills from the community
- Bugs in channel integrations
- Social engineering via Discord/WhatsApp messages

...your entire computer is at risk.

### The Solution: Cloud Deployment + Worker Architecture

By deploying OpenClaw in the cloud with a local worker, we add critical security layers:

```
❌ Direct Local OpenClaw:
User → OpenClaw (full local permissions) → Unrestricted access

✅ Cloud OpenClaw + Worker:
User → Cloud OpenClaw → Task Queue → Worker → Restricted local execution
           ↓               ↓            ↓
      (Isolated)    (Audit trail)  (Sandboxed)
```

**Security Benefits**:
1. **Isolation**: Compromised cloud OpenClaw can't directly access local files
2. **Audit Trail**: Every local operation logged in task queue
3. **Restricted Execution**: Worker runs with configurable permissions
4. **Review Gate**: Can add approval step before execution (optional)
5. **Network Boundary**: Physical separation between decision and execution

### Three-Layer Collaboration: The Best of All Worlds

This architecture enables something neither tool can do alone:

```
User Message (WhatsApp/Telegram/Discord/Phone)
    ↓
┌──────────────────────────────────────────────────┐
│ Layer 1: Cloud OpenClaw (MiniMax API)            │
│  ✓ Multi-channel orchestration (10+ platforms)   │
│  ✓ Persistent memory across conversations        │
│  ✓ Self-iteration and learning                   │
│  ✓ Multi-agent coordination                      │
│  ✓ Session management                            │
└──────────────────────────────────────────────────┘
    ↓ Need powerful AI?          ↓ Need local access?
    ↓                            ↓
┌─────────────────────┐    ┌───────────────────────────┐
│ Layer 2: Cloud      │    │ Layer 3: Worker           │
│ Claude Code (Max)   │    │  → Local Claude Code (Max)│
│                     │    │                           │
│ ✓ Complex reasoning │    │ ✓ Local file operations   │
│ ✓ Code generation   │    │ ✓ Mac-specific automation │
│ ✓ Deep analysis     │    │ ✓ Hardware access         │
│ ✓ Cloud file ops    │    │ ✓ Private data access     │
└─────────────────────┘    └───────────────────────────┘
```

**Note**: Both cloud and local use the same Claude Code CLI with your Max subscription (OAuth). No additional API costs - one subscription works everywhere.

### Why Not Just Use Local Claude Code?

You might ask: "Claude Code is already powerful. Why add OpenClaw?"

**Claude Code alone lacks**:
- ❌ Persistent memory (conversations don't persist across sessions)
- ❌ Multi-channel access (can't respond on WhatsApp/Telegram/Discord)
- ❌ Self-iteration (no learning from past interactions)
- ❌ Multi-agent coordination (can't route to specialized agents)
- ❌ Always-on availability (needs active terminal session)

**OpenClaw alone is risky**:
- ❌ Too much local permission if run locally
- ❌ Complex setup for remote access (SSH tunnels, tokens)
- ❌ Uses weaker API (MiniMax) for cost reasons

**Together, they're unstoppable**:
- ✅ OpenClaw handles orchestration and memory (safely in cloud)
- ✅ Claude Code provides powerful AI (cloud for reasoning, local for execution)
- ✅ Worker provides secure bridge (task queue + audit trail)
- ✅ You get multi-channel AI with local access AND security

### Cost-Optimized AI Usage

**Problem**: Using Claude Max for every simple routing decision is overkill.

**Solution**: Strategic API usage based on task complexity.

| Task Type | Handled By | API Cost |
|-----------|------------|----------|
| "Route this message" | OpenClaw (MiniMax) | ~$0.0001 |
| "Is @bot mentioned?" | OpenClaw (MiniMax) | ~$0.0001 |
| "Write complex script" | Cloud Claude Code (Max) | Subscription |
| "Read local Obsidian note" | Local Claude Code (Max) | Subscription |
| "Analyze codebase" | Cloud Claude Code (Max) | Subscription |

**Monthly Cost**:
- MiniMax API (OpenClaw routing): $0-5/month (free tier sufficient)
- Claude Max subscription: $20/month (unlimited usage, works cloud + local)
- **Total**: ~$20-25/month for unlimited AI with security

Compare to:
- Claude API only: $50-200/month depending on usage
- OpenClaw local: Free but risky security-wise
- Multiple API subscriptions: $40+ per service

## Reference Architecture

The architecture described here is based on a production deployment controlling a local Mac from Discord via cloud infrastructure.

```
┌──────────────┐     ┌────────────────────────────────┐     ┌─────────────────────┐
│   Discord    │────▶│   Cloud Server                 │◀────│   Local Mac         │
│   Client     │     │   • OpenClaw (MiniMax API)     │     │   • Worker          │
│   (Mobile)   │     │   • Claude Code (Max)          │     │   • Claude Code (Max)│
└──────────────┘     │   • Task API (Node.js)         │     │   • baoyu-skills    │
                     └────────────────────────────────┘     └─────────────────────┘
```

## Tested Environment

### Cloud Server

**Provider**: Tencent Cloud Lighthouse (Silicon Valley)
- **Reason**: International location required for Discord API access
- **Specs**: 2 vCPU, 2GB RAM, 40GB SSD
- **OS**: Ubuntu 20.04 LTS
- **Services**:
  - [OpenClaw](https://github.com/openclaw/openclaw) (with MiniMax API key for routing)
  - Claude Code CLI (Max subscription via OAuth, not API)
  - Task API (this project's server.js)

**Why this config**:
- 2C2G is sufficient for lightweight task queuing
- International server bypasses China's Discord firewall
- Claude Code uses same Max subscription (OAuth) on both cloud and local
- MiniMax API handles OpenClaw's routing decisions (cheap and fast)

### Local Computer

**Hardware**: MacBook Air M4, 16GB RAM
**OS**: macOS Sequoia (or later)
**Services**:
- Worker (this project's worker.js)
- Claude Code CLI (Max subscription via OAuth, same account as cloud)
- baoyu-skills (optional, for extended capabilities like image generation)

**Why this setup**:
- Mac required for macOS-specific automation
- M4 chip handles AI-assisted tasks efficiently
- Claude Code uses Max subscription (OAuth), not API - same account works on cloud and local
- No extra API costs beyond the Max subscription itself

## Step-by-Step Deployment

### 1. Cloud Server Setup

#### 1.1 Install Node.js

```bash
# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify
node --version  # Should be 18+
```

#### 1.2 Deploy Task API

```bash
# Create project directory
mkdir ~/openclaw-worker && cd ~/openclaw-worker

# Download server.js
curl -O https://raw.githubusercontent.com/YOUR_USERNAME/openclaw-worker/main/server/server.js

# Install dependencies
npm install express

# Generate secure authentication token
export WORKER_TOKEN=$(openssl rand -hex 32)
echo "IMPORTANT: Save this token somewhere safe!"
echo "Token: $WORKER_TOKEN"

# Create systemd service (recommended for production)
sudo tee /etc/systemd/system/openclaw-worker.service > /dev/null <<EOF
[Unit]
Description=OpenClaw Worker Task API
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$HOME/openclaw-worker
Environment="WORKER_TOKEN=$WORKER_TOKEN"
Environment="WORKER_PORT=3456"
ExecStart=/usr/bin/node server.js
Restart=always

[Install]
WantedBy=multi-user.target
EOF

# Start service
sudo systemctl enable openclaw-worker
sudo systemctl start openclaw-worker

# Check status
sudo systemctl status openclaw-worker
```

**Alternative: Using pm2**

```bash
npm install -g pm2
pm2 start server.js --name openclaw-api
pm2 save
pm2 startup
```

#### 1.3 Configure Firewall

```bash
# Allow Task API port (if using UFW)
sudo ufw allow 3456/tcp

# Verify
curl http://localhost:3456/health
```

#### 1.4 Optional: Setup HTTPS with Nginx

```bash
# Install nginx
sudo apt-get install nginx certbot python3-certbot-nginx

# Create nginx config
sudo tee /etc/nginx/sites-available/openclaw-worker > /dev/null <<EOF
server {
    listen 80;
    server_name YOUR_DOMAIN;

    location / {
        proxy_pass http://localhost:3456;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF

# Enable site
sudo ln -s /etc/nginx/sites-available/openclaw-worker /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# Get SSL certificate
sudo certbot --nginx -d YOUR_DOMAIN
```

### 2. Local Mac Setup

#### 2.1 Install Prerequisites

```bash
# Install Homebrew (if not already installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install Node.js
brew install node

# Verify
node --version  # Should be 18+
```

#### 2.2 Install Claude Code

```bash
# Install Claude Code CLI
brew install claude

# Verify installation
claude --version
```

**Authentication: Choose Your Method**

Claude Code supports three authentication methods:

**Method 1: OAuth Login (Recommended for personal use)** ⭐
```bash
claude login
```
- Opens browser for OAuth authentication
- Uses your Claude.ai subscription (Pro/Max)
- Token stored in macOS Keychain
- Same subscription works on cloud and local machines
- **This is what we use in this project**

**Method 2: API Key (For enterprise/API billing)**
```bash
claude login --api-key
# Or set environment variable
export ANTHROPIC_API_KEY="your-api-key"
```
- Uses Anthropic API key
- Pay-per-use billing, separate from subscription
- Good for API quota management

**Method 3: Long-term Token (For servers/automation)**
```bash
claude setup-token
```
- Sets up long-term authentication token (requires Claude subscription)
- Works in headless environments (servers, CI/CD)
- No browser interaction needed

**Important Notes**:
- ✅ The same Claude Max subscription account can be used on both cloud and local machines (Method 1)
- ✅ This is NOT an API key authentication - Methods 1 and 3 use subscription-based auth
- ⚠️ Method 1 (OAuth) is recommended for this project setup
- ⚠️ After authentication, Worker must be restarted to recognize the credentials

#### 2.3 Deploy Worker

```bash
# Create project directory
mkdir ~/openclaw-worker && cd ~/openclaw-worker

# Download worker.js
curl -O https://raw.githubusercontent.com/YOUR_USERNAME/openclaw-worker/main/worker/worker.js

# Make executable
chmod +x worker.js

# Test run (replace with your actual values)
WORKER_URL=http://YOUR_CLOUD_IP:3456 \
WORKER_TOKEN=your_token_here \
node worker.js

# Should see:
# OpenClaw Worker v1.0
# Server: http://YOUR_CLOUD_IP:3456
# Poll interval: 500ms
# ...
```

#### 2.4 Create Startup Script

**IMPORTANT**: Worker must use **login shell** (`bash -l`) to access Claude Code authentication tokens.

```bash
# Create desktop shortcut
cat > ~/Desktop/启动Worker.command << 'EOF'
#!/bin/bash
# Kill old worker process
pkill -f "node worker.js" 2>/dev/null
screen -S worker -X quit 2>/dev/null

# Start worker with LOGIN SHELL (-l flag is critical!)
screen -dmS worker bash -l -c '
  cd ~/openclaw-worker && \
  WORKER_URL=http://YOUR_CLOUD_IP:3456 \
  WORKER_TOKEN=your_token_here \
  POLL_INTERVAL=500 \
  MAX_CONCURRENT=3 \
  node worker.js
'
echo "Worker started in background (screen session: worker)"
echo "To view logs: screen -r worker"
echo "To detach: Ctrl+A then D"
EOF

chmod +x ~/Desktop/启动Worker.command

# Double-click to start
```

**Why `-l` flag matters**:
- Without `-l`: Non-login shell, doesn't load full environment, **can't access Keychain for Claude OAuth**
- With `-l`: Login shell, loads `~/.zshrc` or `~/.bashrc`, **can access Claude authentication**

**Troubleshooting Authentication**:
```bash
# Test if Worker environment can access Claude auth
/bin/bash -l -c "claude auth status"

# Should show:
# ✅ "Logged in as ..." (OAuth working)
# ❌ "Invalid API key" (needs login shell or reauth)

# If authentication fails in Worker:
1. Verify Claude login: claude login
2. Kill old worker: pkill -f "node worker.js"
3. Restart worker: ~/Desktop/启动Worker.command
4. Test again from Discord/API
```

#### 2.5 Auto-start on Wake (macOS)

```bash
# Install sleepwatcher
brew install sleepwatcher

# Create wake script
cat > ~/.wakeup << 'EOF'
#!/bin/bash
# Auto-restart worker on wake from sleep
screen -dmS worker bash -c '
  cd ~/openclaw-worker && \
  WORKER_URL=http://YOUR_CLOUD_IP:3456 \
  WORKER_TOKEN=your_token_here \
  node worker.js
'
EOF

chmod +x ~/.wakeup

# Enable sleepwatcher
brew services start sleepwatcher

# Verify
brew services list | grep sleepwatcher
```

### 3. Discord Bot Configuration

If using OpenClaw's Discord integration, configure the bot to use Task API:

```markdown
## Bot Memory: Local Mac Control

API Server: http://YOUR_CLOUD_IP:3456
Auth Token: Bearer your_token_here

### Available APIs

1. Execute Claude Code locally:
   POST /claude {"prompt": "...", "timeout": 120000}
   GET /tasks/:id?wait=120000

2. Run shell commands:
   POST /tasks {"command": "...", "timeout": 30000}
   GET /tasks/:id?wait=30000

3. File operations:
   POST /files/read {"path": "/path/to/file"}
   POST /files/write {"path": "/path/to/file", "content": "..."}
   GET /tasks/:id?wait=10000

Auto-select appropriate API based on user request.
```

## Verification

### Test Cloud → Local Communication

On cloud server:

```bash
# Submit test task
curl -X POST http://localhost:3456/tasks \
  -H "Authorization: Bearer $WORKER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"command": "echo Hello from cloud!", "timeout": 30000}'

# Note the taskId from response

# Get result (wait up to 30s)
curl "http://localhost:3456/tasks/TASK_ID?wait=30000" \
  -H "Authorization: Bearer $WORKER_TOKEN"

# Should see: {"stdout": "Hello from cloud!", "exitCode": 0}
```

### Test Claude Code Integration

```bash
# Test local Claude Code execution
curl -X POST http://localhost:3456/claude \
  -H "Authorization: Bearer $WORKER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "What is the current date?", "timeout": 120000}'

# Get result
curl "http://localhost:3456/tasks/TASK_ID?wait=120000" \
  -H "Authorization: Bearer $WORKER_TOKEN"
```

## Monitoring

### Check Worker Status

```bash
# On Mac
screen -r worker  # View worker logs
# Ctrl+A then D to detach

# Or check if running
ps aux | grep "node worker.js"
```

### Check Task API Status

```bash
# On cloud server
curl http://localhost:3456/health

# Expected: {"status":"ok","tasks":0,"results":0}

# View logs (systemd)
sudo journalctl -u openclaw-worker -f

# View logs (pm2)
pm2 logs openclaw-api
```

## Troubleshooting

### Worker Can't Connect to API

**Symptoms**: "Connection failed" errors in worker logs

**Solutions**:
1. Check firewall: `sudo ufw status`
2. Verify API is running: `curl http://CLOUD_IP:3456/health`
3. Test from Mac: `curl http://CLOUD_IP:3456/health`

### Authentication Failures

**Symptoms**: 401 Unauthorized errors

**Solutions**:
1. Verify token matches on both ends
2. Check `Authorization` header format: `Bearer <token>`
3. Regenerate token if compromised

### Claude Code Authentication Errors

**Symptoms**: "403 Forbidden", "Not logged in", or "Invalid API key" when Worker executes Claude tasks

**Root Cause**: Worker can't access Claude Code authentication credentials

**Step 1: Choose Authentication Method**

Claude Code supports three authentication methods:

**Method 1: OAuth (Recommended for personal use)** ⭐
```bash
claude login  # Opens browser for authentication
```
- Uses Claude.ai subscription (Pro/Max)
- Token stored in macOS Keychain
- Same subscription works on cloud and local
- **Requires login shell to access Keychain**

**Method 2: API Key (For enterprise/pay-per-use)**
```bash
claude login --api-key
# Or
export ANTHROPIC_API_KEY="your-api-key"
```
- Uses Anthropic API key
- Pay-per-use billing
- Doesn't need Keychain access

**Method 3: Long-term Token (For servers/automation)**
```bash
claude setup-token  # No browser needed
```
- For headless environments (servers, CI/CD)
- Requires Claude subscription
- Doesn't need login shell

**Step 2: Verify Authentication**
```bash
claude auth status
# Should show: "Logged in as ..." or API key status
```

**Step 3: Ensure Worker Uses Login Shell (for OAuth)**

⚠️ **CRITICAL for OAuth users**: Worker MUST use login shell (`-l` flag):

```bash
# ❌ Wrong (can't access Keychain):
screen -dmS worker bash -c 'node worker.js'

# ✅ Correct (accesses full environment):
screen -dmS worker bash -l -c 'node worker.js'
```

**Why this matters**:
- Non-login shell: No `~/.zshrc`/`~/.bashrc` → No Keychain access → Auth fails
- Login shell: Loads full environment → Can access OAuth tokens → Auth works

**Step 4: Test Worker Environment**
```bash
# Test if worker shell can access Claude
/bin/bash -l -c "claude auth status"

# Expected output:
# ✅ OAuth: "Logged in as user@example.com"
# ✅ API Key: Shows API key status
# ❌ Problem: "Invalid API key" or "Not logged in"
```

**Step 5: Restart Worker Completely**
```bash
# Kill old worker process
pkill -f "node worker.js"
screen -S worker -X quit 2>/dev/null

# Restart (use your startup script)
~/Desktop/启动Worker.command
```

**Alternative Solutions**:

- **If using API Key**: Set `ANTHROPIC_API_KEY` in startup script (doesn't need login shell)
- **If on headless server**: Use Method 3 (long-term token) to avoid Keychain dependency
- **If OAuth keeps failing**: Switch to Method 2 (API Key) for more reliable automation

### Tasks Timing Out

**Symptoms**: Tasks stuck in "running" state

**Solutions**:
1. Increase timeout values
2. Check worker logs for errors
3. Verify commands work locally first
4. For Claude Code tasks, use 120000ms+ timeout

## Security Best Practices

### 1. Use HTTPS

Set up reverse proxy with SSL (see nginx section above).

### 2. Rotate Tokens Regularly

```bash
# Generate new token
NEW_TOKEN=$(openssl rand -hex 32)

# Update server
# (restart service with new WORKER_TOKEN)

# Update worker
# (update startup script)
```

### 3. Firewall Rules

```bash
# Only allow your IP (if static)
sudo ufw allow from YOUR_IP to any port 3456

# Or use VPN/Tailscale for access
```

### 4. Monitor Logs

```bash
# Watch for suspicious activity
sudo journalctl -u openclaw-worker -f | grep -i "error\|unauthorized"
```

## Cost Estimate

### Monthly Costs (2024 prices)

| Item | Cost (USD) | Notes |
|------|------------|-------|
| Tencent Cloud Lighthouse (2C2G) | $4-8/mo | Silicon Valley region |
| Claude Max Subscription | $20/mo | OAuth-based, shared across cloud + local |
| MiniMax API (for OpenClaw routing) | $0-5/mo | Free tier usually sufficient |
| **Total** | **$24-33/mo** | Varies by usage |

**Cost Optimization**:
- Use MiniMax API (cheap) for OpenClaw's routing decisions
- Share one Claude Max subscription (OAuth) across cloud and local machines
- No per-request API costs for Claude Code - subscription covers unlimited usage
- Free tier adequate for personal use (< 1000 tasks/month)

## Scaling Considerations

### Multiple Workers

Current architecture supports 1:1 (1 API : 1 Worker). For multiple workers:

```javascript
// Modify worker identification
const WORKER_ID = process.env.WORKER_ID || os.hostname();

// Send worker ID in poll request
app.get('/worker/poll', auth, (req, res) => {
  const workerId = req.query.workerId;
  // Route tasks based on worker capabilities
});
```

### Persistent Task Queue

For production, replace in-memory queue with Redis:

```javascript
const Redis = require('ioredis');
const redis = new Redis();

// Store tasks
await redis.setex(`task:${taskId}`, 300, JSON.stringify(task));

// Retrieve tasks
const task = JSON.parse(await redis.get(`task:${taskId}`));
```

## Related Documentation

- [API Reference](api.md)
- [Architecture Background](background.md)
- [Integration Examples](../examples/)

---

*Based on a production deployment running since January 2024*
