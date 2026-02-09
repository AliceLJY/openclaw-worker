#!/usr/bin/env node
/**
 * Mac Remote MCP Server
 * 通过 MCP 协议暴露远程 Mac 执行能力
 *
 * 启动: MAC_WORKER_URL=http://170.106.73.225:3456 MAC_WORKER_TOKEN=xxx node mcp-server.js
 */

const http = require('http');
const https = require('https');
const readline = require('readline');

// ========== 配置 ==========
const WORKER_API = process.env.MAC_WORKER_URL || 'http://170.106.73.225:3456';
const WORKER_TOKEN = process.env.MAC_WORKER_TOKEN || 'change-me-to-your-token';
const POLL_WAIT = 35000;

// ========== HTTP 请求 ==========
function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, WORKER_API);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Bearer ${WORKER_TOKEN}`,
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
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(POLL_WAIT + 5000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ========== 执行远程命令 ==========
async function executeRemoteCommand(command, timeout = 30000) {
  try {
    // 1. 提交任务
    const createRes = await request('POST', '/tasks', { command, timeout });
    if (createRes.status !== 200) {
      return { error: `Failed to create task: ${JSON.stringify(createRes.data)}` };
    }

    const { taskId } = createRes.data;

    // 2. 等待结果
    const resultRes = await request('GET', `/tasks/${taskId}?wait=${POLL_WAIT}`);
    if (resultRes.status === 404) {
      return { error: 'Task not found or expired' };
    }

    const result = resultRes.data;

    if (result.status === 'pending' || result.status === 'running') {
      return { error: 'Command execution timeout - Mac Worker may be offline' };
    }

    let output = '';
    if (result.stdout) output += result.stdout;
    if (result.stderr) output += (output ? '\n[stderr]\n' : '') + result.stderr;
    if (result.error) output += (output ? '\n[error]\n' : '') + result.error;

    return {
      exitCode: result.exitCode,
      output: output || '(no output)',
      success: result.exitCode === 0
    };
  } catch (err) {
    return { error: `Worker API error: ${err.message}` };
  }
}

// ========== MCP Protocol Handler ==========
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

function sendResponse(response) {
  process.stdout.write(JSON.stringify(response) + '\n');
}

rl.on('line', async (line) => {
  try {
    const message = JSON.parse(line);

    if (message.method === 'initialize') {
      sendResponse({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: 'mac-remote-mcp',
            version: '1.0.0'
          }
        }
      });
    }

    else if (message.method === 'notifications/initialized') {
      // No response needed for notifications
    }

    else if (message.method === 'tools/list') {
      sendResponse({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [{
            name: 'mac_remote',
            description: '在远程 Mac 电脑上执行 shell 命令。适用于文件操作、运行脚本、查看系统状态等。',
            inputSchema: {
              type: 'object',
              properties: {
                command: {
                  type: 'string',
                  description: '要执行的 shell 命令，例如 "ls -la ~/Desktop" 或 "docker ps"'
                },
                timeout: {
                  type: 'number',
                  description: '命令超时时间（毫秒），默认 30000'
                }
              },
              required: ['command']
            }
          }]
        }
      });
    }

    else if (message.method === 'tools/call') {
      const { name, arguments: args } = message.params;

      if (name === 'mac_remote') {
        const result = await executeRemoteCommand(args.command, args.timeout);

        sendResponse({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            content: [{
              type: 'text',
              text: result.error
                ? `Error: ${result.error}`
                : `Exit code: ${result.exitCode}\n${result.output}`
            }]
          }
        });
      } else {
        sendResponse({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32601,
            message: `Unknown tool: ${name}`
          }
        });
      }
    }

    else {
      sendResponse({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32601,
          message: `Method not found: ${message.method}`
        }
      });
    }
  } catch (err) {
    console.error('Error processing message:', err);
  }
});

process.stderr.write('Mac Remote MCP Server started\n');
