/**
 * 云端任务 API 服务
 * 部署在腾讯云服务器上，和 OpenClaw 一起跑
 */

import express from 'express';
import crypto from 'crypto';

const app = express();

app.use(express.json());

// ========== 配置 ==========
const AUTH_TOKEN = process.env.WORKER_TOKEN || 'change-me-to-a-secure-token';
const PORT = process.env.WORKER_PORT || 3456;

// ========== 内存任务队列 ==========
const tasks = new Map();      // taskId -> task
const results = new Map();    // taskId -> result

// ========== 活跃会话跟踪 ==========
const activeSessions = new Map(); // sessionId -> { lastActivity, taskCount }

// ========== 认证中间件 ==========
function auth(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

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
  const { command, timeout = 30000 } = req.body;

  if (!command) {
    return res.status(400).json({ error: 'command is required' });
  }

  const taskId = crypto.randomUUID();
  const task = {
    id: taskId,
    command,
    timeout,
    status: 'pending',
    createdAt: Date.now()
  };

  tasks.set(taskId, task);
  console.log(`[Task] Created: ${taskId} - ${command}`);

  res.json({ taskId, message: 'Task created, waiting for worker' });
});

// [云端 OpenClaw 调用] 查询结果（带轮询等待）
app.get('/tasks/:taskId', auth, async (req, res) => {
  const { taskId } = req.params;
  const waitMs = parseInt(req.query.wait) || 0; // 最多等待多少毫秒

  const startTime = Date.now();

  // 轮询等待结果
  while (Date.now() - startTime < waitMs) {
    if (results.has(taskId)) {
      const result = results.get(taskId);
      results.delete(taskId); // 取走后删除
      tasks.delete(taskId);
      return res.json(result);
    }
    await new Promise(r => setTimeout(r, 500)); // 每 500ms 检查一次
  }

  // 超时或不等待，返回当前状态
  if (results.has(taskId)) {
    const result = results.get(taskId);
    results.delete(taskId);
    tasks.delete(taskId);
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
  const waitMs = Math.min(parseInt(req.query.wait) || 30000, 60000);

  // 先立即检查一次
  for (const [taskId, task] of tasks) {
    if (task.status === 'pending') {
      task.status = 'running';
      console.log(`[Worker] Picked up: ${taskId}`);
      return res.json(task);
    }
  }

  // 长轮询：hold 住连接，每 500ms 检查一次
  const startTime = Date.now();
  while (Date.now() - startTime < waitMs) {
    await new Promise(r => setTimeout(r, 500));
    for (const [taskId, task] of tasks) {
      if (task.status === 'pending') {
        task.status = 'running';
        console.log(`[Worker] Picked up: ${taskId}`);
        return res.json(task);
      }
    }
  }

  res.json(null); // 超时，没有任务
});

// [本地 Worker 调用] 上报结果
app.post('/worker/result', auth, (req, res) => {
  const { taskId, stdout, stderr, exitCode, error, metadata } = req.body;

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
  const { path, content, encoding = 'utf8' } = req.body;

  if (!path || content === undefined) {
    return res.status(400).json({ error: 'path and content are required' });
  }

  const taskId = crypto.randomUUID();
  const task = {
    id: taskId,
    type: 'file-write',
    path,
    content,
    encoding, // 'utf8' 或 'base64'
    status: 'pending',
    createdAt: Date.now()
  };

  tasks.set(taskId, task);
  console.log(`[File] Write: ${taskId} - ${path}`);

  res.json({ taskId, message: 'File write task created' });
});

// [云端 OpenClaw 调用] 读取文件
app.post('/files/read', auth, (req, res) => {
  const { path } = req.body;

  if (!path) {
    return res.status(400).json({ error: 'path is required' });
  }

  const taskId = crypto.randomUUID();
  const task = {
    id: taskId,
    type: 'file-read',
    path,
    status: 'pending',
    createdAt: Date.now()
  };

  tasks.set(taskId, task);
  console.log(`[File] Read: ${taskId} - ${path}`);

  res.json({ taskId, message: 'File read task created' });
});

// ========== Claude CLI API（调用本地 Claude Code） ==========

// [云端 OpenClaw 调用] 执行本地 Claude Code CLI
app.post('/claude', auth, (req, res) => {
  const { prompt, timeout = 120000, sessionId, callbackChannel } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  const taskId = crypto.randomUUID();
  // 自动生成 sessionId：确保每轮 CC 都有可追踪的 session，支持后续 --resume
  const effectiveSessionId = sessionId || crypto.randomUUID();
  const task = {
    id: taskId,
    type: 'claude-cli',
    prompt,
    timeout,
    sessionId: effectiveSessionId,
    callbackChannel: callbackChannel || null,
    status: 'pending',
    createdAt: Date.now()
  };

  tasks.set(taskId, task);

  // 更新会话跟踪
  activeSessions.set(effectiveSessionId, {
    lastActivity: Date.now(),
    taskCount: (activeSessions.get(effectiveSessionId)?.taskCount || 0)
  });

  const isResume = !!sessionId;
  console.log(`[Claude] Task: ${taskId} [session:${effectiveSessionId.slice(0, 8)}${isResume ? ',resume' : ',new'}]${callbackChannel ? ' [callback:' + callbackChannel + ']' : ''} - ${prompt.slice(0, 50)}...`);

  res.json({ taskId, sessionId: effectiveSessionId, message: 'Claude CLI task created' });
});

// ========== Discord 消息推送 ==========

// 让 cc-bridge hook 推消息到 Discord（hook 自己在容器里无法直推）
app.post('/notify', auth, async (req, res) => {
  const { channel, message } = req.body;
  if (!channel || !message) {
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
    res.status(502).json({ error: err.message });
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
  const limit = Math.min(parseInt(req.query.limit) || 10, 20);
  const fs = await import('fs');
  const path = await import('path');
  const readline = await import('readline');

  // 扫描 CC session 文件（容器内挂载路径，宿主机 ~/.claude/projects）
  const projectsDir = '/host-claude-projects';
  const sessions = [];

  try {
    const projectDirs = fs.default.readdirSync(projectsDir).filter(d =>
      fs.default.statSync(path.join(projectsDir, d)).isDirectory()
    );

    for (const dir of projectDirs) {
      const fullDir = path.join(projectsDir, dir);
      const files = fs.default.readdirSync(fullDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const fp = path.join(fullDir, f);
          const stat = fs.default.statSync(fp);
          return { file: f, path: fp, mtime: stat.mtimeMs, size: stat.size, project: dir };
        });
      sessions.push(...files);
    }
  } catch (e) {
    return res.json({ sessions: [], error: e.message });
  }

  // 按修改时间倒序，取最近 N 个
  sessions.sort((a, b) => b.mtime - a.mtime);
  const recent = sessions.slice(0, limit);

  // 提取每个会话的第一条 user 消息作为话题
  const results = [];
  for (const s of recent) {
    let topic = '';
    try {
      const stream = fs.default.createReadStream(s.path, { encoding: 'utf8' });
      const rl = readline.default.createInterface({ input: stream });
      for await (const line of rl) {
        try {
          const d = JSON.parse(line);
          if (d.message?.role === 'user') {
            const content = d.message.content;
            if (Array.isArray(content)) {
              const txt = content.find(c => c.type === 'text');
              if (txt) topic = txt.text.slice(0, 150);
            } else if (typeof content === 'string') {
              topic = content.slice(0, 150);
            }
            break;
          }
        } catch { /* skip malformed lines */ }
      }
      rl.close();
      stream.destroy();
    } catch { /* skip unreadable files */ }

    results.push({
      sessionId: s.file.replace('.jsonl', ''),
      project: s.project,
      lastModified: new Date(s.mtime).toISOString(),
      sizeKB: Math.round(s.size / 1024),
      topic: topic || '(no topic)',
    });
  }

  res.json({ sessions: results });
});

// ========== 清理过期任务 ==========
setInterval(() => {
  const now = Date.now();
  const TASK_EXPIRE_MS = 15 * 60 * 1000; // 未完成任务 15 分钟过期
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
  console.log(`Task API running on port ${PORT}`);
  console.log(`Auth token: ${AUTH_TOKEN.slice(0, 8)}...`);
});
