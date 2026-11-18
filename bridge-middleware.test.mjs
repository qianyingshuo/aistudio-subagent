import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  PortableBridgeQueue,
  createBridgeRouter,
  subagentBridgeVitePlugin,
} from './bridge-middleware.mjs';

function startTestServer(stateFilePath) {
  const queue = new PortableBridgeQueue(stateFilePath);
  const middleware = createBridgeRouter({ queue });
  const server = http.createServer((req, res) => {
    middleware(req, res, () => {
      res.statusCode = 404;
      res.end('not found');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        server,
        queue,
        baseUrl: `http://127.0.0.1:${addr.port}`,
      });
    });
  });
}

test('PortableBridgeQueue & createBridgeRouter support coroutine yield, callback, resume, and reset', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-bridge-'));
  const stateFile = path.join(tempDir, '.subagent-coroutine.json');
  const { server, queue, baseUrl } = await startTestServer(stateFile);

  try {
    // 1. Batch coroutine dispatch
    const dispatchRes = await fetch(`${baseUrl}/api/__bridge/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tasks: [
          { subagentName: 'W1', prompt: 'Task 1', autoCloseTab: true },
          { subagentName: 'W2', prompt: 'Task 2', autoCloseTab: true },
        ],
        resumeMaster: true,
        stepCheckpoint: '阶段1/2',
        nextAction: '汇总结果',
      }),
    });
    assert.equal(dispatchRes.status, 200);
    const dispatchJson = await dispatchRes.json();
    assert.equal(dispatchJson.ok, true);
    assert.equal(dispatchJson.tasks.length, 2);
    assert.equal(dispatchJson.coroutine.roundCount, 1);
    assert.equal(dispatchJson.coroutine.totalSubagentCalls, 2);
    assert.equal(dispatchJson.coroutine.awaitingResume, true);
    assert.equal(dispatchJson.coroutine.currentCheckpoint, '阶段1/2');

    // 2. Callback completes first task
    const t1 = dispatchJson.tasks[0];
    const cbRes = await fetch(`${baseUrl}/api/__bridge/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId: t1.id,
        status: 'completed',
        tabId: 888,
        result: 'OK-1',
      }),
    });
    assert.equal(cbRes.status, 200);

    // 3. Resume confirmation clears awaitingResume
    const resumedRes = await fetch(`${baseUrl}/api/__bridge/coroutine/resumed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchId: t1.batchId, ok: true }),
    });
    const resumedJson = await resumedRes.json();
    assert.equal(resumedJson.coroutine.awaitingResume, false);
    assert.equal(resumedJson.coroutine.totalSubagentCalls, 2);

    // 4. Persisted file exists and reloads properly
    const reloadedQueue = new PortableBridgeQueue(stateFile);
    assert.equal(reloadedQueue.getCoroutineState().totalSubagentCalls, 2);
    assert.equal(reloadedQueue.getCoroutineState().roundCount, 1);

    // 5. Reset clears counts
    const resetRes = await fetch(`${baseUrl}/api/__bridge/coroutine/reset`, {
      method: 'POST',
    });
    const resetJson = await resetRes.json();
    assert.equal(resetJson.coroutine.roundCount, 0);
    assert.equal(resetJson.coroutine.totalSubagentCalls, 0);
  } finally {
    queue.clearTasks();
    await new Promise((r) => server.close(r));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('subagentBridgeVitePlugin configures serve-only middleware without touching non-bridge routes', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-vite-'));
  const stateFile = path.join(tempDir, '.subagent-coroutine.json');
  const plugin = subagentBridgeVitePlugin({ stateFilePath: stateFile });

  assert.equal(plugin.apply, 'serve');
  assert.equal(typeof plugin.configureServer, 'function');

  let registeredMiddleware = null;
  plugin.configureServer({
    middlewares: {
      use(fn) {
        registeredMiddleware = fn;
      },
    },
  });
  assert.equal(typeof registeredMiddleware, 'function');

  let passedThrough = false;
  await registeredMiddleware(
    { method: 'GET', url: '/index.html' },
    {},
    () => {
      passedThrough = true;
    }
  );
  assert.equal(passedThrough, true);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('createBridgeRouter validates incomplete taskSpec and persists masterMemory across reload', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-contract-'));
  const stateFile = path.join(tempDir, '.subagent-coroutine.json');
  const { server, queue, baseUrl } = await startTestServer(stateFile);

  try {
    const badRes = await fetch(`${baseUrl}/api/__bridge/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'spawn',
        coroutine: true,
        resumeMaster: true,
        taskSpec: {
          problem: '只有问题，缺其他三项',
        },
      }),
    });
    assert.equal(badRes.status, 400);

    const okRes = await fetch(`${baseUrl}/api/__bridge/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'spawn',
        subagentName: '契约测试员',
        coroutine: true,
        resumeMaster: true,
        stepCheckpoint: '阶段1',
        nextAction: '核对记忆',
        masterMemory: '挂起自留记忆：重点关注 bridge-middleware.mjs 第 530 行',
        memoryPosition: 'after',
        taskSpec: {
          problem: '偶发状态不同步',
          intension: '只读检查 SSE 广播',
          extension: '可能关联 client 重连，但不涉及 UI',
          nonGoals: '禁止改代码',
          forbiddenPaths: 'server.ts, src/',
          writablePaths: '只读分析',
        },
      }),
    });
    assert.equal(okRes.status, 200);
    const okJson = await okRes.json();
    assert.match(okJson.task.prompt, /【4\. 非目标与修改红线（严格禁止）】/);
    assert.equal(
      okJson.task.masterMemory,
      '挂起自留记忆：重点关注 bridge-middleware.mjs 第 530 行'
    );
    assert.equal(
      okJson.coroutine.masterMemory,
      '挂起自留记忆：重点关注 bridge-middleware.mjs 第 530 行'
    );

    const reloaded = new PortableBridgeQueue(stateFile);
    assert.equal(
      reloaded.getCoroutineState().masterMemory,
      '挂起自留记忆：重点关注 bridge-middleware.mjs 第 530 行'
    );
  } finally {
    queue.clearTasks();
    await new Promise((r) => server.close(r));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('subagent.mjs parseCoroutineArgs enforces 4 contract fields and parses masterMemory', async () => {
  const { parseCoroutineArgs } = await import('./subagent.mjs');
  const { parseCoroutineArgs: parseRootArgs } = await import('../scripts/subagent.mjs');

  for (const parser of [parseCoroutineArgs, parseRootArgs]) {
    const missing = parser(['--name=测试员', '一段裸提示词']);
    assert.equal(missing.ok, false);
    assert.equal(missing.errors.length, 4);

    const validSingle = parser([
      '--name=审计员',
      '--step=阶段1/2',
      '--next=继续修复',
      '--problem=接口偶发超时',
      '--intension=只读检查数据库查询',
      '--extension=可能涉及连接池配置，不涉及前端',
      '--non-goals=禁止修改任何代码',
      '--forbidden=server.ts,src/bridge/',
      '--writable=只读分析',
      '--memory=主 Agent 备忘：唤醒后对比连接数上限',
      '--memory-pos=before',
      '--close',
    ]);
    assert.equal(validSingle.ok, true);
    assert.equal(validSingle.mode, 'single');
    assert.equal(validSingle.masterMemory, '主 Agent 备忘：唤醒后对比连接数上限');
    assert.equal(validSingle.memoryPosition, 'before');
    assert.match(validSingle.prompt, /禁止修改目录\/文件：server\.ts,src\/bridge\//);

    const validBatch = parser([
      '--problem=前后端字段核对',
      '--extension=可能涉及 API DTO',
      '--non-goals=只读核对，不改文件',
      '--memory=批处理备忘',
      '--task=后端::检查 server.ts 返回结构',
      '--task=前端::检查 App.tsx 字段消费',
    ]);
    assert.equal(validBatch.ok, true);
    assert.equal(validBatch.mode, 'batch');
    assert.equal(validBatch.batchTasks.length, 2);
    assert.equal(validBatch.batchTasks[0].subagentName, '后端');
    assert.match(validBatch.batchTasks[1].prompt, /检查 App\.tsx 字段消费/);
  }
});

