/**
 * 云端任务 API 服务
 * 部署在腾讯云服务器上，和 OpenClaw 一起跑
 */

const express = require('express');
const crypto = require('crypto');
const app = express();

app.use(express.json());

// ========== 配置 ==========
const AUTH_TOKEN = process.env.WORKER_TOKEN || 'change-me-to-a-secure-token';
const PORT = process.env.WORKER_PORT || 3456;

// Callback: push CC results to Discord via OpenClaw CLI
// Docker mode (Mac): CALLBACK_CONTAINER=openclaw-antigravity
// Native mode (AWS): CALLBACK_CLI=/path/to/openclaw.mjs
const CALLBACK_CONTAINER = process.env.CALLBACK_CONTAINER || '';
const CALLBACK_CLI = process.env.CALLBACK_CLI || '';

// ========== 内存任务队列 ==========
const tasks = new Map();      // taskId -> task
const results = new Map();    // taskId -> result

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
  res.json({ status: 'ok', tasks: tasks.size, results: results.size });
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

  // Server-side callback: push result to Discord if configured
  let callbackHandled = false;
  const task = tasks.get(taskId);
  if (task) {
    callbackHandled = notifyCallback(task, result);
  }

  res.json({ success: true, callbackHandled });
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
  const { prompt, timeout = 120000, sessionId, callbackChannel, callbackContainer, callbackPlatform } = req.body;

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
    callbackContainer: callbackContainer || null,
    callbackPlatform: callbackPlatform || 'discord',
    status: 'pending',
    createdAt: Date.now()
  };

  tasks.set(taskId, task);
  const isResume = !!sessionId;
  console.log(`[Claude] Task: ${taskId} [session:${effectiveSessionId.slice(0, 8)}${isResume ? ',resume' : ',new'}]${callbackChannel ? ' [callback:' + callbackChannel + ']' : ''} - ${prompt.slice(0, 50)}...`);

  res.json({ taskId, sessionId: effectiveSessionId, message: 'Claude CLI task created' });
});

// ========== 服务端回调（推送 CC 结果到 Discord） ==========
function notifyCallback(task, result) {
  if (task.type !== 'claude-cli' || !task.callbackChannel) return false;
  // Per-request container overrides global env var
  const effectiveContainer = task.callbackContainer || CALLBACK_CONTAINER;
  if (!CALLBACK_CLI && !effectiveContainer) return false;

  const summary = (result.stdout || '').slice(-1500) || '(无输出)';
  const status = result.exitCode === 0 ? '完成' : '失败';
  const duration = result.completedAt && task.createdAt
    ? `${Math.round((result.completedAt - task.createdAt) / 1000)}s` : '未知';
  const sessionId = result.metadata?.sessionId || task.sessionId;
  const sessionInfo = sessionId ? `\n📎 sessionId: \`${sessionId}\`` : '';
  const message = `**CC 任务${status}**（耗时 ${duration}）${sessionInfo}\n\n${summary}`;

  const { execFile } = require('child_process');
  const maxRetries = 3;
  let attempt = 0;

  function trySend() {
    attempt++;
    let cmd, args;

    const platform = task.callbackPlatform || 'discord';
    const target = platform === 'telegram' ? task.callbackChannel : `channel:${task.callbackChannel}`;

    if (effectiveContainer) {
      // Docker mode: docker exec <container> node openclaw.mjs message send ...
      cmd = 'docker';
      args = ['exec', effectiveContainer, 'node', 'openclaw.mjs', 'message', 'send',
        '--channel', platform, '--target', target, '-m', message];
    } else {
      // Native CLI mode: node <path/to/openclaw.mjs> message send ...
      cmd = 'node';
      args = [CALLBACK_CLI, 'message', 'send',
        '--channel', platform, '--target', target, '-m', message];
    }

    execFile(cmd, args, { timeout: 15000, maxBuffer: 5 * 1024 * 1024 }, (error) => {
      if (error) {
        if (attempt < maxRetries) {
          console.error(`[Callback] Attempt ${attempt} failed, retry in 5s: ${error.message.slice(0, 100)}`);
          setTimeout(trySend, 5000);
        } else {
          console.error(`[Callback] All ${maxRetries} attempts failed: ${error.message.slice(0, 200)}`);
        }
      } else {
        console.log(`[Callback] Sent to ${platform} ${target}`);
      }
    });
  }

  trySend();
  return true;
}

// ========== 清理过期任务 ==========
setInterval(() => {
  const now = Date.now();
  const TASK_EXPIRE_MS = 15 * 60 * 1000; // 未完成任务 15 分钟过期
  const RESULT_EXPIRE_MS = 30 * 60 * 1000; // 已完成结果保留 30 分钟

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
}, 60000);

// ========== 启动 ==========
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Task API running on port ${PORT}`);
  console.log(`Auth token: ${AUTH_TOKEN.slice(0, 8)}...`);
});
