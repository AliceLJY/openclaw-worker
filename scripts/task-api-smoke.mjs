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

function step(label) {
  console.log(`\n[smoke] ${label}`);
}

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
  const response = await request(pathname, init);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${pathname} failed: ${response.status} ${response.raw}`);
  }
  return response.body;
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
  return { status: response.status, raw, body };
}

function countByStatus(queueStats, status) {
  return Number(queueStats?.queue?.byStatus?.[status] || 0);
}

function eventTypes(events) {
  return new Set((events || []).map((event) => event.type));
}

function assertHasEventTypes(events, expectedTypes, messagePrefix) {
  const types = eventTypes(events);
  for (const expectedType of expectedTypes) {
    assert(types.has(expectedType), `${messagePrefix}: missing event type ${expectedType}`);
  }
}

async function main() {
  let child = startServer();
  try {
    await waitForHealth(`http://127.0.0.1:${port}`);

    step('Create pending tasks and verify they survive restart');
    const commandTask = await api('/tasks', {
      method: 'POST',
      body: JSON.stringify({ command: 'echo smoke', timeout: 30000 }),
    });
    const codexClientSessionId = `codex-client-${suffix}`;
    const codexTask = await api('/codex', {
      method: 'POST',
      body: JSON.stringify({
        prompt: 'smoke session',
        sessionId: codexClientSessionId,
        callbackChannel: 'smoke-channel',
      }),
    });

    const queueBeforeRestart = await api('/tasks/stats');
    const sessionsBeforeRestart = await api('/sessions/stats');
    const initialSessionState = await api('/sessions/state?limit=20');

    assert(queueBeforeRestart.queue.total >= 2, 'expected persisted pending tasks before restart');
    assert(countByStatus(queueBeforeRestart, 'pending') >= 2, 'expected pending tasks before restart');
    assert(sessionsBeforeRestart.sessions.active >= 1, 'expected active session before restart');
    assert(
      initialSessionState.sessions.some((session) => session.sessionId === codexClientSessionId && session.cliType === 'codex'),
      'expected initial codex session to be tracked before restart',
    );

    await stopServer(child);

    child = startServer();
    await waitForHealth(`http://127.0.0.1:${port}`);

    const queueAfterRestart = await api('/tasks/stats');
    const sessionsAfterRestart = await api('/sessions/stats');
    const sessionState = await api('/sessions/state?limit=20');

    assert(queueAfterRestart.queue.total >= 2, 'expected tasks to survive restart');
    assert(countByStatus(queueAfterRestart, 'pending') >= 2, 'expected pending tasks to survive restart');
    assert(sessionsAfterRestart.sessions.active >= 1, 'expected sessions to survive restart');
    assert(
      sessionState.sessions.some((session) => session.sessionId === codexClientSessionId && session.cliType === 'codex'),
      'expected codex session in session state after restart',
    );

    step('Verify running task is requeued to pending after restart');
    const firstClaim = await api('/worker/poll?wait=1000');
    assert(firstClaim?.id === commandTask.taskId, 'expected oldest pending task to be claimed first');

    const runningBeforeRestart = await api('/tasks/stats');
    assert(countByStatus(runningBeforeRestart, 'running') >= 1, 'expected claimed task to move to running');

    await stopServer(child);
    child = startServer();
    await waitForHealth(`http://127.0.0.1:${port}`);

    const requeuedStats = await api('/tasks/stats');
    assert(countByStatus(requeuedStats, 'running') === 0, 'expected stale running tasks to be reset on restart');
    assert(countByStatus(requeuedStats, 'pending') >= 2, 'expected requeued task to return to pending state');

    const reclaimed = await api('/worker/poll?wait=1000');
    assert(reclaimed?.id === commandTask.taskId, 'expected stale running task to be reclaimed after restart');

    await api('/worker/result', {
      method: 'POST',
      body: JSON.stringify({
        taskId: reclaimed.id,
        stdout: 'smoke\n',
        stderr: '',
        exitCode: 0,
      }),
    });

    const consumed = await api(`/tasks/${reclaimed.id}?wait=10`);
    const commandEvents = await api(`/events?taskId=${reclaimed.id}&limit=20`);

    assert(consumed.stdout === 'smoke\n', 'expected consumed task result stdout');
    assertHasEventTypes(
      commandEvents.events,
      ['task.created', 'task.started', 'task.completed', 'task.reconciled'],
      'expected success task lifecycle events',
    );

    step('Verify failed result path persists metadata and events');
    const providerCodexSessionId = `codex-provider-${suffix}`;
    const codexClaim = await api('/worker/poll?wait=1000');
    assert(codexClaim?.id === codexTask.taskId, 'expected codex task to be claimable after command task completes');

    await api('/worker/result', {
      method: 'POST',
      body: JSON.stringify({
        taskId: codexClaim.id,
        stdout: '',
        stderr: 'codex boom\n',
        exitCode: 17,
        error: 'codex failed',
        metadata: {
          sessionId: providerCodexSessionId,
        },
      }),
    });

    const failedResult = await api(`/tasks/${codexClaim.id}?wait=10`);
    assert(failedResult.exitCode === 17, 'expected failed task exit code to round-trip');
    assert(failedResult.error === 'codex failed', 'expected failed task error to round-trip');
    assert(failedResult.metadata?.sessionId === providerCodexSessionId, 'expected provider session metadata to persist');

    const missingTask = await request(`/tasks/${codexClaim.id}?wait=0`);
    assert(missingTask.status === 404, 'expected consumed task to be removed from task store');

    const codexEvents = await api(`/events?taskId=${codexClaim.id}&limit=20`);
    const codexSessions = await api('/sessions/state?cliType=codex&limit=20');

    assertHasEventTypes(
      codexEvents.events,
      ['task.created', 'task.started', 'task.failed', 'task.reconciled'],
      'expected failed task lifecycle events',
    );
    assert(
      codexSessions.sessions.some((session) => session.sessionId === codexClientSessionId),
      'expected task-api session id to remain visible in active codex sessions',
    );
    assert(
      codexSessions.sessions.some(
        (session) => session.sessionId === providerCodexSessionId && session.callbackChannel === 'smoke-channel',
      ),
      'expected provider session id to be tracked with callback channel after result reporting',
    );

    step('Verify tasks sharing a session are serialized');
    const serializedSessionId = `serial-${suffix}`;
    const serialTaskA = await api('/codex', {
      method: 'POST',
      body: JSON.stringify({
        prompt: 'serial task A',
        sessionId: serializedSessionId,
        callbackChannel: 'serial-channel',
      }),
    });
    const serialTaskB = await api('/codex', {
      method: 'POST',
      body: JSON.stringify({
        prompt: 'serial task B',
        sessionId: serializedSessionId,
        callbackChannel: 'serial-channel',
      }),
    });

    const sessionsDuringSerial = await api('/sessions/state?cliType=codex&limit=50');
    const serializedSession = sessionsDuringSerial.sessions.find((session) => session.sessionId === serializedSessionId);
    assert(serializedSession, 'expected serialized codex session to be tracked');
    assert(serializedSession.taskCount >= 2, 'expected serialized session task count to reflect both queued tasks');

    const serialClaimA = await api('/worker/poll?wait=1000');
    assert(serialClaimA?.id === serialTaskA.taskId, 'expected first shared-session task to be claimed first');

    const blockedPoll = await api('/worker/poll?wait=1000');
    assert(blockedPoll === null, 'expected second shared-session task to stay blocked while sibling is running');

    await api('/worker/result', {
      method: 'POST',
      body: JSON.stringify({
        taskId: serialClaimA.id,
        stdout: 'serial-a\n',
        stderr: '',
        exitCode: 0,
        metadata: {
          sessionId: serializedSessionId,
        },
      }),
    });
    const serialResultA = await api(`/tasks/${serialClaimA.id}?wait=10`);
    assert(serialResultA.stdout === 'serial-a\n', 'expected first serialized task result to be readable');

    const serialClaimB = await api('/worker/poll?wait=1000');
    assert(serialClaimB?.id === serialTaskB.taskId, 'expected second shared-session task to unblock after first completes');

    await api('/worker/result', {
      method: 'POST',
      body: JSON.stringify({
        taskId: serialClaimB.id,
        stdout: 'serial-b\n',
        stderr: '',
        exitCode: 0,
        metadata: {
          sessionId: serializedSessionId,
        },
      }),
    });
    const serialResultB = await api(`/tasks/${serialClaimB.id}?wait=10`);
    assert(serialResultB.stdout === 'serial-b\n', 'expected second serialized task result to be readable');

    const finalQueue = await api('/tasks/stats');
    const finalEvents = await api('/events/stats');
    assert(finalQueue.queue.total === 0, 'expected smoke test to consume all tasks');
    assert(finalQueue.queue.unconsumedResults === 0, 'expected smoke test to leave no unconsumed results');
    assert(finalEvents.stats.count >= 10, 'expected event log to record extended smoke lifecycle');

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
