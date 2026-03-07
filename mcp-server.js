#!/usr/bin/env node
/**
 * Mac Remote MCP Server
 * 通过 MCP 协议暴露远程 Mac 执行能力
 *
 * 启动: MAC_WORKER_URL=http://170.106.73.225:3456 MAC_WORKER_TOKEN=xxx node mcp-server.js
 */

import readline from 'node:readline';
import workerClient from './worker-client.cjs';

// ========== 配置 ==========
const WORKER_API = process.env.MAC_WORKER_URL || 'http://170.106.73.225:3456';
const WORKER_TOKEN = process.env.MAC_WORKER_TOKEN || 'change-me-to-your-token';
const {
  DEFAULT_TIMEOUT,
  DEFAULT_POLL_WAIT,
  createWorkerRequest,
  normalizeCommand,
  parseTimeout,
  executeRemoteCommand: runRemoteCommand,
} = workerClient;
const POLL_WAIT = DEFAULT_POLL_WAIT;
const request = createWorkerRequest({ workerApi: WORKER_API, workerToken: WORKER_TOKEN, pollWait: POLL_WAIT });

// ========== 执行远程命令 ==========
async function executeRemoteCommand(command, timeout = 30000) {
  try {
    return await executeRemoteCommandShared(command, timeout);
  } catch (err) {
    return { error: `Worker API error: ${err.message}` };
  }
}

async function executeRemoteCommandShared(command, timeout = DEFAULT_TIMEOUT) {
  return runRemoteCommand(request, command, timeout, POLL_WAIT);
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

function sendResult(id, result) {
  sendResponse({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  sendResponse({ jsonrpc: '2.0', id, error: { code, message } });
}

rl.on('line', async (line) => {
  try {
    const message = JSON.parse(line);
    const messageId = Object.prototype.hasOwnProperty.call(message, 'id') ? message.id : null;

    if (message.method === 'initialize') {
      sendResult(messageId, {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: 'mac-remote-mcp',
          version: '1.0.0'
        }
      });
    }

    else if (message.method === 'notifications/initialized') {
      // No response needed for notifications
    }

    else if (message.method === 'tools/list') {
      sendResult(messageId, {
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
      });
    }

    else if (message.method === 'tools/call') {
      const params = message.params && typeof message.params === 'object' ? message.params : {};
      const { name, arguments: args = {} } = params;

      if (name !== 'mac_remote') {
        return sendError(messageId, -32601, `Unknown tool: ${name}`);
      }

      const command = normalizeCommand(args.command);
      if (!command) {
        return sendError(messageId, -32602, 'mac_remote requires a non-empty command');
      }

      const result = await executeRemoteCommand(command, parseTimeout(args.timeout));

      sendResult(messageId, {
        content: [{
          type: 'text',
          text: result.error
            ? `Error: ${result.error}`
            : `Exit code: ${result.exitCode}\n${result.output}`
        }]
      });
    }

    else {
      sendError(messageId, -32601, `Method not found: ${message.method}`);
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      sendError(null, -32700, 'Invalid JSON');
      return;
    }
    console.error('Error processing message:', err);
  }
});

process.stderr.write('Mac Remote MCP Server started\n');
