const http = require('http');
const https = require('https');

const DEFAULT_TIMEOUT = 30000;
const DEFAULT_POLL_WAIT = 35000;

function normalizeCommand(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseTimeout(value, fallback = DEFAULT_TIMEOUT) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function createWorkerRequest({ workerApi, workerToken, pollWait = DEFAULT_POLL_WAIT }) {
  return function request(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, workerApi);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          'Authorization': `Bearer ${workerToken}`,
          'Content-Type': 'application/json',
        },
      };

      const req = lib.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(data || 'null') });
          } catch {
            resolve({ status: res.statusCode, data });
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(pollWait + 5000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  };
}

async function executeRemoteCommand(request, command, timeout = DEFAULT_TIMEOUT, pollWait = DEFAULT_POLL_WAIT) {
  const normalizedCommand = normalizeCommand(command);
  if (!normalizedCommand) {
    return { error: 'Command is required' };
  }

  const createRes = await request('POST', '/tasks', {
    command: normalizedCommand,
    timeout: parseTimeout(timeout),
  });
  if (createRes.status !== 200) {
    return { error: `Failed to create task: ${JSON.stringify(createRes.data)}` };
  }

  const taskId = isObject(createRes.data) && typeof createRes.data.taskId === 'string'
    ? createRes.data.taskId
    : '';
  if (!taskId) {
    return { error: `Task API returned no taskId: ${JSON.stringify(createRes.data)}` };
  }
  const resultRes = await request('GET', `/tasks/${taskId}?wait=${pollWait}`);
  if (resultRes.status === 404) {
    return { error: 'Task not found or expired' };
  }

  const result = isObject(resultRes.data) ? resultRes.data : {};
  if (result.status === 'pending' || result.status === 'running') {
    return {
      error: 'Command execution timeout - Mac Worker may be offline',
      suggestion: 'Check if the worker is running on your Mac',
    };
  }

  let output = '';
  if (result.stdout) output += result.stdout;
  if (result.stderr) output += (output ? '\n[stderr]\n' : '') + result.stderr;
  if (result.error) output += (output ? '\n[error]\n' : '') + result.error;

  return {
    exitCode: result.exitCode,
    output: output || '(no output)',
    success: result.exitCode === 0,
  };
}

module.exports = {
  DEFAULT_TIMEOUT,
  DEFAULT_POLL_WAIT,
  createWorkerRequest,
  normalizeCommand,
  parseTimeout,
  executeRemoteCommand,
};
