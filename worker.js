#!/usr/bin/env node
/**
 * Mac 本地 Worker
 * 主动轮询云端任务，执行后上报结果
 *
 * 运行: node worker.js
 * 或: WORKER_URL=https://xxx WORKER_TOKEN=xxx node worker.js
 */

const { exec, spawn } = require('child_process');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ========== 配置 ==========
const CONFIG = {
  // 云端任务 API 地址（改成你的腾讯云服务器）
  serverUrl: process.env.WORKER_URL || 'http://127.0.0.1:3456',
  // 认证 Token（和云端保持一致）
  token: process.env.WORKER_TOKEN || 'change-me-to-a-secure-token',
  // 轮询间隔（毫秒） - 仅在并发满时使用
  pollInterval: parseInt(process.env.POLL_INTERVAL) || 500,
  // 长轮询等待时间（毫秒） - 服务器 hold 住连接的时间
  longPollWait: parseInt(process.env.LONG_POLL_WAIT) || 30000,
  // 最大并发任务数
  maxConcurrent: parseInt(process.env.MAX_CONCURRENT) || 3,
  // 命令执行超时（毫秒）- 改为5分钟，适配Claude AI任务和content-alchemy skill
  defaultTimeout: 300000,
  // OpenClaw Hooks 回调配置（CC 完成后通知 bot）
  openclawHooksUrl: process.env.OPENCLAW_HOOKS_URL || 'http://127.0.0.1:18791',
  openclawHooksToken: process.env.OPENCLAW_HOOKS_TOKEN || 'cc-callback-2026',
};

console.log('========================================');
console.log('  Mac Worker 启动 (并发模式)');
console.log('========================================');
console.log(`服务器: ${CONFIG.serverUrl}`);
console.log(`长轮询等待: ${CONFIG.longPollWait}ms`);
console.log(`最大并发: ${CONFIG.maxConcurrent} 个任务`);
console.log('');
console.log('支持的任务类型:');
console.log('  - command: 执行 shell 命令');
console.log('  - file-read: 读取文件');
console.log('  - file-write: 写入文件');
console.log('  - claude-cli: 调用本地 Claude Code CLI');
console.log('');

// ========== HTTP 请求封装 ==========
function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, CONFIG.serverUrl);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Bearer ${CONFIG.token}`,
        'Content-Type': 'application/json',
      },
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data || 'null') });
        } catch {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on('error', reject);
    // 长轮询请求的超时要大于 hold 时间，避免提前断开
    const reqTimeout = path.includes('/worker/poll') ? CONFIG.longPollWait + 5000 : 10000;
    req.setTimeout(reqTimeout, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// ========== 执行命令 ==========
function executeCommand(command, timeout) {
  return new Promise((resolve) => {
    const startTime = Date.now();

    // 清理命令：去掉末尾的换行符和空格
    const cleanCommand = command.trim();

    // 使用 login shell (-l) 来加载 .zshrc 配置（Claude Code 需要）
    // 直接用 /bin/zsh -l -c 执行，不再指定 shell 选项避免双重包装
    const wrappedCommand = `/bin/zsh -l -c ${JSON.stringify(cleanCommand)}`;

    exec(wrappedCommand, {
      timeout: timeout || CONFIG.defaultTimeout,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      // 移除 shell 选项，避免双重包装
      env: {
        ...process.env,
        PATH: process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin',
        HOME: process.env.HOME, // 确保 HOME 环境变量
        USER: process.env.USER  // 确保 USER 环境变量
      }
    }, (error, stdout, stderr) => {
      const duration = Date.now() - startTime;

      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        exitCode: error ? error.code || 1 : 0,
        error: error ? error.message : null,
        duration
      });
    });
  });
}

// ========== 文件操作 ==========
function expandHome(filePath) {
  if (filePath.startsWith('~/')) {
    return path.join(process.env.HOME, filePath.slice(2));
  }
  return filePath;
}

function writeFile(filePath, content, encoding) {
  return new Promise((resolve) => {
    try {
      // 清理 path 中的换行符
      const cleanPath = filePath.trim();
      const fullPath = expandHome(cleanPath);
      console.log(`[写入] ${fullPath}`);

      const dir = path.dirname(fullPath);

      // 确保目录存在
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // 如果是 base64 编码，先解码；同时 trim content
      const cleanContent = content ? content.trim() : '';
      const data = encoding === 'base64'
        ? Buffer.from(cleanContent, 'base64')
        : cleanContent;

      fs.writeFileSync(fullPath, data);

      resolve({
        stdout: `File written: ${fullPath}`,
        stderr: '',
        exitCode: 0,
        error: null
      });
    } catch (err) {
      resolve({
        stdout: '',
        stderr: err.message,
        exitCode: 1,
        error: err.message
      });
    }
  });
}

function readFile(filePath) {
  return new Promise((resolve) => {
    try {
      const fullPath = expandHome(filePath);
      const content = fs.readFileSync(fullPath, 'utf8');
      resolve({
        stdout: content,
        stderr: '',
        exitCode: 0,
        error: null
      });
    } catch (err) {
      resolve({
        stdout: '',
        stderr: err.message,
        exitCode: 1,
        error: err.message
      });
    }
  });
}

// ========== 执行本地 Claude CLI ==========
const CLAUDE_PATH = '/opt/homebrew/bin/claude';
const CC_LOG = '/tmp/cc-live.log';
const ccSessions = new Set(); // 跟踪已创建的 CC 会话

function executeClaudeCLI(prompt, timeout, sessionId) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    console.log(`[Claude CLI] 执行: "${prompt.slice(0, 50)}..."${sessionId ? ' [会话:' + sessionId.slice(0, 8) + ']' : ''}`);

    // 构建会话参数：已有会话用 --resume，新会话用 --session-id
    let sessionFlag = '';
    if (sessionId) {
      if (ccSessions.has(sessionId)) {
        sessionFlag = ` --resume "${sessionId}"`;
      } else {
        sessionFlag = ` --session-id "${sessionId}"`;
        ccSessions.add(sessionId);
      }
    }

    const shellCmd = `${CLAUDE_PATH} --print${sessionFlag} --dangerously-skip-permissions "${prompt.replace(/"/g, '\\"')}"`;
    console.log(`[Claude CLI] 命令: ${shellCmd}`);

    // 写入实时日志
    try { fs.appendFileSync(CC_LOG, `\n${'='.repeat(60)}\n[${new Date().toISOString()}] CC 开始: ${prompt.slice(0, 80)}...\n${'='.repeat(60)}\n`); } catch (e) {}
    const child = spawn('/bin/zsh', ['-l', '-c', shellCmd], {
      cwd: process.env.HOME,  // 设置工作目录为用户主目录
      env: {
        ...process.env,
        PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:' + process.env.PATH,
        TERM: 'xterm-256color',
        HOME: process.env.HOME
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      try { fs.appendFileSync(CC_LOG, chunk); } catch (e) {}
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      child.kill();
      resolve({
        stdout,
        stderr: 'Timeout',
        exitCode: -1,
        error: 'Timeout',
        duration: Date.now() - startTime
      });
    }, timeout || CONFIG.defaultTimeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      const duration = Date.now() - startTime;
      console.log(`[Claude CLI] 完成，耗时 ${duration}ms，输出 ${stdout.length} 字节`);

      // 写入实时日志结束标记
      try { fs.appendFileSync(CC_LOG, `\n[${new Date().toISOString()}] CC 结束 (${duration}ms, exit ${code})\n`); } catch (e) {}

      // 检测截图标记
      const screenshotMatch = stdout.match(/PLEASE_UPLOAD_TO_DISCORD:\s*(.+\.png)/);
      const screenshotPath = screenshotMatch ? screenshotMatch[1].trim() : null;

      if (screenshotPath) {
        console.log(`[Claude CLI] 检测到截图: ${screenshotPath}`);
      }

      // 从 history.jsonl 提取 CC 会话 ID（用于多轮对话跟踪）
      let ccSessionId = sessionId || null;
      if (!ccSessionId) {
        try {
          const historyPath = path.join(process.env.HOME, '.claude', 'history.jsonl');
          const lines = fs.readFileSync(historyPath, 'utf8').trim().split('\n');
          const lastEntry = JSON.parse(lines[lines.length - 1]);
          ccSessionId = lastEntry.sessionId || null;
        } catch (e) {}
      }

      const result = {
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code || 0,
        error: code ? `Exit code ${code}` : null,
        duration
      };

      // 添加 metadata（截图、会话ID）
      const metadata = {};
      if (screenshotPath) metadata.screenshotPath = screenshotPath;
      if (ccSessionId) metadata.sessionId = ccSessionId;
      if (Object.keys(metadata).length > 0) result.metadata = metadata;

      resolve(result);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: err.message,
        exitCode: -1,
        error: err.message,
        duration: Date.now() - startTime
      });
    });
  });
}

// ========== OpenClaw CLI 回调（直接发 Discord 消息，不经过 agent） ==========
function notifyOpenClaw(task, result) {
  // 只对 claude-cli 任务回调，且需要有 callbackChannel
  if (task.type !== 'claude-cli' || !task.callbackChannel) return;

  const summary = (result.stdout || '').slice(-1500) || '(无输出)';
  const status = result.exitCode === 0 ? '完成' : '失败';
  const duration = result.duration ? `${Math.round(result.duration / 1000)}s` : '未知';

  // 包含 sessionId 供分段多轮对话使用
  const sessionId = result.metadata?.sessionId;
  const sessionInfo = sessionId ? `\n📎 sessionId: \`${sessionId}\`` : '';

  const message = `**CC 任务${status}**（耗时 ${duration}）${sessionInfo}\n\n${summary}`;

  // 用 execFile 避免 shell 注入，通过 docker exec 调用 OpenClaw CLI
  const { execFile } = require('child_process');
  execFile('docker', [
    'exec', 'openclaw-antigravity',
    'node', 'openclaw.mjs', 'message', 'send',
    '--channel', 'discord',
    '--target', `channel:${task.callbackChannel}`,
    '-m', message
  ], { timeout: 15000, maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) {
      console.error(`[回调] OpenClaw CLI 发送失败: ${error.message}`);
    } else {
      console.log(`[回调] 已推送到 Discord 频道 ${task.callbackChannel}`);
    }
  });
}

// ========== 并发任务管理 ==========
let isRunning = true;
let consecutiveErrors = 0;
const runningTasks = new Set(); // 跟踪运行中的任务

// 执行单个任务（独立 Promise）
async function executeTask(task) {
  const taskId = task.id.slice(0, 8);

  try {
    // 根据任务类型执行
    let result;

    if (task.type === 'file-write') {
      console.log(`[${runningTasks.size}/${CONFIG.maxConcurrent}] [文件写入] ${taskId}... - ${task.path.trim()}`);
      result = await writeFile(task.path, task.content, task.encoding);
    } else if (task.type === 'file-read') {
      console.log(`[${runningTasks.size}/${CONFIG.maxConcurrent}] [文件读取] ${taskId}... - ${task.path}`);
      result = await readFile(task.path);
    } else if (task.type === 'claude-cli') {
      // 调用本地 Claude Code CLI
      console.log(`[${runningTasks.size}/${CONFIG.maxConcurrent}] [Claude CLI] ${taskId}... - ${task.prompt?.slice(0, 50)}...`);
      result = await executeClaudeCLI(task.prompt, task.timeout, task.sessionId);
    } else {
      // 默认：执行命令
      console.log(`[${runningTasks.size}/${CONFIG.maxConcurrent}] [命令] ${taskId}... - ${task.command}`);
      result = await executeCommand(task.command, task.timeout);
    }

    // 上报结果
    await request('POST', '/worker/result', {
      taskId: task.id,
      ...result
    });

    // CC 任务完成后回调通知 OpenClaw bot
    notifyOpenClaw(task, result);

    const status = result.exitCode === 0 ? '✓' : '✗';
    console.log(`[完成] ${status} ${taskId}... (剩余: ${runningTasks.size - 1})`);

  } catch (err) {
    console.error(`[错误] ${taskId}... - ${err.message}`);
    // 上报错误
    try {
      await request('POST', '/worker/result', {
        taskId: task.id,
        stdout: '',
        stderr: err.message,
        exitCode: -1,
        error: err.message
      });
    } catch (reportErr) {
      console.error(`[上报失败] ${taskId}... - ${reportErr.message}`);
    }
  } finally {
    runningTasks.delete(task.id);
  }
}

// 主轮询循环（只负责拉取任务）
async function pollAndExecute() {
  while (isRunning) {
    try {
      // 检查是否有空闲槽位
      if (runningTasks.size >= CONFIG.maxConcurrent) {
        await sleep(CONFIG.pollInterval);
        continue;
      }

      // 长轮询获取任务（服务器会 hold 住连接等任务到来）
      const pollRes = await request('GET', `/worker/poll?wait=${CONFIG.longPollWait}`);

      if (pollRes.status === 401) {
        console.error('[错误] Token 认证失败，请检查配置');
        await sleep(10000);
        continue;
      }

      const task = pollRes.data;
      consecutiveErrors = 0; // 重置错误计数

      if (!task) {
        // 服务器已经 hold 了 longPollWait，直接重试
        continue;
      }

      // 启动任务（不等待完成）
      runningTasks.add(task.id);
      executeTask(task); // 不 await，让它在后台运行

      // 立即尝试拉取下一个任务（如果还有空闲槽位）
      if (runningTasks.size < CONFIG.maxConcurrent) {
        continue; // 立即进入下一次循环
      }

    } catch (err) {
      consecutiveErrors++;
      const waitTime = Math.min(consecutiveErrors * 5000, 60000); // 最多等 1 分钟

      if (consecutiveErrors === 1) {
        console.error(`[连接失败] ${err.message}`);
      }
      console.log(`[重试] ${waitTime / 1000}s 后重试... (第 ${consecutiveErrors} 次)`);

      await sleep(waitTime);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ========== 优雅退出 ==========
process.on('SIGINT', () => {
  console.log('\n[退出] 收到 Ctrl+C，正在停止...');
  isRunning = false;
  setTimeout(() => process.exit(0), 1000);
});

process.on('SIGTERM', () => {
  console.log('\n[退出] 收到终止信号，正在停止...');
  isRunning = false;
  setTimeout(() => process.exit(0), 1000);
});

// ========== 启动 ==========
pollAndExecute().catch(console.error);
