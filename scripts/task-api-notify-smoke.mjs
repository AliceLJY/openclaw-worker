#!/usr/bin/env node

import http from 'http';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import process from 'process';
import { setTimeout as delay } from 'timers/promises';

const port = 4572;
const mockPort = 4573;
const token = '0123456789abcdef0123456789abcdef';
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
const eventDb = path.join(os.tmpdir(), `openclaw-runner-events-notify-smoke-${suffix}.db`);
const taskDb = path.join(os.tmpdir(), `openclaw-runner-tasks-notify-smoke-${suffix}.db`);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitFor(url) {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // keep polling
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function startMockDiscord() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const body = rawBody ? JSON.parse(rawBody) : null;
    requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
    });

    if (req.url?.includes('/fail-channel/')) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'mock discord failure' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'mock-message-id' }));
  });

  return {
    requests,
    async listen() {
      await new Promise((resolve) => server.listen(mockPort, '127.0.0.1', resolve));
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function startTaskApi() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      WORKER_PORT: String(port),
      PORT: String(port),
      WORKER_TOKEN: token,
      WORKER_EVENT_DB: eventDb,
      WORKER_TASK_DB: taskDb,
      CALLBACK_BOT_TOKEN: 'mock-bot-token',
      CALLBACK_API_BASE_URL: `http://127.0.0.1:${mockPort}/api/v10`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => process.stdout.write(`[task-api] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[task-api] ${chunk}`));

  return child;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGINT');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function request(pathname, init = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...init,
    headers,
  });
  const raw = await response.text();
  const body = raw ? JSON.parse(raw) : null;
  return { status: response.status, body, raw };
}

async function main() {
  const mockDiscord = startMockDiscord();
  let child = null;
  try {
    await mockDiscord.listen();
    child = startTaskApi();
    await waitFor(`http://127.0.0.1:${port}/health`);

    const ok = await request('/notify', {
      method: 'POST',
      body: JSON.stringify({
        channel: 'ok-channel',
        message: 'hello from notify smoke',
      }),
    });
    assert(ok.status === 200, `expected notify success, got ${ok.status}`);
    assert(mockDiscord.requests.length >= 1, 'expected mock discord to receive success request');
    const successCall = mockDiscord.requests.at(-1);
    assert(successCall.method === 'POST', 'expected Discord request method to be POST');
    assert(successCall.url === '/api/v10/channels/ok-channel/messages', 'unexpected Discord success URL');
    assert(successCall.headers.authorization === 'Bot mock-bot-token', 'expected bot token header on success');
    assert(successCall.body?.content === 'hello from notify smoke', 'expected success payload content');

    const failed = await request('/notify', {
      method: 'POST',
      body: JSON.stringify({
        channel: 'fail-channel',
        message: 'this should fail upstream',
      }),
    });
    assert(failed.status === 502, `expected notify upstream failure to return 502, got ${failed.status}`);
    assert(/Callback API 500/.test(failed.body?.error || ''), 'expected upstream callback API failure details in response');

    console.log('Notify smoke test passed.');
  } finally {
    await stopChild(child);
    await mockDiscord.close();
    for (const file of [eventDb, taskDb]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
