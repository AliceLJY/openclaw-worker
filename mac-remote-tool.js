/**
 * OpenClaw 自定义 Tool：远程执行 Mac 命令
 *
 * 放到 OpenClaw 的 tools 目录下，或者通过配置加载
 * 文档: https://github.com/openclaw/openclaw/blob/main/docs/tools.md
 */

const http = require('http');
const https = require('https');

// ========== 配置 ==========
const WORKER_API = process.env.MAC_WORKER_URL || 'http://127.0.0.1:3456';
const WORKER_TOKEN = process.env.MAC_WORKER_TOKEN || 'change-me-to-a-secure-token';
const DEFAULT_TIMEOUT = 30000;
const POLL_WAIT = 35000; // 等待结果的时间

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
      // 1. 提交任务
      const createRes = await request('POST', '/tasks', {
        command,
        timeout: timeout || DEFAULT_TIMEOUT
      });

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

      // 3. 返回结果
      if (result.status === 'pending' || result.status === 'running') {
        return {
          error: 'Command execution timeout - Mac Worker may be offline',
          suggestion: 'Check if the worker is running on your Mac'
        };
      }

      // 格式化输出
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
