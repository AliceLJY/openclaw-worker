/**
 * OpenClaw Worker - Cloud Task API
 *
 * Lightweight HTTP API for managing task queue between cloud clients
 * (Discord bots, web apps) and local workers.
 *
 * Deploy this on your cloud server alongside OpenClaw.
 */

const express = require('express');
const crypto = require('crypto');
const app = express();

app.use(express.json());

// ========== Configuration ==========
const AUTH_TOKEN = process.env.WORKER_TOKEN || 'change-me-to-a-secure-token';
const PORT = process.env.WORKER_PORT || 3456;

// ========== In-Memory Task Queue ==========
const tasks = new Map();      // taskId -> task
const results = new Map();    // taskId -> result

// ========== Authentication Middleware ==========
function auth(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ========== API Routes ==========

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', tasks: tasks.size, results: results.size });
});

// [Client] Submit shell command task
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

// [Client] Get task result (with long polling support)
app.get('/tasks/:taskId', auth, async (req, res) => {
  const { taskId } = req.params;
  const waitMs = parseInt(req.query.wait) || 0;

  const startTime = Date.now();

  // Long polling: wait for result or timeout
  while (Date.now() - startTime < waitMs) {
    if (results.has(taskId)) {
      const result = results.get(taskId);
      results.delete(taskId);
      tasks.delete(taskId);
      return res.json(result);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // Timeout reached, check one more time
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

// [Worker] Poll for pending tasks (long polling)
app.get('/worker/poll', auth, async (req, res) => {
  const waitMs = Math.min(parseInt(req.query.wait) || 30000, 60000);

  // Check immediately first
  for (const [taskId, task] of tasks) {
    if (task.status === 'pending') {
      task.status = 'running';
      console.log(`[Worker] Picked up: ${taskId}`);
      return res.json(task);
    }
  }

  // Long poll: hold connection, check every 500ms
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

  res.json(null); // Timeout, no pending tasks
});

// [Worker] Report task result
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

  // Add metadata if provided (e.g., screenshot paths)
  if (metadata) {
    result.metadata = metadata;
  }

  results.set(taskId, result);
  console.log(`[Worker] Result: ${taskId} - exit ${exitCode}`);
  if (metadata?.screenshotPath) {
    console.log(`[Worker] Screenshot: ${metadata.screenshotPath}`);
  }

  res.json({ success: true });
});

// ========== File Operations API ==========

// [Client] Write file on local machine
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
    encoding,
    status: 'pending',
    createdAt: Date.now()
  };

  tasks.set(taskId, task);
  console.log(`[File] Write: ${taskId} - ${path}`);

  res.json({ taskId, message: 'File write task created' });
});

// [Client] Read file from local machine
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

// ========== Claude Code CLI API ==========

// [Client] Execute Claude Code CLI on local machine
app.post('/claude', auth, (req, res) => {
  const { prompt, timeout = 120000, sessionId } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  const taskId = crypto.randomUUID();
  const task = {
    id: taskId,
    type: 'claude-cli',
    prompt,
    timeout,
    sessionId: sessionId || null,
    status: 'pending',
    createdAt: Date.now()
  };

  tasks.set(taskId, task);
  console.log(`[Claude] Task: ${taskId}${sessionId ? ' [resume:' + sessionId.slice(0, 8) + ']' : ''} - ${prompt.slice(0, 50)}...`);

  res.json({ taskId, sessionId: sessionId || null, message: 'Claude CLI task created' });
});

// ========== Task Cleanup ==========
setInterval(() => {
  const now = Date.now();
  const EXPIRE_MS = 5 * 60 * 1000; // 5 minutes

  for (const [taskId, task] of tasks) {
    if (now - task.createdAt > EXPIRE_MS) {
      tasks.delete(taskId);
      results.delete(taskId);
      console.log(`[Cleanup] Expired: ${taskId}`);
    }
  }
}, 60000);

// ========== Start Server ==========
app.listen(PORT, '0.0.0.0', () => {
  console.log(`OpenClaw Worker Task API v1.0`);
  console.log(`Running on port ${PORT}`);
  console.log(`Auth token: ${AUTH_TOKEN.slice(0, 8)}...`);
  console.log(`Ready to accept tasks from clients and workers.`);
});
