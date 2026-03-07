/**
 * OpenClaw 自定义 Tool：远程执行 Mac 命令
 *
 * 放到 OpenClaw 的 tools 目录下，或者通过配置加载
 * 文档: https://github.com/openclaw/openclaw/blob/main/docs/tools.md
 */

const {
  DEFAULT_TIMEOUT,
  DEFAULT_POLL_WAIT,
  createWorkerRequest,
  normalizeCommand,
  parseTimeout,
  executeRemoteCommand,
} = require('./worker-client.cjs');

// ========== 配置 ==========
const WORKER_API = process.env.MAC_WORKER_URL || 'http://127.0.0.1:3456';
const WORKER_TOKEN = process.env.MAC_WORKER_TOKEN || 'change-me-to-a-secure-token';
const POLL_WAIT = DEFAULT_POLL_WAIT; // 等待结果的时间
const request = createWorkerRequest({ workerApi: WORKER_API, workerToken: WORKER_TOKEN, pollWait: POLL_WAIT });

// ========== OpenClaw Tool 定义 ==========
module.exports = {
  name: 'mac_remote',
  description: '在远程 Mac 电脑上执行 shell 命令。适用于文件操作、运行脚本、查看系统状态等。',

  parameters: {
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
  },

  async execute({ command, timeout }) {
    try {
      return await executeRemoteCommand(request, normalizeCommand(command), parseTimeout(timeout, DEFAULT_TIMEOUT), POLL_WAIT);
    } catch (err) {
      return {
        error: `Worker API error: ${err.message}`,
        suggestion: 'Check if the task server is running'
      };
    }
  }
};

// ========== 独立测试 ==========
if (require.main === module) {
  (async () => {
    console.log('Testing mac_remote tool...');
    const result = await module.exports.execute({ command: 'echo "Hello from Mac!"' });
    console.log('Result:', JSON.stringify(result, null, 2));
  })();
}
