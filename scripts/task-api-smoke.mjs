#!/usr/bin/env node

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import process from 'process';
import { setTimeout as delay } from 'timers/promises';

const port = 4571;
const token = '0123456789abcdef0123456789abcdef';
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
const eventDb = path.join(os.tmpdir(), `openclaw-runner-events-smoke-${suffix}.db`);
const taskDb = path.join(os.tmpdir(), `openclaw-runner-tasks-smoke-${suffix}.db`);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitForHealth(baseUrl) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // keep polling
    }
    await delay(250);
  }
  throw new Error('Task API did not become healthy in time');
}

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      WORKER_PORT: String(port),
      PORT: String(port),
      WORKER_TOKEN: token,
      WORKER_EVENT_DB: eventDb,
      WORKER_TASK_DB: taskDb,
      WORKER_EVENT_RETENTION_DAYS: '14',
      WORKER_MAX_EVENTS: '2000',
      WORKER_TASK_RETENTION_MS: '1200000',
      WORKER_RESULT_RETENTION_MS: '1800000',
      WORKER_SESSION_RETENTION_MS: '1800000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[task-api] ${chunk}`);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[task-api] ${chunk}`);
  });

  return child;
}

async function stopServer(child) {
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

async function api(pathname, init = {}) {
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
  if (!response.ok) {
    throw new Error(`${pathname} failed: ${response.status} ${raw}`);
  }
  return body;
}

async function main() {
  let child = startServer();
  try {
    await waitForHealth(`http://127.0.0.1:${port}`);

    const commandTask = await api('/tasks', {
      method: 'POST',
      body: JSON.stringify({ command: 'echo smoke', timeout: 30000 }),
    });
    const codexTask = await api('/codex', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'smoke session', callbackChannel: 'smoke-channel' }),
    });

    const queueBeforeRestart = await api('/tasks/stats');
    const sessionsBeforeRestart = await api('/sessions/stats');

    assert(queueBeforeRestart.queue.total >= 2, 'expected persisted pending tasks before restart');
    assert(sessionsBeforeRestart.sessions.active >= 1, 'expected active session before restart');

    await stopServer(child);

    child = startServer();
    await waitForHealth(`http://127.0.0.1:${port}`);

    const queueAfterRestart = await api('/tasks/stats');
    const sessionsAfterRestart = await api('/sessions/stats');
    const sessionState = await api('/sessions/state?limit=20');

    assert(queueAfterRestart.queue.total >= 2, 'expected tasks to survive restart');
    assert(sessionsAfterRestart.sessions.active >= 1, 'expected sessions to survive restart');
    assert(sessionState.sessions.some((session) => session.cliType === 'codex'), 'expected codex session in session state');

    const polled = await api('/worker/poll?wait=1000');
    assert(polled?.id === commandTask.taskId, 'expected oldest pending task to be claimed first');

    await api('/worker/result', {
      method: 'POST',
      body: JSON.stringify({
        taskId: polled.id,
        stdout: 'smoke\n',
        stderr: '',
        exitCode: 0,
      }),
    });

    const consumed = await api(`/tasks/${polled.id}?wait=10`);
    const eventStats = await api('/events/stats');
    const queueAfterConsume = await api('/tasks/stats');

    assert(consumed.stdout === 'smoke\n', 'expected consumed task result stdout');
    assert(eventStats.stats.count >= 3, 'expected event log to record smoke test lifecycle');
    assert(queueAfterConsume.queue.total >= 1, 'expected remaining task after consuming one result');

    console.log('Smoke test passed.');
  } finally {
    await stopServer(child);
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
