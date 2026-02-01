# Background: The Journey to OpenClaw Worker

This document tells the story of how OpenClaw Worker came to be, through failed attempts, late-night debugging, and eventual success.

## The Goal

Control my local Mac from anywhere using Discord on my phone. Sounds simple, right?

It wasn't.

## Attempt 1: Native OpenClaw Remote (The Painful Way)

### Initial Setup

OpenClaw has built-in remote control capabilities. Just install it on both cloud and local machines, set up devices, and you're done!

Or so I thought.

```bash
# Cloud server (Tencent Silicon Valley)
openclaw gateway run

# Local Mac
openclaw gateway run --bind 0.0.0.0
```

**Problem 1: Gateway won't bind to 0.0.0.0**

No matter what I tried, the gateway stubbornly refused to listen on anything but `127.0.0.1`. Configuration changes didn't help.

### Attempt 1a: Tailscale Serve

```bash
tailscale serve --bg 18789
```

This should expose the local gateway through Tailscale's network.

**Problem 2: SSL Handshake Failures**

```
Error: SSL handshake failed
WebSocket connection could not be established
```

After hours of debugging, I gave up on Tailscale Serve.

### Attempt 1b: SSH Reverse Tunnel

The classic solution:

```bash
ssh -f -N -R 18789:127.0.0.1:18789 root@cloud-server
```

This worked! I could `curl http://127.0.0.1:18789/` on the cloud server and see the gateway interface.

But then...

### Problem 3: Token Mismatch Hell

```
gateway token mismatch (set gateway.remote.token to match gateway.auth.token)
```

This error haunted me for an entire night.

I tried:
- ❌ Setting both tokens to the same value in config files
- ❌ Using environment variables
- ❌ Deleting device pairing files and re-pairing
- ❌ Running `openclaw doctor --repair`
- ❌ Restarting gateways countless times
- ❌ Generating new tokens

Nothing worked.

**The Real Problem: Dual Authentication**

OpenClaw has TWO separate token systems:

1. **Config file token** (`gateway.auth.token`) - The one I kept changing
2. **Device pairing token** (in `~/.openclaw/devices/`) - The one it actually uses

I was changing the wrong one.

**Solution** (eventually):

```bash
# Find out what token the cloud is actually using
ssh root@cloud-server 'openclaw config get gateway.auth.token'

# Update local config to match
openclaw config set gateway.remote.token <that_value>

# Regenerate device token
openclaw devices rotate --device <id> --role operator
```

This fixed the token mismatch, but...

### Problem 4: Command Execution Timeout

```
nodes run failed: Error: gateway timeout after 35000ms
```

Commands wouldn't execute. Turns out `system.run` requires an "exec-approvals" mechanism that needs a socket file.

**Solution**: Install OpenClaw's macOS desktop app.

Downloaded the DMG from GitHub Releases, installed it (little lobster icon in menu bar), opened settings, changed "Exec Approvals" to "Always Approve".

Commands finally worked!

```bash
$ openclaw nodes run --node "Local Mac" --raw "echo Hello"
Hello
```

### Why I Abandoned This Approach

After all that work, I had:
- ✅ Working remote control
- ❌ Fragile SSH tunnel that drops randomly
- ❌ Two instances of OpenClaw to maintain
- ❌ Confusing dual-token authentication
- ❌ Desktop app requirement for approvals
- ❌ Hours wasted on troubleshooting

There had to be a better way.

## Attempt 2: Custom Polling Architecture (The Breakthrough)

### The Insight

I don't need bidirectional communication. I just need:
1. Cloud service says "run this command"
2. Local computer executes it
3. Result goes back to cloud

Why maintain a persistent connection at all?

### The Design

**Polling architecture**:
- Cloud server runs a simple HTTP API with task queue
- Local worker polls the API every 500ms
- Worker executes tasks and reports results
- Client (Discord bot) submits tasks and retrieves results via long polling

```
┌─────────┐  submit  ┌─────────┐  poll    ┌────────┐
│ Discord │─────────▶│Task API │◀─────────│ Worker │
│   Bot   │  result  │ (Queue) │  result  │ (Mac)  │
└─────────┘◀─────────└─────────┘─────────▶└────────┘
```

### Implementation

**server.js** (Cloud)
- Express.js HTTP server
- In-memory task queue (Map)
- Long polling support with timeout
- Token authentication

**worker.js** (Local)
- Polls `/worker/poll` every 500ms
- Executes tasks based on type (command/file-read/file-write/claude-cli)
- Reports results to `/worker/result`
- Concurrent task execution (configurable)

### Benefits

- ✅ No persistent connections
- ✅ Works behind any NAT/firewall
- ✅ No SSH tunnels to maintain
- ✅ Simple token authentication (one token, not two)
- ✅ No OpenClaw installation on local machine
- ✅ Auto-recovery (worker just keeps polling)
- ✅ Easy to debug (just HTTP requests)

### First Success

```bash
# Cloud: Start task API
node server.js

# Local: Start worker
WORKER_URL=http://my-server:3456 WORKER_TOKEN=xxx node worker.js

# Discord bot: Submit task
POST /tasks {"command": "ls -la"}

# Result appears in Discord within 1 second
```

It just worked. No fighting with tokens, no SSH tunnels, no mystery errors.

## Evolution: Adding Features

### Concurrent Execution

Initial version executed one task at a time. Added concurrent task execution with `MAX_CONCURRENT` setting.

```javascript
const runningTasks = new Set();
// Max 3 tasks running simultaneously
```

### Long Polling

Instead of client repeatedly polling for results, implemented long polling:

```javascript
GET /tasks/:id?wait=60000  // Wait up to 60 seconds
```

Server holds the request until result is ready or timeout.

### Auto-restart on Wake

Mac sleeps when idle. Worker stops. Solution: `sleepwatcher`

```bash
# ~/.wakeup
screen -dmS worker bash -c 'node worker.js'
```

Worker auto-restarts when Mac wakes up.

### File Operations

Added direct file read/write endpoints to avoid shell escaping issues:

```bash
POST /files/read {"path": "/path/to/file"}
POST /files/write {"path": "/path/to/file", "content": "data"}
```

### Claude Code Integration

Added dedicated endpoint for calling local Claude Code CLI:

```bash
POST /claude {"prompt": "...", "timeout": 120000}
```

Worker executes `claude --print --dangerously-skip-permissions "prompt"`

### Metadata Support

For advanced use cases (like screenshot capture from browser automation), added metadata field to task results:

```javascript
{
  stdout: "...",
  stderr: "...",
  exitCode: 0,
  metadata: { screenshotPath: "/tmp/screenshot.png" }
}
```

Discord bot can then read the file and upload to channel.

## Lessons Learned

### 1. Complexity is the Enemy

The simplest solution (polling) ended up being the most reliable. Persistent connections, WebSockets, and fancy protocols introduced fragility.

### 2. Authentication Should Be Obvious

One token, passed in HTTP header. That's it. No device pairing, no dual tokens, no confusion.

### 3. Stateless is Robust

No session state means no session expiration, no reconnection logic, no "connection lost" errors. Each request is independent.

### 4. Documentation Gaps are Normal

OpenClaw's token mismatch issue was poorly documented (or I couldn't find it). When building your own tools, accept that some trial-and-error is inevitable.

### 5. Local Control Doesn't Require Local Installation

The initial assumption was "to control local computer, install software locally." Wrong. A lightweight worker that phones home is sufficient.

## Technical Decisions

### Why Not WebSockets?

WebSockets require persistent connections. Behind corporate firewalls, NATs, and mobile networks, these connections break frequently. HTTP polling works everywhere.

### Why In-Memory Queue?

For personal use, in-memory task queue is fine. If the server restarts, pending tasks are lost, but they're short-lived anyway (max 5 minutes). For production, could add Redis or database persistence.

### Why 500ms Polling Interval?

- Too fast (< 100ms): Wastes bandwidth and CPU
- Too slow (> 1s): Noticeable delay
- 500ms: Good balance. Tasks start within 1 second, negligible overhead

Can be adjusted via `POLL_INTERVAL` env var.

### Why Node.js?

- Native async/await for concurrent execution
- Express.js for simple HTTP server
- Child process APIs for running commands
- Zero dependencies (except Express)

Could be implemented in any language, but Node.js made it trivial.

## Production Considerations

This architecture is battle-tested for personal use (Discord bot controlling Mac). For production:

### Security
- ✅ Use HTTPS (reverse proxy with Let's Encrypt)
- ✅ Rotate tokens periodically
- ✅ Rate limiting on API endpoints
- ✅ Audit logging for task execution

### Reliability
- ✅ Use pm2 or systemd for process management
- ✅ Set up monitoring (health check endpoint)
- ✅ Log rotation for long-running workers
- ⚠️ Consider persistent task queue (Redis) for critical tasks

### Scalability
- ⚠️ Current design is 1 worker : 1 API
- ⚠️ For multiple workers, need worker pool management
- ⚠️ For high-frequency tasks, consider batch processing

## Comparison with Alternatives

| Solution | Complexity | Reliability | Setup Time |
|----------|-----------|-------------|------------|
| **OpenClaw Remote** | High (dual auth, desktop app) | Medium (SSH tunnels) | 2-3 hours |
| **Tailscale** | Medium | High | 30 min |
| **ngrok/frp** | Low | Medium (depends on service) | 15 min |
| **OpenClaw Worker** | Low | High | 10 min |

For my use case (Discord bot → local Mac), OpenClaw Worker was the clear winner.

## Future Ideas

- [ ] Add task prioritization
- [ ] Support multiple workers per API
- [ ] Web UI for task monitoring
- [ ] Webhook notifications on task completion
- [ ] Task scheduling (cron-like)
- [ ] Result persistence (database)

## Conclusion

The journey from "why doesn't this work?" at 2 AM to a clean, working architecture was frustrating but educational.

Key takeaway: **When you control both ends of the communication, don't over-engineer.** Polling is simple, stateless, and works everywhere.

If you're reading this because you're fighting with OpenClaw token mismatches or SSH tunnels, consider giving polling architecture a try. It might save you a night of debugging.

---

*Written after finally getting a good night's sleep.*
