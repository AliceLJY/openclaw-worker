/**
 * 本地任务 API 服务
 * 运行在 Docker 中，配合 Worker + CC Bridge 使用
 */

import express from 'express';
import crypto from 'crypto';

const app = express();

app.use(express.json({ limit: '5mb' }));

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

// ========== 配置 ==========
const AUTH_TOKEN = process.env.WORKER_TOKEN || 'change-me-to-a-secure-token';
const PORT = process.env.WORKER_PORT || 3456;
const DEFAULT_TASK_TIMEOUT_MS = 30000;
const DEFAULT_POLL_WAIT_MS = 30000;
const MAX_POLL_WAIT_MS = 60000;
const MIN_TASK_TIMEOUT_MS = 1000;
const MAX_TASK_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// 启动强检（学自 Star-Office-UI security_utils）：弱 token 直接拒绝启动，不 warn 继续跑
if (!AUTH_TOKEN || AUTH_TOKEN === 'change-me-to-a-secure-token' || AUTH_TOKEN.length < 16) {
  console.error('❌ FATAL: WORKER_TOKEN 未设置或过弱（需 ≥16 位，不能用默认值）');
  console.error('   请在 docker-compose.yml 或 .env 中设置 WORKER_TOKEN');
  process.exit(1);
}

// ========== 内存任务队列 ==========
const tasks = new Map();      // taskId -> task
const results = new Map();    // taskId -> result

// ========== 活跃会话跟踪 ==========
const activeSessions = new Map(); // sessionId -> { lastActivity, taskCount }

// ========== 认证中间件 ==========
function parseBearerToken(headerValue) {
  if (typeof headerValue !== 'string') return '';
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function parseBoundedInt(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeOptionalString(value) {
  const trimmed = normalizeString(value);
  return trimmed || null;
}

function parseTaskTimeout(value, fallback) {
  return parseBoundedInt(value, fallback, { min: MIN_TASK_TIMEOUT_MS, max: MAX_TASK_TIMEOUT_MS });
}

function previewText(text, max = 50) {
  const compact = String(text ?? '').replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max)}...` : compact;
}

function enqueueTask(payload) {
  const task = {
    id: crypto.randomUUID(),
    status: 'pending',
    createdAt: Date.now(),
    ...payload
  };
  tasks.set(task.id, task);
  return task;
}

function consumeTaskResult(taskId) {
  if (!results.has(taskId)) return null;
  const result = results.get(taskId);
  results.delete(taskId);
  tasks.delete(taskId);
  return result;
}

function claimNextPendingTask() {
  for (const [taskId, task] of tasks) {
    if (task.status === 'pending') {
      task.status = 'running';
      console.log(`[Worker] Picked up: ${taskId}`);
      return task;
    }
  }
  return null;
}

async function loadSessionModules() {
  const [fs, path, readline] = await Promise.all([
    import('fs'),
    import('path'),
    import('readline'),
  ]);
  return {
    fs: fs.default,
    path: path.default,
    readline: readline.default,
  };
}

function parseRecentLimit(value) {
  return parseBoundedInt(value, 10, { min: 1, max: 20 });
}

function extractUserText(content) {
  if (Array.isArray(content)) {
    const textBlock = content.find(item => item?.type === 'text' && typeof item.text === 'string');
    return textBlock?.text ? textBlock.text.slice(0, 150) : '';
  }
  if (typeof content === 'string') {
    return content.slice(0, 150);
  }
  return '';
}

async function extractSessionTopic(filePath, fs, readline, resolver) {
  let topic = '';
  try {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream });
    for await (const line of rl) {
      try {
        const parsed = JSON.parse(line);
        const candidate = resolver(parsed);
        if (candidate) {
          topic = candidate;
          break;
        }
      } catch {
        // skip malformed lines
      }
    }
    rl.close();
    stream.destroy();
  } catch {
    // skip unreadable files
  }
  return topic || '(no topic)';
}

function auth(req, res, next) {
  const token = parseBearerToken(req.headers['authorization']);
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  return next(err);
});

// ========== API 路由 ==========

// 健康检查
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    tasks: tasks.size,
    results: results.size,
    activeSessions: activeSessions.size
  });
});

// [云端 OpenClaw 调用] 提交任务
app.post('/tasks', auth, (req, res) => {
  const { command, timeout = DEFAULT_TASK_TIMEOUT_MS } = req.body || {};
  const normalizedCommand = normalizeString(command);

  if (!normalizedCommand) {
    return res.status(400).json({ error: 'command is required' });
  }

  const task = enqueueTask({
    command: normalizedCommand,
    timeout: parseTaskTimeout(timeout, DEFAULT_TASK_TIMEOUT_MS)
  });
  console.log(`[Task] Created: ${task.id} - ${normalizedCommand}`);

  res.json({ taskId: task.id, message: 'Task created, waiting for worker' });
});

// [云端 OpenClaw 调用] 查询结果（带轮询等待）
app.get('/tasks/:taskId', auth, async (req, res) => {
  const { taskId } = req.params;
  const waitMs = parseBoundedInt(req.query.wait, 0, { min: 0, max: MAX_POLL_WAIT_MS }); // 最多等待多少毫秒

  const startTime = Date.now();

  // 轮询等待结果
  while (Date.now() - startTime < waitMs) {
    const result = consumeTaskResult(taskId);
    if (result) {
      return res.json(result);
    }
    await new Promise(r => setTimeout(r, 500)); // 每 500ms 检查一次
  }

  // 超时或不等待，返回当前状态
  const result = consumeTaskResult(taskId);
  if (result) {
    return res.json(result);
  }

  const task = tasks.get(taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  res.json({ status: task.status, message: 'Result not ready yet' });
});

// [本地 Worker 调用] 获取待执行任务（长轮询）
app.get('/worker/poll', auth, async (req, res) => {
  const waitMs = parseBoundedInt(req.query.wait, DEFAULT_POLL_WAIT_MS, { min: 1000, max: MAX_POLL_WAIT_MS });

  // 先立即检查一次
  const initialTask = claimNextPendingTask();
  if (initialTask) {
    return res.json(initialTask);
  }

  // 长轮询：hold 住连接，每 500ms 检查一次
  const startTime = Date.now();
  while (Date.now() - startTime < waitMs) {
    await new Promise(r => setTimeout(r, 500));
    const pendingTask = claimNextPendingTask();
    if (pendingTask) {
      return res.json(pendingTask);
    }
  }

  res.json(null); // 超时，没有任务
});

// [本地 Worker 调用] 上报结果
app.post('/worker/result', auth, (req, res) => {
  const { taskId, stdout, stderr, exitCode, error, metadata } = req.body || {};

  if (!taskId) {
    return res.status(400).json({ error: 'taskId is required' });
  }

  const result = {
    taskId,
    stdout: stdout || '',
    stderr: stderr || '',
    exitCode: exitCode ?? -1,
    error: error || null,
    completedAt: Date.now()
  };

  // 如果有 metadata，添加到结果中
  if (metadata) {
    result.metadata = metadata;
  }

  results.set(taskId, result);
  console.log(`[Worker] Result: ${taskId} - exit ${exitCode}`);
  if (metadata?.screenshotPath) {
    console.log(`[Worker] Screenshot: ${metadata.screenshotPath}`);
  }

  // 更新会话跟踪
  if (metadata?.sessionId) {
    activeSessions.set(metadata.sessionId, {
      lastActivity: Date.now(),
      taskCount: (activeSessions.get(metadata.sessionId)?.taskCount || 0) + 1
    });
  }

  res.json({ success: true });
});

// ========== 文件写入 API（绕过 shell 转义问题） ==========

// [云端 OpenClaw 调用] 写入文件
app.post('/files/write', auth, (req, res) => {
  const { path, content, encoding = 'utf8' } = req.body || {};
  const normalizedPath = normalizeString(path);

  if (!normalizedPath || content === undefined) {
    return res.status(400).json({ error: 'path and content are required' });
  }

  const task = enqueueTask({
    type: 'file-write',
    path: normalizedPath,
    content,
    encoding, // 'utf8' 或 'base64'
  });

  console.log(`[File] Write: ${task.id} - ${normalizedPath}`);

  res.json({ taskId: task.id, message: 'File write task created' });
});

// [云端 OpenClaw 调用] 读取文件
app.post('/files/read', auth, (req, res) => {
  const { path } = req.body || {};
  const normalizedPath = normalizeString(path);

  if (!normalizedPath) {
    return res.status(400).json({ error: 'path is required' });
  }

  const task = enqueueTask({
    type: 'file-read',
    path: normalizedPath,
  });

  console.log(`[File] Read: ${task.id} - ${normalizedPath}`);

  res.json({ taskId: task.id, message: 'File read task created' });
});

// [云端 OpenClaw 调用] 编辑文件（局部替换）
app.post('/files/edit', auth, (req, res) => {
  const { path, old_string, new_string, replace_all = false } = req.body || {};
  const normalizedPath = normalizeString(path);

  if (!normalizedPath || old_string === undefined || new_string === undefined) {
    return res.status(400).json({ error: 'path, old_string, new_string are required' });
  }

  const task = enqueueTask({
    type: 'file-edit',
    path: normalizedPath,
    oldString: old_string,
    newString: new_string,
    replaceAll: replace_all,
  });

  console.log(`[File] Edit: ${task.id} - ${normalizedPath}`);

  res.json({ taskId: task.id, message: 'File edit task created' });
});

// ========== Claude CLI API（调用本地 Claude Code） ==========

// [云端 OpenClaw 调用] 执行本地 Claude Code CLI
app.post('/claude', auth, (req, res) => {
  const { prompt, timeout = 120000, sessionId, callbackChannel, callbackBotToken } = req.body || {};
  const promptText = typeof prompt === 'string' ? prompt : '';
  const requestedSessionId = normalizeOptionalString(sessionId);

  if (!promptText.trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  // 自动生成 sessionId：确保每轮 CC 都有可追踪的 session，支持后续 --resume
  const effectiveSessionId = requestedSessionId || crypto.randomUUID();
  const task = enqueueTask({
    type: 'claude-cli',
    prompt: promptText,
    timeout: parseTaskTimeout(timeout, 120000),
    sessionId: effectiveSessionId,
    callbackChannel: normalizeOptionalString(callbackChannel),
    callbackBotToken: normalizeOptionalString(callbackBotToken),
  });

  // 更新会话跟踪
  activeSessions.set(effectiveSessionId, {
    lastActivity: Date.now(),
    taskCount: (activeSessions.get(effectiveSessionId)?.taskCount || 0)
  });

  const isResume = Boolean(requestedSessionId);
  console.log(`[Claude] Task: ${task.id} [session:${effectiveSessionId.slice(0, 8)}${isResume ? ',resume' : ',new'}]${task.callbackChannel ? ' [callback:' + task.callbackChannel + ']' : ''} - ${previewText(promptText)}`);

  res.json({ taskId: task.id, sessionId: effectiveSessionId, message: 'Claude CLI task created' });
});

// ========== Codex / Gemini CLI API ==========

// [Discord/Telegram bridge 调用] 提交 Codex CLI 任务（支持 session）
app.post('/codex', auth, (req, res) => {
  const { prompt, timeout = 300000, sessionId, model, callbackChannel, callbackBotToken } = req.body || {};
  const promptText = typeof prompt === 'string' ? prompt : '';
  const normalizedSessionId = normalizeOptionalString(sessionId);

  if (!promptText.trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  const task = enqueueTask({
    type: 'codex-cli',
    prompt: promptText,
    timeout: parseTaskTimeout(timeout, 300000),
    sessionId: normalizedSessionId,
    model: normalizeOptionalString(model),
    callbackChannel: normalizeOptionalString(callbackChannel),
    callbackBotToken: normalizeOptionalString(callbackBotToken),
  });

  const isResume = Boolean(normalizedSessionId);
  console.log(`[Codex] Task: ${task.id}${isResume ? ' [session:' + normalizedSessionId.slice(0, 8) + ',resume]' : ' [新会话]'}${task.model ? ' [' + task.model + ']' : ''}${task.callbackChannel ? ' [callback:' + task.callbackChannel + ']' : ''} - ${previewText(promptText)}`);

  res.json({ taskId: task.id, message: 'Codex CLI task created' });
});

// [Discord/Telegram bridge 调用] 提交 Gemini CLI 任务（支持 session）
app.post('/gemini', auth, (req, res) => {
  const { prompt, timeout = 300000, sessionId, resumeLatest, model, callbackChannel, callbackBotToken } = req.body || {};
  const promptText = typeof prompt === 'string' ? prompt : '';
  const normalizedSessionId = normalizeOptionalString(sessionId);

  if (!promptText.trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  const task = enqueueTask({
    type: 'gemini-cli',
    prompt: promptText,
    timeout: parseTaskTimeout(timeout, 300000),
    sessionId: normalizedSessionId,
    resumeLatest: Boolean(resumeLatest),
    model: normalizeOptionalString(model),
    callbackChannel: normalizeOptionalString(callbackChannel),
    callbackBotToken: normalizeOptionalString(callbackBotToken),
  });

  const isResume = task.resumeLatest || Boolean(normalizedSessionId);
  console.log(`[Gemini] Task: ${task.id}${isResume ? (task.resumeLatest ? ' [resume:latest]' : ' [session:' + normalizedSessionId.slice(0, 8) + ',resume]') : ' [新会话]'}${task.callbackChannel ? ' [callback:' + task.callbackChannel + ']' : ''} - ${previewText(promptText)}`);

  res.json({ taskId: task.id, message: 'Gemini CLI task created' });
});

// ========== Discord 消息推送 ==========

// 让 cc-bridge hook 推消息到 Discord（hook 自己在容器里无法直推）
app.post('/notify', auth, async (req, res) => {
  const channel = normalizeString(req.body?.channel);
  const message = typeof req.body?.message === 'string' ? req.body.message : '';
  if (!channel || !message.trim()) {
    return res.status(400).json({ error: 'channel and message are required' });
  }
  const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
  if (!DISCORD_BOT_TOKEN) {
    return res.status(500).json({ error: 'DISCORD_BOT_TOKEN not set' });
  }
  try {
    const resp = await fetch(`https://discord.com/api/v10/channels/${channel}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: message.slice(0, 2000) }),
    });
    if (resp.ok) {
      res.json({ ok: true });
    } else {
      const text = await resp.text();
      res.status(502).json({ error: `Discord ${resp.status}: ${text}` });
    }
  } catch (err) {
    res.status(502).json({ error: errorMessage(err) });
  }
});

// ========== 会话管理 API ==========

// [云端 OpenClaw 调用] 列出活跃会话
app.get('/claude/sessions', auth, (req, res) => {
  const sessions = Array.from(activeSessions.entries()).map(([sessionId, s]) => ({
    sessionId,
    lastActivity: s.lastActivity,
    taskCount: s.taskCount || 0
  }));
  res.json({ sessions });
});

// [本地调用] 列出最近的 CC 会话（含话题摘要）
app.get('/claude/recent', auth, async (req, res) => {
  const limit = parseRecentLimit(req.query.limit);
  const { fs, path, readline } = await loadSessionModules();

  // 扫描 CC session 文件（容器内挂载路径，宿主机 ~/.claude/projects）
  const projectsDir = '/host-claude-projects';
  const sessions = [];

  try {
    const projectDirs = fs.readdirSync(projectsDir).filter(d =>
      fs.statSync(path.join(projectsDir, d)).isDirectory()
    );

    for (const dir of projectDirs) {
      const fullDir = path.join(projectsDir, dir);
      const files = fs.readdirSync(fullDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const fp = path.join(fullDir, f);
          const stat = fs.statSync(fp);
          return { file: f, path: fp, mtime: stat.mtimeMs, size: stat.size, project: dir };
        });
      sessions.push(...files);
    }
  } catch (e) {
    return res.json({ sessions: [], error: errorMessage(e) });
  }

  // 按修改时间倒序，取最近 N 个
  sessions.sort((a, b) => b.mtime - a.mtime);
  const recent = sessions.slice(0, limit);

  // 提取每个会话的第一条 user 消息作为话题
  const results = [];
  for (const s of recent) {
    const topic = await extractSessionTopic(s.path, fs, readline, (record) => {
      if (record.message?.role !== 'user') return '';
      return extractUserText(record.message.content);
    });

    results.push({
      sessionId: s.file.replace('.jsonl', ''),
      project: s.project,
      lastModified: new Date(s.mtime).toISOString(),
      sizeKB: Math.round(s.size / 1024),
      topic,
    });
  }

  res.json({ sessions: results });
});

// [本地调用] 列出最近的 Codex 会话（含话题摘要）
app.get('/codex/recent', auth, async (req, res) => {
  const limit = parseRecentLimit(req.query.limit);
  const { fs, path, readline } = await loadSessionModules();

  // 扫描 Codex session 文件（容器内挂载路径，宿主机 ~/.codex/sessions）
  // 目录结构：YYYY/MM/DD/rollout-{timestamp}-{uuid}.jsonl
  const sessionsDir = '/host-codex-sessions';
  const sessionFiles = [];

  try {
    // 只扫最近 7 天的目录
    const now = new Date();
    for (let d = 0; d < 7; d++) {
      const date = new Date(now - d * 86400000);
      const yyyy = String(date.getFullYear());
      const mm = String(date.getMonth() + 1).padStart(2, '0');
      const dd = String(date.getDate()).padStart(2, '0');
      const dayDir = path.join(sessionsDir, yyyy, mm, dd);

      try {
        const files = fs.readdirSync(dayDir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => {
            const fp = path.join(dayDir, f);
            const stat = fs.statSync(fp);
            // 从文件名提取末尾 UUID（兼容 rollout-2026-03-02T12-33-14-{uuid}.jsonl）
            const uuidMatch = f.match(/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/i);
            const sessionId = uuidMatch ? uuidMatch[1] : f.replace('.jsonl', '');
            return { file: f, path: fp, mtime: stat.mtimeMs, size: stat.size, sessionId };
          });
        sessionFiles.push(...files);
      } catch { /* 该天目录不存在，跳过 */ }
    }
  } catch (e) {
    return res.json({ sessions: [], error: errorMessage(e) });
  }

  // 按修改时间倒序，取最近 N 个
  sessionFiles.sort((a, b) => b.mtime - a.mtime);
  const recent = sessionFiles.slice(0, limit);

  // 提取每个会话的第一条 user 消息作为话题
  const results = [];
  for (const s of recent) {
    const topic = await extractSessionTopic(s.path, fs, readline, (record) => {
      if (record.type === 'event_msg' && record.payload?.type === 'user_message') {
        const message = normalizeString(record.payload.message);
        if (!message) return '';
        const isSlashCommand = /^\/[a-z0-9_]+(?:@\w+)?(?:\s|$)/i.test(message);
        const isMentionCommand = /^@\S+\s+\/[a-z0-9_]+(?:@\w+)?(?:\s|$)/i.test(message);
        if (isSlashCommand || isMentionCommand) return '';
        return message.slice(0, 150);
      }
      if (record.message?.role !== 'user') return '';
      return extractUserText(record.message.content);
    });

    results.push({
      sessionId: s.sessionId,
      lastModified: new Date(s.mtime).toISOString(),
      sizeKB: Math.round(s.size / 1024),
      topic,
    });
  }

  res.json({ sessions: results });
});

// ========== 清理过期任务 ==========
setInterval(() => {
  const now = Date.now();
  const TASK_EXPIRE_MS = 20 * 60 * 1000; // 未完成任务 20 分钟过期（适配 15 分钟超时 + buffer）
  const RESULT_EXPIRE_MS = 30 * 60 * 1000; // 已完成结果保留 30 分钟
  const SESSION_EXPIRE_MS = 30 * 60 * 1000; // 会话 30 分钟过期

  for (const [taskId, task] of tasks) {
    const age = now - task.createdAt;
    if (results.has(taskId)) {
      // 有结果但未被取走：保留更久
      if (age > RESULT_EXPIRE_MS) {
        tasks.delete(taskId);
        results.delete(taskId);
        console.log(`[Cleanup] Result expired (unfetched): ${taskId}`);
      }
    } else if (age > TASK_EXPIRE_MS) {
      // 无结果的过期任务（卡住或超时）
      tasks.delete(taskId);
      console.log(`[Cleanup] Task expired (no result): ${taskId}`);
    }
  }

  // 清理过期会话
  for (const [sessionId, session] of activeSessions) {
    if (now - session.lastActivity > SESSION_EXPIRE_MS) {
      activeSessions.delete(sessionId);
    }
  }
}, 60000);

// ========== 启动 ==========
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Task API running on :${PORT}`);
  console.log(`   Token : ${AUTH_TOKEN.slice(0, 4)}${'*'.repeat(AUTH_TOKEN.length - 4)}`);
  console.log(`   Notify: ${process.env.DISCORD_BOT_TOKEN ? '✓ DISCORD_BOT_TOKEN set' : '✗ no DISCORD_BOT_TOKEN'}`);
});
