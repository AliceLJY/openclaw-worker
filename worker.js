#!/usr/bin/env node
/**
 * Mac 本地 Worker
 * Agent SDK 版本：流式输出 + 会话管理
 *
 * 运行: node worker.js
 * 或: WORKER_URL=https://xxx WORKER_TOKEN=xxx node worker.js
 */

import { exec, spawn, execFile } from 'child_process';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';

// 防止嵌套检测（从 CC 内部启动时需要）
delete process.env.CLAUDECODE;

// ========== Agent SDK 加载（失败则回退 CLI） ==========
let sdkQuery;
try {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  sdkQuery = sdk.query;
  console.log('[SDK] Agent SDK 加载成功');
} catch (e) {
  console.warn(`[SDK] Agent SDK 加载失败，将使用 CLI 模式: ${e.message}`);
}

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
console.log('  Mac Worker 启动 (Agent SDK + CLI 双模式)');
console.log('========================================');
console.log(`服务器: ${CONFIG.serverUrl}`);
console.log(`长轮询等待: ${CONFIG.longPollWait}ms`);
console.log(`最大并发: ${CONFIG.maxConcurrent} 个任务`);
console.log(`执行模式: ${sdkQuery ? 'Agent SDK (优先)' : 'CLI (回退)'}`);
console.log('');
console.log('支持的任务类型:');
console.log('  - command: 执行 shell 命令');
console.log('  - file-read: 读取文件');
console.log('  - file-write: 写入文件');
console.log('  - file-edit: 编辑文件（局部替换）');
console.log('  - claude-cli: 调用本地 Claude Code (SDK/CLI)');
console.log('  - codex-cli: 调用本地 Codex CLI');
console.log('  - gemini-cli: 调用本地 Gemini CLI');
console.log('');

// ========== HTTP 请求封装 ==========
function request(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, CONFIG.serverUrl);
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
    const reqTimeout = urlPath.includes('/worker/poll') ? CONFIG.longPollWait + 5000 : 10000;
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
// NOTE: exec() 在此处是有意使用的——worker 本身就是命令执行服务
function executeCommand(command, timeout) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const cleanCommand = command.trim();
    const wrappedCommand = `/bin/zsh -l -c ${JSON.stringify(cleanCommand)}`;

    exec(wrappedCommand, {
      timeout: timeout || CONFIG.defaultTimeout,
      maxBuffer: 10 * 1024 * 1024,
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

// ========== 文件操作 ==========
function expandHome(filePath) {
  if (filePath.startsWith('~/')) {
    return path.join(process.env.HOME, filePath.slice(2));
  }
  return filePath;
}

function writeFileToDisk(filePath, content, encoding) {
  return new Promise((resolve) => {
    try {
      const cleanPath = filePath.trim();
      const fullPath = expandHome(cleanPath);
      console.log(`[写入] ${fullPath}`);

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

function readFileFromDisk(filePath) {
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

function editFileOnDisk(filePath, oldString, newString, replaceAll) {
  return new Promise((resolve) => {
    try {
      const fullPath = expandHome(filePath.trim());
      console.log(`[编辑] ${fullPath}`);

      if (!fs.existsSync(fullPath)) {
        return resolve({
          stdout: '',
          stderr: `File not found: ${fullPath}`,
          exitCode: 1,
          error: 'File not found'
        });
      }

      let content = fs.readFileSync(fullPath, 'utf8');

      if (!content.includes(oldString)) {
        return resolve({
          stdout: '',
          stderr: `old_string not found in ${fullPath}`,
          exitCode: 1,
          error: 'old_string not found'
        });
      }

      if (!replaceAll) {
        // 非全局替换时，检查 old_string 是否唯一
        const count = content.split(oldString).length - 1;
        if (count > 1) {
          return resolve({
            stdout: '',
            stderr: `old_string found ${count} times in ${fullPath}, use replace_all or provide more context`,
            exitCode: 1,
            error: 'old_string not unique'
          });
        }
      }

      content = replaceAll
        ? content.split(oldString).join(newString)
        : content.replace(oldString, newString);

      fs.writeFileSync(fullPath, content);
      resolve({
        stdout: `File edited: ${fullPath}`,
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

// ========== 会话管理 ==========
const SESSION_FILE = '/tmp/cc-sessions.json';
const liveSessions = new Map();   // sdkSessionId → { lastActivity, callbackChannel }
const sessionIdMap = new Map();   // taskApiSessionId → sdkSessionId（映射表）
const ccSessions = new Set();     // CLI 模式用：跟踪已创建的 CC 会话

// 短 ID 前缀匹配：/cc-recent 显示 8 位截断 ID，resume 需要完整 UUID
function resolveSessionPrefix(prefix) {
  if (!prefix) return prefix;
  // 已经是完整 UUID（含连字符 36 位，纯 hex 32 位）→ 直接返回
  if (prefix.length >= 32) return prefix;

  const sessionDir = path.join(process.env.HOME, '.claude', 'projects', '-Users-' + path.basename(process.env.HOME));
  try {
    const files = fs.readdirSync(sessionDir);
    const matches = files.filter(f => f.startsWith(prefix) && f.endsWith('.jsonl'));
    if (matches.length === 1) {
      const fullId = matches[0].replace('.jsonl', '');
      console.log(`[Session] 前缀匹配: ${prefix} → ${fullId}`);
      return fullId;
    } else if (matches.length > 1) {
      // 多个匹配 → 取最近修改的
      const sorted = matches
        .map(f => ({ file: f, mtime: fs.statSync(path.join(sessionDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      const fullId = sorted[0].file.replace('.jsonl', '');
      console.log(`[Session] 前缀 ${prefix} 匹配到 ${matches.length} 个会话，取最新: ${fullId}`);
      return fullId;
    }
  } catch { /* 目录不存在 */ }
  return prefix; // 没找到，返回原值让下游处理
}

function loadSessions() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    for (const s of data) {
      liveSessions.set(s.sessionId, {
        lastActivity: s.lastActivity,
        callbackChannel: s.callbackChannel
      });
      ccSessions.add(s.sessionId);
      // 恢复映射关系
      if (s.taskApiId) {
        sessionIdMap.set(s.taskApiId, s.sessionId);
      }
    }
    console.log(`[会话] 恢复了 ${liveSessions.size} 个会话记录`);
  } catch {
    // 文件不存在或格式错误，忽略
  }
}

function saveSessions() {
  try {
    // 反向查找 taskApiId
    const reverseMap = new Map();
    for (const [taskApiId, sdkId] of sessionIdMap) {
      reverseMap.set(sdkId, taskApiId);
    }
    const data = Array.from(liveSessions.entries()).map(([sessionId, s]) => ({
      sessionId,
      taskApiId: reverseMap.get(sessionId) || null,
      lastActivity: s.lastActivity,
      callbackChannel: s.callbackChannel
    }));
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[会话] 保存失败:', e.message);
  }
}

loadSessions();

// 每 5 分钟清理超过 30 分钟不活跃的会话
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [id] of liveSessions) {
    const session = liveSessions.get(id);
    if (now - session.lastActivity > 30 * 60 * 1000) {
      liveSessions.delete(id);
      ccSessions.delete(id);
      // 清理映射表中指向该 SDK session 的条目
      for (const [apiId, sdkId] of sessionIdMap) {
        if (sdkId === id) sessionIdMap.delete(apiId);
      }
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[会话] 清理了 ${cleaned} 个过期会话，剩余 ${liveSessions.size} 个`);
    saveSessions();
  }
}, 5 * 60 * 1000);

// ========== Discord 推送（通过代理，绕过 AntiBot LLM） ==========
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const DISCORD_PROXY = process.env.DISCORD_PROXY || 'http://127.0.0.1:7897';

/**
 * 通过 HTTP 代理发送 Discord 消息（CONNECT 隧道）
 * 本机直连 discord.com 被墙，必须走代理
 */
function discordPost(channelId, content, botToken) {
  const token = botToken || DISCORD_BOT_TOKEN;
  return new Promise((resolve, reject) => {
    const proxy = new URL(DISCORD_PROXY);
    const body = JSON.stringify({ content: content.slice(0, 2000) });

    // 第一步：通过代理建立 CONNECT 隧道
    const connectReq = http.request({
      host: proxy.hostname,
      port: proxy.port,
      method: 'CONNECT',
      path: 'discord.com:443',
    });

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Proxy CONNECT ${res.statusCode}`));
        return;
      }

      // 第二步：通过隧道发 HTTPS 请求
      const req = https.request({
        hostname: 'discord.com',
        path: `/api/v10/channels/${channelId}/messages`,
        method: 'POST',
        headers: {
          'Authorization': `Bot ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        socket,
        agent: false,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, data }));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    connectReq.on('error', reject);
    connectReq.setTimeout(10000, () => {
      connectReq.destroy();
      reject(new Error('Proxy connect timeout'));
    });
    connectReq.end();
  });
}

function notifyDiscord(callbackChannel, sessionId, text, prefix, botToken) {
  if (!callbackChannel) return;

  const sessionInfo = sessionId ? `\n📎 sessionId: \`${sessionId.slice(0, 8)}\`` : '';
  let message = `**${prefix}**${sessionInfo}\n\n${text}`;
  if (message.length > 2000) message = message.slice(0, 1997) + '...';

  const maxRetries = 3;
  let attempt = 0;

  function trySend() {
    attempt++;
    discordPost(callbackChannel, message, botToken).then(({ status, data }) => {
      if (status >= 200 && status < 300) {
        console.log(`[回调] 推送成功 (${prefix})`);
      } else if (attempt < maxRetries) {
        console.error(`[回调] 第${attempt}次失败 (${status})，5s 后重试`);
        setTimeout(trySend, 5000);
      } else {
        console.error(`[回调] ${maxRetries}次均失败 (${status}): ${data.slice(0, 100)}`);
      }
    }).catch(err => {
      if (attempt < maxRetries) {
        console.error(`[回调] 第${attempt}次错误，5s 后重试: ${err.message}`);
        setTimeout(trySend, 5000);
      } else {
        console.error(`[回调] ${maxRetries}次均失败: ${err.message}`);
      }
    });
  }

  trySend();
}

// ========== 消息过滤 & 格式化（SDK 模式用） ==========
const SILENT_TOOLS = new Set([
  'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'
]);

const READ_ONLY_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'
]);

function formatAssistantMessage(msg) {
  if (msg.type !== 'assistant' || !msg.message?.content) return null;

  const parts = [];

  for (const block of msg.message.content) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    } else if (block.type === 'tool_use') {
      if (SILENT_TOOLS.has(block.name)) continue;
      if (READ_ONLY_TOOLS.has(block.name)) continue;
      const inputPreview = typeof block.input === 'object'
        ? (block.input.command || block.input.file_path || block.input.description || '').slice(0, 80)
        : '';
      parts.push(`🔧 ${block.name}${inputPreview ? ': ' + inputPreview : ''}`);
    }
  }

  return parts.length > 0 ? parts.join('\n') : null;
}

// ========== Agent SDK 执行 ==========
async function executeClaudeSDK(prompt, timeout, sessionId, callbackChannel, model) {
  const startTime = Date.now();

  // 判断 sessionId 是否对应一个真实的 CC session 文件（终端开的会话）
  // 如果是，直接用它做 resume，不走 sessionIdMap（避免脏映射覆盖）
  let sdkSessionId = null;
  if (sessionId) {
    const projectDir = path.join(process.env.HOME, '.claude', 'projects', '-Users-' + path.basename(process.env.HOME));
    const sessionFile = path.join(projectDir, sessionId + '.jsonl');
    if (fs.existsSync(sessionFile)) {
      // 真实 CC session 文件存在 → 直接 resume 这个终端会话
      sdkSessionId = sessionId;
    } else {
      // 精确文件不存在 → 先尝试短 ID 前缀匹配
      if (!sessionId.includes('-') || sessionId.length < 36) {
        try {
          const matches = fs.readdirSync(projectDir)
            .filter(f => f.startsWith(sessionId) && f.endsWith('.jsonl'));
          if (matches.length === 1) {
            sdkSessionId = matches[0].replace('.jsonl', '');
            console.log(`[SDK] 短 ID 前缀匹配: ${sessionId} → ${sdkSessionId.slice(0, 8)}...`);
          } else if (matches.length > 1) {
            console.warn(`[SDK] 短 ID ${sessionId} 匹配到 ${matches.length} 个 session，跳过`);
          }
        } catch { /* projectDir 不存在 */ }
      }
      // 前缀也没匹配到 → 走 sessionIdMap 映射
      if (!sdkSessionId) {
        sdkSessionId = sessionIdMap.get(sessionId) || null;
        if (!sdkSessionId) {
          // 从文件重新加载映射（其他 worker 进程可能已写入）
          try {
            const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
            for (const s of data) {
              if (s.taskApiId && s.sessionId) {
                sessionIdMap.set(s.taskApiId, s.sessionId);
                if (!liveSessions.has(s.sessionId)) {
                  liveSessions.set(s.sessionId, { lastActivity: s.lastActivity, callbackChannel: s.callbackChannel });
                }
              }
            }
            sdkSessionId = sessionIdMap.get(sessionId) || null;
            if (sdkSessionId) console.log(`[SDK] 从文件恢复映射: API:${sessionId.slice(0, 8)} → SDK:${sdkSessionId.slice(0, 8)}`);
          } catch { /* 文件不存在或格式错误 */ }
        }
      }
    }
  }
  const isResume = !!sdkSessionId;

  console.log(`[SDK] ${isResume ? '续接' : '新建'}会话: "${prompt.slice(0, 50)}..."${sessionId ? ' [API:' + sessionId.slice(0, 8) + (sdkSessionId ? ' → SDK:' + sdkSessionId.slice(0, 8) : '') + ']' : ''}`);

  // 构建 options（resume 也需要权限配置，否则子进程立即退出）
  // model 由调用方传入，支持 fallback 重试
  const baseOptions = {
    model: model || 'claude-opus-4-6',
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    cwd: process.env.HOME,
  };
  const options = isResume
    ? { ...baseOptions, resume: sdkSessionId }
    : {
        ...baseOptions,
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code' },
      };

  // 流式输出 debounce
  let buffer = [];
  let debounceTimer = null;
  const DEBOUNCE_MS = 3000;
  let capturedSessionId = sessionId || null;

  function flush() {
    // 不推流式进度到 Discord，保持干净的聊天体验
    buffer = [];
    debounceTimer = null;
  }

  let resultText = '';
  let resultSubtype = 'success';
  let resultErrors = [];

  // 超时保护
  const timeoutMs = (timeout || CONFIG.defaultTimeout) + 30000;
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);

  try {
    for await (const message of sdkQuery({
      prompt,
      options: { ...options, abortController }
    })) {
      // 捕获 session ID
      if (message.type === 'system' && message.subtype === 'init') {
        capturedSessionId = message.session_id;
        console.log(`[SDK] 会话 ID: ${capturedSessionId.slice(0, 8)}`);
      }

      // 格式化 assistant 消息
      if (message.type === 'assistant') {
        const formatted = formatAssistantMessage(message);
        if (formatted) {
          buffer.push(formatted);
          if (!debounceTimer) {
            debounceTimer = setTimeout(flush, DEBOUNCE_MS);
          }
        }
      }

      // 捕获最终结果
      if (message.type === 'result') {
        resultSubtype = message.subtype;
        if (message.subtype === 'success') {
          resultText = message.result || '';
        } else {
          resultErrors = message.errors || [];
          resultText = resultErrors.join('\n');
        }
        console.log(`[SDK] 结果: ${message.subtype}, 耗时 ${message.duration_ms}ms, 花费 $${message.total_cost_usd?.toFixed(4) || '?'}`);
      }
    }
  } catch (err) {
    clearTimeout(timeoutHandle);
    if (debounceTimer) clearTimeout(debounceTimer);
    flush();

    const isAbort = err.name === 'AbortError' || abortController.signal.aborted;
    console.error(`[SDK] ${isAbort ? '超时' : '错误'}: ${err.message}`);

    return {
      stdout: resultText || '',
      stderr: isAbort ? 'Timeout' : err.message,
      exitCode: isAbort ? -1 : 1,
      error: isAbort ? 'Timeout' : err.message,
      duration: Date.now() - startTime,
      metadata: capturedSessionId ? { sessionId: capturedSessionId } : undefined
    };
  }

  clearTimeout(timeoutHandle);
  if (debounceTimer) clearTimeout(debounceTimer);
  buffer = [];   // 清空残余，避免与 notifyCompletion 重复发送
  flush();

  const duration = Date.now() - startTime;

  // 更新会话池 + 映射表
  if (capturedSessionId) {
    liveSessions.set(capturedSessionId, {
      lastActivity: Date.now(),
      callbackChannel
    });
    // Task API sessionId → SDK session_id 映射
    if (sessionId && sessionId !== capturedSessionId) {
      sessionIdMap.set(sessionId, capturedSessionId);
      console.log(`[SDK] 映射: API:${sessionId.slice(0, 8)} → SDK:${capturedSessionId.slice(0, 8)}`);
    }
    ccSessions.add(capturedSessionId);
    saveSessions();
  }

  const isError = resultSubtype !== 'success';
  console.log(`[SDK] 完成，耗时 ${duration}ms，结果 ${resultText.length} 字符`);

  return {
    stdout: resultText,
    stderr: isError ? resultErrors.join('\n') : '',
    exitCode: isError ? 1 : 0,
    error: isError ? `SDK ${resultSubtype}` : null,
    duration,
    metadata: capturedSessionId ? { sessionId: capturedSessionId } : undefined
  };
}

// ========== Codex CLI 执行 ==========
function executeCodexCLI(prompt, timeout) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    console.log(`[Codex CLI] 执行: "${prompt.slice(0, 50)}..."`);

    const shellCmd = `/opt/homebrew/bin/codex exec --skip-git-repo-check --full-auto "${prompt.replace(/"/g, '\\"')}"`;

    const child = spawn('/bin/zsh', ['-l', '-c', shellCmd], {
      cwd: process.env.HOME,
      env: {
        ...process.env,
        PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:' + process.env.PATH,
        HOME: process.env.HOME
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    const effectiveTimeout = (timeout || CONFIG.defaultTimeout) + 30000;
    const timer = setTimeout(() => {
      child.kill();
      resolve({
        stdout, stderr: 'Timeout', exitCode: -1,
        error: 'Timeout', duration: Date.now() - startTime
      });
    }, effectiveTimeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      const duration = Date.now() - startTime;
      console.log(`[Codex CLI] 完成，耗时 ${duration}ms，输出 ${stdout.length} 字节`);
      resolve({
        stdout: stdout.trim(), stderr: stderr.trim(),
        exitCode: code || 0, error: code ? `Exit code ${code}` : null, duration
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout, stderr: err.message, exitCode: -1,
        error: err.message, duration: Date.now() - startTime
      });
    });
  });
}

// ========== Gemini CLI 执行 ==========
function executeGeminiCLI(prompt, timeout) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    console.log(`[Gemini CLI] 执行: "${prompt.slice(0, 50)}..."`);

    const shellCmd = `/opt/homebrew/bin/gemini -p "${prompt.replace(/"/g, '\\"')}" -o text --sandbox=false`;
    const child = spawn('/bin/zsh', ['-l', '-c', shellCmd], {
      cwd: process.env.HOME,
      env: {
        ...process.env,
        PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:' + process.env.PATH,
        HOME: process.env.HOME
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    const effectiveTimeout = (timeout || CONFIG.defaultTimeout) + 30000;
    const timer = setTimeout(() => {
      child.kill();
      resolve({
        stdout, stderr: 'Timeout', exitCode: -1,
        error: 'Timeout', duration: Date.now() - startTime
      });
    }, effectiveTimeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      const duration = Date.now() - startTime;
      console.log(`[Gemini CLI] 完成，耗时 ${duration}ms，输出 ${stdout.length} 字节`);
      resolve({
        stdout: stdout.trim(), stderr: stderr.trim(),
        exitCode: code || 0, error: code ? `Exit code ${code}` : null, duration
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout, stderr: err.message, exitCode: -1,
        error: err.message, duration: Date.now() - startTime
      });
    });
  });
}

// ========== CLI 回退执行（原有逻辑） ==========
const CLAUDE_PATH = '/opt/homebrew/bin/claude';
const CC_LOG = '/tmp/cc-live.log';

function executeClaudeCLI(prompt, timeout, sessionId, model) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const useModel = model || 'claude-opus-4-6';
    console.log(`[Claude CLI] 执行 [${useModel}]: "${prompt.slice(0, 50)}..."${sessionId ? ' [会话:' + sessionId.slice(0, 8) + ']' : ''}`);

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

    const shellCmd = `${CLAUDE_PATH} --print --model ${useModel}${sessionFlag} --dangerously-skip-permissions "${prompt.replace(/"/g, '\\"')}"`;
    console.log(`[Claude CLI] 命令: ${shellCmd}`);

    // 写入实时日志
    try { fs.appendFileSync(CC_LOG, `\n${'='.repeat(60)}\n[${new Date().toISOString()}] CC 开始: ${prompt.slice(0, 80)}...\n${'='.repeat(60)}\n`); } catch (e) {}
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
      const chunk = data.toString();
      stdout += chunk;
      try { fs.appendFileSync(CC_LOG, chunk); } catch (e) {}
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    const effectiveTimeout = (timeout || CONFIG.defaultTimeout) + 30000;
    const timer = setTimeout(() => {
      child.kill();
      resolve({
        stdout,
        stderr: 'Timeout',
        exitCode: -1,
        error: 'Timeout',
        duration: Date.now() - startTime
      });
    }, effectiveTimeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      const duration = Date.now() - startTime;
      console.log(`[Claude CLI] 完成，耗时 ${duration}ms，输出 ${stdout.length} 字节`);

      try { fs.appendFileSync(CC_LOG, `\n[${new Date().toISOString()}] CC 结束 (${duration}ms, exit ${code})\n`); } catch (e) {}

      const screenshotMatch = stdout.match(/PLEASE_UPLOAD_TO_DISCORD:\s*(.+\.png)/);
      const screenshotPath = screenshotMatch ? screenshotMatch[1].trim() : null;

      if (screenshotPath) {
        console.log(`[Claude CLI] 检测到截图: ${screenshotPath}`);
      }

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

// ========== 完成通知（最终结果推 Discord） ==========
const CLI_TASK_TYPES = new Set(['claude-cli', 'codex-cli', 'gemini-cli']);
const CLI_LABELS = { 'claude-cli': 'CC', 'codex-cli': 'Codex', 'gemini-cli': 'Gemini' };

function notifyCompletion(task, result) {
  if (!CLI_TASK_TYPES.has(task.type) || !task.callbackChannel) return;

  const label = CLI_LABELS[task.type] || task.type;
  const output = (result.stdout || '').slice(-1800) || '(无输出)';

  if (result.exitCode !== 0) {
    const duration = result.duration ? `${Math.round(result.duration / 1000)}s` : '未知';
    notifyDiscord(task.callbackChannel, task.sessionId, output, `❌ ${label} 失败（${duration}）`, task.callbackBotToken);
  } else {
    const message = output.length > 2000 ? output.slice(0, 1997) + '...' : output;
    discordPost(task.callbackChannel, message, task.callbackBotToken).then(({ status }) => {
      if (status >= 200 && status < 300) {
        console.log(`[回调] ${label} 输出已推送`);
      } else {
        console.error(`[回调] 推送失败 (${status})`);
      }
    }).catch(err => console.error(`[回调] 推送错误: ${err.message}`));
  }
}

// ========== 并发任务管理 ==========
let isRunning = true;
let consecutiveErrors = 0;
const runningTasks = new Set();

async function executeTask(task) {
  const taskId = task.id.slice(0, 8);

  try {
    let result;

    if (task.type === 'file-write') {
      console.log(`[${runningTasks.size}/${CONFIG.maxConcurrent}] [文件写入] ${taskId}... - ${task.path.trim()}`);
      result = await writeFileToDisk(task.path, task.content, task.encoding);
    } else if (task.type === 'file-read') {
      console.log(`[${runningTasks.size}/${CONFIG.maxConcurrent}] [文件读取] ${taskId}... - ${task.path}`);
      result = await readFileFromDisk(task.path);
    } else if (task.type === 'file-edit') {
      console.log(`[${runningTasks.size}/${CONFIG.maxConcurrent}] [文件编辑] ${taskId}... - ${task.path}`);
      result = await editFileOnDisk(task.path, task.oldString, task.newString, task.replaceAll);
    } else if (task.type === 'claude-cli') {
      // 短 ID 前缀解析（/cc-recent 显示 8 位，用户照抄后需要还原完整 UUID）
      if (task.sessionId) task.sessionId = resolveSessionPrefix(task.sessionId);
      console.log(`[${runningTasks.size}/${CONFIG.maxConcurrent}] [Claude ${sdkQuery ? 'SDK' : 'CLI'}] ${taskId}... - ${task.prompt?.slice(0, 50)}...`);
      // ack 已由 cc-bridge registerCommand 处理，worker 不再重复推
      // CC 模型 fallback：Opus → Sonnet → 不指定（用 CC 默认）
      const CC_MODELS = ['claude-opus-4-6', 'claude-sonnet-4-6'];
      for (let i = 0; i < CC_MODELS.length; i++) {
        const model = CC_MODELS[i];
        try {
          if (sdkQuery) {
            result = await executeClaudeSDK(task.prompt, task.timeout, task.sessionId, task.callbackChannel, model);
          } else {
            result = await executeClaudeCLI(task.prompt, task.timeout, task.sessionId, model);
          }
          // 成功或正常退出（exitCode 非 0 也算完成，不重试）
          break;
        } catch (err) {
          const isLast = i === CC_MODELS.length - 1;
          console.warn(`[CC Fallback] ${model} 失败: ${err.message}${isLast ? '' : '，降级 ' + CC_MODELS[i + 1]}`);
          if (isLast) throw err;
        }
      }
    } else if (task.type === 'codex-cli') {
      console.log(`[${runningTasks.size}/${CONFIG.maxConcurrent}] [Codex CLI] ${taskId}... - ${task.prompt?.slice(0, 50)}...`);
      result = await executeCodexCLI(task.prompt, task.timeout);
    } else if (task.type === 'gemini-cli') {
      console.log(`[${runningTasks.size}/${CONFIG.maxConcurrent}] [Gemini CLI] ${taskId}... - ${task.prompt?.slice(0, 50)}...`);
      result = await executeGeminiCLI(task.prompt, task.timeout);
    } else {
      console.log(`[${runningTasks.size}/${CONFIG.maxConcurrent}] [命令] ${taskId}... - ${task.command}`);
      result = await executeCommand(task.command, task.timeout);
    }

    // 上报结果
    await request('POST', '/worker/result', {
      taskId: task.id,
      ...result
    });

    // CC 任务完成后回调通知 Discord
    notifyCompletion(task, result);

    const status = result.exitCode === 0 ? '✓' : '✗';
    console.log(`[完成] ${status} ${taskId}... (剩余: ${runningTasks.size - 1})`);

  } catch (err) {
    console.error(`[错误] ${taskId}... - ${err.message}`);
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

// 主轮询循环
async function pollAndExecute() {
  while (isRunning) {
    try {
      if (runningTasks.size >= CONFIG.maxConcurrent) {
        await sleep(CONFIG.pollInterval);
        continue;
      }

      const pollRes = await request('GET', `/worker/poll?wait=${CONFIG.longPollWait}`);

      if (pollRes.status === 401) {
        console.error('[错误] Token 认证失败，请检查配置');
        await sleep(10000);
        continue;
      }

      const task = pollRes.data;
      consecutiveErrors = 0;

      if (!task) continue;

      runningTasks.add(task.id);
      executeTask(task);

      if (runningTasks.size < CONFIG.maxConcurrent) continue;

    } catch (err) {
      consecutiveErrors++;
      const waitTime = Math.min(consecutiveErrors * 5000, 60000);

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

// ========== 导出活跃会话列表（供外部查询） ==========
export function getActiveSessions() {
  return Array.from(liveSessions.entries()).map(([sessionId, s]) => ({
    sessionId,
    lastActivity: s.lastActivity,
    callbackChannel: s.callbackChannel
  }));
}

// ========== 优雅退出 ==========
process.on('SIGINT', () => {
  console.log('\n[退出] 收到 Ctrl+C，正在停止...');
  isRunning = false;
  saveSessions();
  setTimeout(() => process.exit(0), 1000);
});

process.on('SIGTERM', () => {
  console.log('\n[退出] 收到终止信号，正在停止...');
  isRunning = false;
  saveSessions();
  setTimeout(() => process.exit(0), 1000);
});

// ========== 启动 ==========
pollAndExecute().catch(console.error);
