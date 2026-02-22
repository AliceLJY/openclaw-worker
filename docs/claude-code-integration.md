# Claude Code Integration Best Practices

> How to properly invoke local Claude Code from your Discord bot for complex tasks like article writing.

## The Problem

Your Discord bot (running on cloud/Docker) needs to invoke Claude Code on your local Mac for:
- Writing articles with web research
- Complex multi-step tasks
- File operations on local machine
- Running skills that require local tools

**But**: The bot can't directly call Claude Code because:
1. Bot runs in cloud/Docker, Claude Code runs on Mac
2. Different network environments
3. Need secure authentication

## The Solution: Task API

Use the OpenClaw Worker's Task API as a bridge.

```
Discord Bot → Task API → Local Worker → Claude Code → Result
```

## API Endpoints

### For Docker Bot (inside container)

```bash
# Base URL (Docker internal network)
http://host.docker.internal:3456

# Headers
Authorization: Bearer YOUR_API_TOKEN
Content-Type: application/json
```

### For Cloud Bot

```bash
# Base URL (your server)
https://your-server.com:3456

# Same headers
```

---

## Correct Way: Use `/claude` Endpoint

### Request

```bash
POST /claude
{
  "prompt": "Your task description here",
  "timeout": 300000
}
```

### Get Result

```bash
GET /tasks/{taskId}?wait=300000
```

### Example: Write an Article

```json
POST http://host.docker.internal:3456/claude
Headers:
  Authorization: Bearer YOUR_TOKEN
  Content-Type: application/json

{
  "prompt": "Write a WeChat article about AI and sleep. Requirements: 1. Search for sleep science research 2. AI outsider perspective 3. Conversational tone 4. Save to /path/to/article.md",
  "timeout": 300000
}
```

---

## Common Mistakes

### ❌ Wrong: Using `/tasks` endpoint for Claude Code

```json
// DON'T DO THIS
POST /tasks
{
  "command": "/skill content-alchemy ...",
  "timeout": 300000
}
```

This will fail because `/tasks` expects shell commands, not Claude prompts.

### ❌ Wrong: Using `/skill` command in prompt

```json
// DON'T DO THIS
{
  "prompt": "/skill content-alchemy write article"
}
```

The `/skill` command doesn't work in `--print` mode.

### ✅ Correct: Natural language prompt

```json
// DO THIS
{
  "prompt": "Use content-alchemy-bot skill to write an article about..."
}
```

Claude Code will automatically read the skill file and execute it.

---

## Writing Style Guidelines

When your bot writes articles for a WeChat public account:

### Tone

- AI outsider perspective, like a friend telling a story
- No anxiety-selling, no answer-peddling
- Can self-deprecate, can complain, don't lecture
- Keep genuine emotions and thought jumps

### Forbidden Words

```
❌ 赋能 (empower)
❌ 痛点 (pain point)
❌ 闭环 (closed loop)
❌ 抓手 (handle/lever)
❌ 颗粒度 (granularity)
❌ "在这个...的时代" (In this era of...)
❌ "随着...的发展" (With the development of...)
❌ "综上所述" (In summary)
❌ "让我们拭目以待" (Let's wait and see)
```

### Seven Writing Principles

1. **Restrained opening** — Direct scene entry, no "In this era..."
2. **Show, don't tell** — Use data and details, not "very effective"
3. **Bold questions** — Insert genuine confusion, admit uncertainty
4. **Colloquial transitions** — "Simply put" instead of "In summary"
5. **Concrete over abstract** — Quantify with numbers, visualize with scenes
6. **Keep the human touch** — Interjections, self-mockery, thought jumps OK
7. **Light ending** — Leave open questions, don't force grand conclusions

---

## Bot Memory Configuration

Add this to your bot's `MEMORY.md`:

```markdown
## Article Writing Rules

When user says "write article" or provides material for a WeChat article:
**MUST invoke local Claude Code**, don't write it yourself.

### How to Call

POST http://host.docker.internal:3456/claude
{
  "prompt": "Use content-alchemy-bot skill to write article. Topic: [topic]. Material: [material]",
  "timeout": 300000
}

### After Completion, MUST Report

1. Article title
2. Content summary
3. File path

### Forbidden Actions

- ❌ Use /tasks endpoint for articles
- ❌ Use /skill command
- ❌ Write article yourself without Claude Code
- ❌ Timeout less than 300000ms
```

---

## Timeout Guidelines

| Task Type | Recommended Timeout |
|-----------|---------------------|
| Simple query | 30,000ms (30s) |
| File read/write | 10,000ms (10s) |
| Article writing | 300,000ms (5min) |
| Complex research | 600,000ms (10min) |

---

## Error Handling

### Check Exit Code

```javascript
const result = await fetch(`/tasks/${taskId}?wait=300000`);
const data = await result.json();

if (data.exitCode === 0) {
  // Success - read from stdout
  const output = data.stdout;
} else {
  // Failure - check stderr
  const error = data.stderr;
}
```

### Common Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error (also: session ID conflict, see below) |
| 143 | Timeout (SIGTERM) |

### Session ID Conflict (Claude Code CLI 2.x)

Since Claude Code CLI 2.x, `--session-id` and `--resume` have **strict semantics**:

| Flag | Purpose | If session exists | If session doesn't exist |
|------|---------|-------------------|--------------------------|
| `--session-id UUID` | Create new session | **Error**: "Session ID already in use" | Creates session |
| `--resume UUID` | Continue existing session | Resumes session | **Error**: "No conversation found" |

The Worker detects which flag to use by checking whether the session file exists on disk (`~/.claude/projects/.../{UUID}.jsonl`), rather than relying on in-memory state (which is lost on Worker restart).

> **中文说明**：CC CLI 2.x 对 `--session-id`（新建）和 `--resume`（续接）做了严格区分。Worker 通过检查磁盘上的 session 文件来判断用哪个 flag，避免了 Worker 重启后内存丢失导致的 session 冲突错误。

---

## Complete Example Flow

```
1. User: "帮我写篇文章，主题是AI不需要睡觉"

2. Bot recognizes article request

3. Bot calls Task API:
   POST /claude
   {"prompt": "Use content-alchemy-bot skill...", "timeout": 300000}

4. Bot gets taskId, polls for result:
   GET /tasks/{taskId}?wait=300000

5. Claude Code executes on local Mac:
   - Searches web for sleep science
   - Analyzes sources
   - Writes article
   - Saves to file

6. Bot receives result, reports to user:
   "✅ 文章已生成！
   标题：《你们睡觉，本质是防止自己死掉》
   路径：/path/to/article.md"
```

---

## Callback Delivery

After a Claude Code task completes, the Worker doesn't just store the result in the Task API — it also **pushes a notification directly to Discord** via the OpenClaw CLI.

### How It Works

```
CC task completes
    ↓
Worker reports result to Task API          (storage)
    ↓
Worker runs: docker exec openclaw-antigravity
  node openclaw.mjs message send
  --channel discord
  --target channel:<callbackChannel>       (push notification)
```

The callback message includes:
- **Status**: success or failure
- **Duration**: how long the task took
- **sessionId**: for multi-turn continuation (the Bot extracts this to chain rounds)
- **Output**: last 1500 characters of CC stdout

### Enabling Callbacks

Include `callbackChannel` in your `/claude` request:

```json
POST /claude
{
  "prompt": "Write an article about...",
  "callbackChannel": "1234567890",
  "timeout": 600000
}
```

Without `callbackChannel`, no notification is sent — results are only available via `GET /tasks/:id`.

### Multi-Turn Orchestration

For chaining multiple rounds of CC execution (e.g., the 3-round Content Alchemy workflow), see [openclaw-cc-pipeline](https://github.com/AliceLJY/openclaw-cc-pipeline). That skill defines the full protocol: how the Bot extracts `sessionId` from callbacks, collects user feedback, and dispatches subsequent rounds with `--resume`.

---

*The key insight: Your bot is an orchestrator, not a writer. Let Claude Code do the heavy lifting.*
