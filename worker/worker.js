#!/usr/bin/env node
/**
 * OpenClaw Worker - Local Task Executor
 *
 * Polls cloud Task API for work, executes tasks locally, reports results.
 * Supports shell commands, file operations, and Claude Code CLI execution.
 *
 * Run: node worker.js
 * Or: WORKER_URL=https://your-server:3456 WORKER_TOKEN=xxx node worker.js
 */

const { exec, spawn } = require('child_process');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ========== Configuration ==========
const CONFIG = {
  serverUrl: process.env.WORKER_URL || 'http://127.0.0.1:3456',
  token: process.env.WORKER_TOKEN || 'change-me-to-a-secure-token',
  pollInterval: parseInt(process.env.POLL_INTERVAL) || 500,  // Fallback interval (ms)
  longPollWait: parseInt(process.env.LONG_POLL_WAIT) || 30000, // Long poll hold time (ms)
  maxConcurrent: parseInt(process.env.MAX_CONCURRENT) || 3,  // Max 3 concurrent tasks
  defaultTimeout: 120000, // 2 minutes (for Claude Code tasks)
};

console.log('========================================');
console.log('  OpenClaw Worker v1.0');
console.log('========================================');
console.log(`Server: ${CONFIG.serverUrl}`);
console.log(`Long poll wait: ${CONFIG.longPollWait}ms`);
console.log(`Max concurrent: ${CONFIG.maxConcurrent} tasks`);
console.log('');
console.log('Supported task types:');
console.log('  - command: Execute shell commands');
console.log('  - file-read: Read files');
console.log('  - file-write: Write files');
console.log('  - claude-cli: Execute Claude Code CLI');
console.log('');

// ========== HTTP Request Wrapper ==========
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
    // Timeout must exceed long poll wait to avoid premature abort
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

// ========== Execute Shell Command ==========
function executeCommand(command, timeout) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const cleanCommand = command.trim();

    // Use login shell to load full environment (required for Claude Code)
    const wrappedCommand = `/bin/zsh -l -c ${JSON.stringify(cleanCommand)}`;

    exec(wrappedCommand, {
      timeout: timeout || CONFIG.defaultTimeout,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      env: {
        ...process.env,
        PATH: process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin',
        HOME: process.env.HOME,
        USER: process.env.USER
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

// ========== File Operations ==========
function expandHome(filePath) {
  if (filePath.startsWith('~/')) {
    return path.join(process.env.HOME, filePath.slice(2));
  }
  return filePath;
}

function writeFile(filePath, content, encoding) {
  return new Promise((resolve) => {
    try {
      const cleanPath = filePath.trim();
      const fullPath = expandHome(cleanPath);
      console.log(`[File Write] ${fullPath}`);

      const dir = path.dirname(fullPath);

      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

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

// ========== Execute Claude Code CLI ==========
const CLAUDE_PATH = '/opt/homebrew/bin/claude';

function executeClaudeCLI(prompt, timeout) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    console.log(`[Claude CLI] Executing: "${prompt.slice(0, 50)}..."`);

    // Use --dangerously-skip-permissions to bypass file access prompts (required for image recognition)
    const shellCmd = `${CLAUDE_PATH} --print --dangerously-skip-permissions "${prompt.replace(/"/g, '\\"')}"`;

    const child = spawn('/bin/zsh', ['-l', '-c', shellCmd], {
      cwd: process.env.HOME,
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
      stdout += data.toString();
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
      console.log(`[Claude CLI] Done in ${duration}ms, output ${stdout.length} bytes`);

      // Detect screenshot marker for external tools (Discord bots, etc.)
      const screenshotMatch = stdout.match(/PLEASE_UPLOAD_TO_DISCORD:\s*(.+\.png)/);
      const screenshotPath = screenshotMatch ? screenshotMatch[1].trim() : null;

      if (screenshotPath) {
        console.log(`[Claude CLI] Screenshot detected: ${screenshotPath}`);
      }

      const result = {
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code || 0,
        error: code ? `Exit code ${code}` : null,
        duration
      };

      // Add screenshot path to metadata if detected
      if (screenshotPath) {
        result.metadata = { screenshotPath };
      }

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

// ========== Concurrent Task Management ==========
let isRunning = true;
let consecutiveErrors = 0;
const runningTasks = new Set();

async function executeTask(task) {
  const taskId = task.id.slice(0, 8);

  try {
    let result;

    if (task.type === 'file-write') {
      console.log(`[${runningTasks.size}/${CONFIG.maxConcurrent}] [File Write] ${taskId}... - ${task.path.trim()}`);
      result = await writeFile(task.path, task.content, task.encoding);
    } else if (task.type === 'file-read') {
      console.log(`[${runningTasks.size}/${CONFIG.maxConcurrent}] [File Read] ${taskId}... - ${task.path}`);
      result = await readFile(task.path);
    } else if (task.type === 'claude-cli') {
      console.log(`[${runningTasks.size}/${CONFIG.maxConcurrent}] [Claude CLI] ${taskId}... - ${task.prompt?.slice(0, 50)}...`);
      result = await executeClaudeCLI(task.prompt, task.timeout);
    } else {
      console.log(`[${runningTasks.size}/${CONFIG.maxConcurrent}] [Command] ${taskId}... - ${task.command}`);
      result = await executeCommand(task.command, task.timeout);
    }

    // Report result to server
    await request('POST', '/worker/result', {
      taskId: task.id,
      ...result
    });

    const status = result.exitCode === 0 ? '✓' : '✗';
    console.log(`[Done] ${status} ${taskId}... (remaining: ${runningTasks.size - 1})`);

  } catch (err) {
    console.error(`[Error] ${taskId}... - ${err.message}`);
    try {
      await request('POST', '/worker/result', {
        taskId: task.id,
        stdout: '',
        stderr: err.message,
        exitCode: -1,
        error: err.message
      });
    } catch (reportErr) {
      console.error(`[Report Failed] ${taskId}... - ${reportErr.message}`);
    }
  } finally {
    runningTasks.delete(task.id);
  }
}

// Main polling loop
async function pollAndExecute() {
  while (isRunning) {
    try {
      if (runningTasks.size >= CONFIG.maxConcurrent) {
        await sleep(CONFIG.pollInterval);
        continue;
      }

      const pollRes = await request('GET', `/worker/poll?wait=${CONFIG.longPollWait}`);

      if (pollRes.status === 401) {
        console.error('[Error] Token authentication failed, check configuration');
        await sleep(10000);
        continue;
      }

      const task = pollRes.data;
      consecutiveErrors = 0;

      if (!task) {
        // Server already held connection for longPollWait, retry immediately
        continue;
      }

      runningTasks.add(task.id);
      executeTask(task); // Don't await, run in background

      if (runningTasks.size < CONFIG.maxConcurrent) {
        continue; // Immediately poll for next task
      }

    } catch (err) {
      consecutiveErrors++;
      const waitTime = Math.min(consecutiveErrors * 5000, 60000);

      if (consecutiveErrors === 1) {
        console.error(`[Connection Failed] ${err.message}`);
      }
      console.log(`[Retry] Waiting ${waitTime / 1000}s before retry (attempt ${consecutiveErrors})`);

      await sleep(waitTime);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ========== Graceful Shutdown ==========
process.on('SIGINT', () => {
  console.log('\n[Exit] Received Ctrl+C, stopping...');
  isRunning = false;
  setTimeout(() => process.exit(0), 1000);
});

process.on('SIGTERM', () => {
  console.log('\n[Exit] Received termination signal, stopping...');
  isRunning = false;
  setTimeout(() => process.exit(0), 1000);
});

// ========== Start Worker ==========
console.log('[Worker] Starting polling loop...');
pollAndExecute().catch(console.error);
