# Deployment Guide

This guide covers deploying OpenClaw Worker in a real-world setup.

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
  - OpenClaw (with MiniMax API key for cheap LLM calls)
  - Claude Code (Max subscription via OAuth)
  - Task API (this project's server.js)

**Why this config**:
- 2C2G is sufficient for lightweight task queuing
- International server bypasses China's Discord firewall
- Shared Claude Max subscription across cloud and local

### Local Computer

**Hardware**: MacBook Air M4, 16GB RAM
**OS**: macOS Sequoia (or later)
**Services**:
- Worker (this project's worker.js)
- Claude Code CLI (Max subscription, same account as cloud)
- baoyu-skills (optional, for extended capabilities)

**Why this setup**:
- Mac required for macOS-specific automation
- M4 chip handles AI-assisted tasks efficiently
- Shared Max subscription = no extra API costs

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

# Login (opens browser for OAuth)
claude /login

# Verify
claude --version
```

**Important**: Claude Code requires Max subscription. The same account can be used on both cloud and local machines.

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

```bash
# Create desktop shortcut
cat > ~/Desktop/启动Worker.command << 'EOF'
#!/bin/bash
cd ~/openclaw-worker
screen -dmS worker bash -c '
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

### Claude Code Errors

**Symptoms**: "403 Forbidden" or "Not logged in"

**Solutions**:
```bash
# Re-authenticate
claude /login

# Verify authentication
claude "Hello"  # Should work without errors
```

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
| Claude Code Max Subscription | $20/mo | Shared cloud + local |
| MiniMax API (OpenClaw) | $0-5/mo | Free tier usually sufficient |
| **Total** | **$24-33/mo** | Varies by usage |

**Cost Optimization**:
- Use cheapest LLM (MiniMax) for Discord bot routing
- Share one Claude Max subscription across cloud and local
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
