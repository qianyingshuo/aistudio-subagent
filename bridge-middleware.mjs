/**
 * AI Studio Subagent Bridge — 零依赖无面板可迁移中间件 (v4.1.0)
 *
 * 特点：
 * - 纯原生 Node.js ESM (.mjs)，零第三方 npm 依赖。
 * - 同时兼容：
 *   1) 纯前端 Vite 项目：在 vite.config.ts 中使用 subagentBridgeVitePlugin()（仅 dev 生效，不进生产包）
 *   2) Express / Node HTTP 项目：app.use(createBridgeRouter())
 * - 持久化保存协程批次、累计 Subagent 调用次数与当前位置锚点到 .subagent-coroutine.json
 */

import fs from 'node:fs';
import path from 'node:path';

export function normalizeTaskContractSpec(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const problem = typeof raw.problem === 'string' ? raw.problem.trim() : '';
  const intension = typeof raw.intension === 'string' ? raw.intension.trim() : '';
  const extension = typeof raw.extension === 'string' ? raw.extension.trim() : '';
  const nonGoals = typeof raw.nonGoals === 'string' ? raw.nonGoals.trim() : '';
  const forbiddenPaths =
    typeof raw.forbiddenPaths === 'string' && raw.forbiddenPaths.trim()
      ? raw.forbiddenPaths.trim()
      : undefined;
  const writablePaths =
    typeof raw.writablePaths === 'string' && raw.writablePaths.trim()
      ? raw.writablePaths.trim()
      : undefined;

  if (!problem && !intension && !extension && !nonGoals && !forbiddenPaths && !writablePaths) {
    return undefined;
  }

  return {
    problem,
    intension,
    extension,
    nonGoals,
    forbiddenPaths,
    writablePaths,
  };
}

export function validateTaskContract(spec) {
  const labels = {
    problem: '问题描述 (--problem)',
    intension: '任务内涵 (--intension)',
    extension: '任务外延 (--extension)',
    nonGoals: '非目标 (--non-goals)',
  };
  const missingFields = [];
  const errors = [];
  for (const key of ['problem', 'intension', 'extension', 'nonGoals']) {
    const val = spec && typeof spec[key] === 'string' ? spec[key].trim() : '';
    if (!val) {
      missingFields.push(key);
      errors.push(`缺少必填定义：${labels[key]}`);
    }
  }
  return { valid: missingFields.length === 0, missingFields, errors };
}

export function formatTaskContractPrompt(spec, extraPrompt) {
  const lines = [
    '=== Subagent 任务契约（严格边界约束） ===',
    '【1. 问题描述】',
    spec.problem.trim(),
    '',
    '【2. 任务内涵（核心必做目标）】',
    spec.intension.trim(),
    '',
    '【3. 任务外延（可能涉及的关联模块）】',
    spec.extension.trim(),
    '',
    '【4. 非目标与修改红线（严格禁止）】',
    `- 非目标范围：${spec.nonGoals.trim()}`,
    `- 禁止修改目录/文件：${
      spec.forbiddenPaths?.trim() || '除下方明确允许范围外，其余所有目录与文件一律禁止修改'
    }`,
    `- 允许修改目录/文件：${
      spec.writablePaths?.trim() || '只读分析（禁止修改、删除或新建任何代码文件）'
    }`,
  ];
  if (extraPrompt && extraPrompt.trim()) {
    lines.push('', '【补充执行说明】', extraPrompt.trim());
  }
  lines.push(
    '',
    '⚠️ 执行铁律：严禁越界修改非目标或禁止目录中的文件；严禁在子会话中递归调用 subagent.mjs；仅围绕任务内涵交付精准结果。'
  );
  return lines.join('\n');
}

function createEmptyCoroutineState() {
  return {
    roundCount: 0,
    totalSubagentCalls: 0,
    activeBatchId: null,
    lastSealedBatchId: null,
    currentCheckpoint: '',
    nextAction: '',
    masterMemory: '',
    memoryPosition: 'after',
    awaitingResume: false,
    calls: [],
  };
}

export class PortableBridgeQueue {
  constructor(stateFilePath) {
    this.stateFilePath =
      stateFilePath || path.resolve(process.cwd(), '.subagent-coroutine.json');
    this.tasks = new Map();
    this.resolvers = new Map();
    this.timers = new Map();
    this.listeners = new Set();
    this.counter = 0;
    this.coroutineState = createEmptyCoroutineState();
    this.loadPersistedCoroutineState();
  }

  loadPersistedCoroutineState() {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const raw = fs.readFileSync(this.stateFilePath, 'utf-8');
        const saved = JSON.parse(raw);
        if (saved && typeof saved === 'object') {
          this.coroutineState = {
            roundCount: typeof saved.roundCount === 'number' ? saved.roundCount : 0,
            totalSubagentCalls:
              typeof saved.totalSubagentCalls === 'number' ? saved.totalSubagentCalls : 0,
            activeBatchId:
              typeof saved.activeBatchId === 'string' ? saved.activeBatchId : null,
            lastSealedBatchId:
              typeof saved.lastSealedBatchId === 'string' ? saved.lastSealedBatchId : null,
            currentCheckpoint:
              typeof saved.currentCheckpoint === 'string' ? saved.currentCheckpoint : '',
            nextAction: typeof saved.nextAction === 'string' ? saved.nextAction : '',
            masterMemory: typeof saved.masterMemory === 'string' ? saved.masterMemory : '',
            memoryPosition: saved.memoryPosition === 'before' ? 'before' : 'after',
            awaitingResume: Boolean(saved.awaitingResume),
            lastResumedAt:
              typeof saved.lastResumedAt === 'number' ? saved.lastResumedAt : undefined,
            calls: Array.isArray(saved.calls)
              ? saved.calls.slice(-100).map((c) => ({ ...c }))
              : [],
          };
        }
      }
    } catch {
      // ignore corrupt state file
    }
  }

  savePersistedCoroutineState() {
    try {
      fs.writeFileSync(
        this.stateFilePath,
        JSON.stringify(this.getCoroutineState(), null, 2),
        'utf-8'
      );
    } catch {
      // ignore write error
    }
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(type, task) {
    this.savePersistedCoroutineState();
    const coroutineSnapshot = this.getCoroutineState();
    for (const listener of this.listeners) {
      listener({
        type,
        task: task ? { ...task } : undefined,
        coroutine: coroutineSnapshot,
      });
    }
  }

  getCoroutineState() {
    return {
      ...this.coroutineState,
      calls: this.coroutineState.calls.map((c) => ({ ...c })),
    };
  }

  markCoroutineResumed(batchId) {
    this.coroutineState.awaitingResume = false;
    this.coroutineState.lastResumedAt = Date.now();
    if (batchId && this.coroutineState.activeBatchId === batchId) {
      this.coroutineState.lastSealedBatchId = batchId;
      this.coroutineState.activeBatchId = null;
    }
    this.emit('coroutine_updated');
    return this.getCoroutineState();
  }

  resetCoroutine() {
    this.coroutineState = createEmptyCoroutineState();
    this.emit('coroutine_updated');
    return this.getCoroutineState();
  }

  dispatchTask(params) {
    this.counter += 1;
    const id = `task_${Date.now()}_${this.counter}`;
    const subagentId = params.targetSubagentId || `subagent_${this.counter}`;
    const action = params.action || 'spawn';
    const isCoroutine = Boolean(params.coroutine && action === 'spawn');
    const taskSpec = normalizeTaskContractSpec(params.taskSpec);
    const rawPrompt = typeof params.prompt === 'string' ? params.prompt.trim() : '';
    const finalPrompt =
      rawPrompt || (taskSpec ? formatTaskContractPrompt(taskSpec) : '');

    let batchId = params.batchId;
    let coroutineRound;
    let callIndex;
    let totalSubagentCalls;

    const stepCheckpoint =
      typeof params.stepCheckpoint === 'string' && params.stepCheckpoint.trim()
        ? params.stepCheckpoint.trim()
        : undefined;
    const nextAction =
      typeof params.nextAction === 'string' && params.nextAction.trim()
        ? params.nextAction.trim()
        : undefined;
    const rawMasterMemory =
      typeof params.masterMemory === 'string' && params.masterMemory.trim()
        ? params.masterMemory.trim()
        : undefined;
    const memoryPosition = params.memoryPosition === 'before' ? 'before' : 'after';

    if (isCoroutine) {
      this.coroutineState.totalSubagentCalls += 1;
      callIndex = this.coroutineState.totalSubagentCalls;
      totalSubagentCalls = this.coroutineState.totalSubagentCalls;

      if (!this.coroutineState.activeBatchId) {
        this.coroutineState.roundCount += 1;
        this.coroutineState.activeBatchId =
          batchId || `batch_${this.coroutineState.roundCount}`;
        this.coroutineState.masterMemory = '';
        this.coroutineState.memoryPosition = memoryPosition;
      }
      batchId = this.coroutineState.activeBatchId;
      coroutineRound = this.coroutineState.roundCount;

      if (stepCheckpoint) {
        this.coroutineState.currentCheckpoint = stepCheckpoint;
      }
      if (nextAction) {
        this.coroutineState.nextAction = nextAction;
      }
      if (rawMasterMemory) {
        if (
          this.coroutineState.masterMemory &&
          !this.coroutineState.masterMemory.includes(rawMasterMemory)
        ) {
          this.coroutineState.masterMemory = `${this.coroutineState.masterMemory}\n\n${rawMasterMemory}`;
        } else {
          this.coroutineState.masterMemory = rawMasterMemory;
        }
      }
      if (params.memoryPosition === 'before' || params.memoryPosition === 'after') {
        this.coroutineState.memoryPosition = params.memoryPosition;
      }
    }

    const effectiveMasterMemory = isCoroutine
      ? params.resumeMaster
        ? this.coroutineState.masterMemory || rawMasterMemory
        : rawMasterMemory
      : rawMasterMemory;
    const effectiveMemoryPosition = isCoroutine
      ? this.coroutineState.memoryPosition
      : rawMasterMemory
      ? memoryPosition
      : undefined;

    const subagentName =
      (typeof params.subagentName === 'string' && params.subagentName.trim()) ||
      (action === 'close_tab'
        ? 'Tab 清理指令'
        : isCoroutine
        ? `Worker-${callIndex}`
        : `Subagent #${this.counter}`);

    const timeoutMs =
      params.timeoutMs ||
      (action === 'spawn' ? 360000 : action === 'close_tab' ? 15000 : 60000);

    const task = {
      id,
      subagentId,
      subagentName,
      action,
      prompt: finalPrompt,
      taskSpec,
      activeTab: Boolean(params.activeTab),
      autoCloseTab: Boolean(params.autoCloseTab),
      targetTabId: params.targetTabId,
      targetSubagentId: params.targetSubagentId,
      tabClosed: false,
      createdAt: Date.now(),
      status: 'pending',
      progress:
        action === 'close_tab'
          ? '等待 Chrome 插件关闭目标标签页...'
          : isCoroutine
          ? `协程入队 (批次 #${coroutineRound} · 第 ${callIndex} 次调用)，等待主 Agent 停稳...`
          : '等待 Chrome 插件接单...',
      coroutine: isCoroutine || undefined,
      batchId,
      coroutineRound,
      callIndex,
      totalSubagentCalls,
      resumeMaster: isCoroutine ? Boolean(params.resumeMaster) : undefined,
      stepCheckpoint:
        stepCheckpoint ||
        (isCoroutine ? this.coroutineState.currentCheckpoint || undefined : undefined),
      nextAction:
        nextAction ||
        (isCoroutine ? this.coroutineState.nextAction || undefined : undefined),
      masterMemory: effectiveMasterMemory || undefined,
      memoryPosition: effectiveMasterMemory ? effectiveMemoryPosition : undefined,
    };

    if (
      isCoroutine &&
      batchId &&
      typeof callIndex === 'number' &&
      typeof coroutineRound === 'number'
    ) {
      this.coroutineState.calls.push({
        callIndex,
        batchId,
        coroutineRound,
        taskId: id,
        subagentId,
        subagentName,
        promptSummary: finalPrompt.replace(/\s+/g, ' ').slice(0, 140),
        taskSpec,
        stepCheckpoint: task.stepCheckpoint,
        nextAction: task.nextAction,
        masterMemory: rawMasterMemory,
        memoryPosition: rawMasterMemory ? memoryPosition : undefined,
        status: 'pending',
        createdAt: task.createdAt,
      });
      if (this.coroutineState.calls.length > 100) {
        this.coroutineState.calls.shift();
      }
      if (params.resumeMaster) {
        this.coroutineState.awaitingResume = true;
        this.coroutineState.lastSealedBatchId = batchId;
        this.coroutineState.activeBatchId = null;
      }
    }

    this.tasks.set(id, task);

    const waitPromise = new Promise((resolve) => {
      this.resolvers.set(id, resolve);
      if (!isCoroutine && timeoutMs > 0) {
        const timer = setTimeout(() => {
          const current = this.tasks.get(id);
          if (current && (current.status === 'pending' || current.status === 'processing')) {
            current.status = 'timeout';
            current.completedAt = Date.now();
            current.result = `等待 Subagent 响应超时 (${Math.round(timeoutMs / 1000)}s)。请确认 Chrome 插件已启用。`;
            this.syncCoroutineCall(current);
            this.tasks.set(id, current);
            this.resolvers.delete(id);
            this.timers.delete(id);
            this.emit('task_updated', current);
            resolve({ ...current });
          }
        }, timeoutMs);
        this.timers.set(id, timer);
      }
    });

    this.emit('task_created', task);
    return { task: { ...task }, waitPromise };
  }

  syncCoroutineCall(task) {
    if (!task.coroutine) return;
    const record = this.coroutineState.calls.find((c) => c.taskId === task.id);
    if (!record) return;
    record.status = task.status;
    if (typeof task.tabId === 'number') record.tabId = task.tabId;
    if (task.completedAt) record.completedAt = task.completedAt;
    if (task.result) {
      record.resultSummary = String(task.result).replace(/\s+/g, ' ').slice(0, 180);
    }
  }

  markProcessing(taskId, info) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    if (task.status === 'pending' || task.status === 'processing') {
      task.status = 'processing';
      if (info?.source) task.source = info.source;
      if (info?.progress) task.progress = info.progress;
      if (typeof info?.tabId === 'number') task.tabId = info.tabId;
      this.syncCoroutineCall(task);
      this.tasks.set(taskId, task);
      this.emit('task_updated', task);
    }
    return { ...task };
  }

  completeTask(params) {
    const task = this.tasks.get(params.taskId);
    if (!task) return null;

    const timer = this.timers.get(params.taskId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(params.taskId);
    }

    task.status = params.status || 'completed';
    task.result = params.result;
    task.completedAt = Date.now();
    task.progress = task.status === 'completed' ? '执行完毕' : '执行出错';
    if (params.source) task.source = params.source;
    if (typeof params.tabId === 'number') task.tabId = params.tabId;
    if (task.action === 'spawn' && task.autoCloseTab && task.status === 'completed') {
      task.tabClosed = true;
    }

    this.syncCoroutineCall(task);
    this.tasks.set(params.taskId, task);
    this.emit('task_updated', task);

    if (task.action === 'close_tab' && task.status === 'completed') {
      const closedTabId = task.tabId ?? task.targetTabId;
      if (typeof closedTabId === 'number') {
        this.markTabClosed(closedTabId);
      }
    }

    const resolver = this.resolvers.get(params.taskId);
    if (resolver) {
      this.resolvers.delete(params.taskId);
      resolver({ ...task });
    }
    return { ...task };
  }

  markTabClosed(tabId) {
    let count = 0;
    for (const [id, task] of this.tasks.entries()) {
      if (task.tabId === tabId && !task.tabClosed) {
        task.tabClosed = true;
        this.tasks.set(id, task);
        this.emit('task_updated', task);
        count += 1;
      }
    }
    return count;
  }

  findTabIdByTarget(target) {
    const trimmed = target.trim();
    const numeric = /^\d+$/.test(trimmed) ? Number(trimmed) : null;
    for (const task of this.getTasks()) {
      if (task.action !== 'spawn' || typeof task.tabId !== 'number') continue;
      if (numeric !== null && task.tabId === numeric) {
        return { tabId: task.tabId, subagentId: task.subagentId };
      }
      if (
        task.subagentId === trimmed ||
        task.id === trimmed ||
        task.subagentName === trimmed
      ) {
        return { tabId: task.tabId, subagentId: task.subagentId };
      }
    }
    if (numeric !== null) return { tabId: numeric };
    return { subagentId: trimmed };
  }

  getOpenSubagentTabs() {
    const byTabId = new Map();
    for (const t of this.getTasks()) {
      if (t.action !== 'spawn' || typeof t.tabId !== 'number' || t.tabClosed) continue;
      byTabId.set(t.tabId, t);
    }
    return Array.from(byTabId.values());
  }

  getTask(taskId) {
    const t = this.tasks.get(taskId);
    return t ? { ...t } : null;
  }

  getTasks() {
    return Array.from(this.tasks.values())
      .reverse()
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  getPendingTasks() {
    return this.getTasks().filter(
      (t) => t.status === 'pending' || t.status === 'processing'
    );
  }

  clearTasks() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.resolvers.clear();
    this.tasks.clear();
  }
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }
  return await new Promise((resolve) => {
    const chunks = [];
    let totalBytes = 0;
    const limit = 4 * 1024 * 1024;
    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes <= limit) {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

export function createBridgeRouter(options = {}) {
  const queue =
    options.queue || new PortableBridgeQueue(options.stateFilePath);
  const sseClients = new Set();
  const debugLogs = [];

  function pushLog(event, detail) {
    debugLogs.push({ ts: new Date().toISOString(), event, detail });
    if (debugLogs.length > 100) debugLogs.shift();
  }

  function broadcastSse(payload) {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(data);
      } catch {
        sseClients.delete(client);
      }
    }
  }

  queue.subscribe((event) => {
    broadcastSse({
      type: event.type,
      task: event.task,
      coroutine: event.coroutine,
      connectedClients: sseClients.size,
    });
  });

  return async function bridgeMiddleware(req, res, next) {
    const rawUrl = req.originalUrl || req.url || '/';
    let pathname = '/';
    try {
      pathname = new URL(rawUrl, 'http://localhost').pathname;
    } catch {
      pathname = rawUrl.split('?')[0];
    }

    if (!pathname.startsWith('/api/__bridge')) {
      if (typeof next === 'function') next();
      return;
    }

    const method = (req.method || 'GET').toUpperCase();

    // 1. SSE 长连接通道
    if (method === 'GET' && pathname === '/api/__bridge/stream') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      sseClients.add(res);
      pushLog('sse_connect', `clients=${sseClients.size}`);

      res.write(
        `data: ${JSON.stringify({
          type: 'init',
          connectedClients: sseClients.size,
          tasks: queue.getTasks(),
          coroutine: queue.getCoroutineState(),
        })}\n\n`
      );

      broadcastSse({
        type: 'clients_count',
        connectedClients: sseClients.size,
      });

      const heartbeat = setInterval(() => {
        try {
          res.write(': heartbeat\n\n');
        } catch {
          clearInterval(heartbeat);
        }
      }, 15000);

      req.on('close', () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
        pushLog('sse_close', `clients=${sseClients.size}`);
        broadcastSse({
          type: 'clients_count',
          connectedClients: sseClients.size,
        });
      });
      return;
    }

    // 2. 任务派发
    if (method === 'POST' && pathname === '/api/__bridge/dispatch') {
      const body = await readJsonBody(req);
      const {
        prompt,
        taskSpec,
        action = 'spawn',
        subagentName,
        activeTab = false,
        autoCloseTab = false,
        targetTabId,
        targetSubagentId,
        timeoutMs,
        wait = true,
        coroutine = false,
        resumeMaster = false,
        stepCheckpoint,
        nextAction,
        masterMemory,
        memoryPosition,
        batchId,
        tasks: batchItems,
      } = body || {};

      if (Array.isArray(batchItems) && batchItems.length > 0) {
        const dispatchedTasks = [];
        for (let i = 0; i < batchItems.length; i++) {
          const item = batchItems[i] || {};
          const itemSpec = normalizeTaskContractSpec(item.taskSpec || taskSpec);
          const rawItemPrompt = typeof item.prompt === 'string' ? item.prompt.trim() : '';

          if (!rawItemPrompt && itemSpec) {
            const check = validateTaskContract(itemSpec);
            if (!check.valid) {
              sendJson(res, 400, {
                error: `第 ${i + 1} 个协程任务契约不完整：${check.errors.join('；')}`,
              });
              return;
            }
          }

          const resolvedItemPrompt =
            rawItemPrompt || (itemSpec ? formatTaskContractPrompt(itemSpec) : '');
          if (!resolvedItemPrompt) {
            sendJson(res, 400, {
              error: `第 ${i + 1} 个协程任务缺少非空 prompt 或完整 taskSpec`,
            });
            return;
          }

          const isLast = i === batchItems.length - 1;
          const { task } = queue.dispatchTask({
            prompt: resolvedItemPrompt,
            taskSpec: itemSpec,
            action: 'spawn',
            subagentName: item.subagentName,
            activeTab: Boolean(item.activeTab ?? activeTab),
            autoCloseTab: Boolean(item.autoCloseTab ?? autoCloseTab),
            timeoutMs: Number(item.timeoutMs || timeoutMs) || 360000,
            coroutine: true,
            resumeMaster: isLast ? Boolean(resumeMaster ?? true) : false,
            stepCheckpoint: item.stepCheckpoint || stepCheckpoint,
            nextAction: item.nextAction || nextAction,
            masterMemory: item.masterMemory || (isLast ? masterMemory : undefined),
            memoryPosition: item.memoryPosition || memoryPosition,
            batchId,
          });
          dispatchedTasks.push(task);
          pushLog(
            'dispatch',
            `id=${task.id} action=spawn coroutine=true batch=${task.batchId} callIndex=${task.callIndex}`
          );
        }
        sendJson(res, 200, {
          ok: true,
          tasks: dispatchedTasks,
          coroutine: queue.getCoroutineState(),
        });
        return;
      }

      const normalizedAction =
        action === 'prompt' ? 'prompt' : action === 'close_tab' ? 'close_tab' : 'spawn';

      const normalizedSpec = normalizeTaskContractSpec(taskSpec);
      const rawPrompt = typeof prompt === 'string' ? prompt.trim() : '';

      if (!rawPrompt && normalizedSpec && normalizedAction === 'spawn') {
        const check = validateTaskContract(normalizedSpec);
        if (!check.valid) {
          sendJson(res, 400, {
            error: `任务契约定义不完整：${check.errors.join('；')}`,
          });
          return;
        }
      }

      const resolvedSpawnPrompt =
        rawPrompt || (normalizedSpec ? formatTaskContractPrompt(normalizedSpec) : '');

      if (normalizedAction !== 'close_tab' && !resolvedSpawnPrompt) {
        sendJson(res, 400, { error: '请提供非空的 prompt 提示词文本或完整的 taskSpec 任务契约' });
        return;
      }

      let resolvedTabId = typeof targetTabId === 'number' ? targetTabId : undefined;
      let resolvedSubagentId =
        typeof targetSubagentId === 'string' && targetSubagentId.trim()
          ? targetSubagentId.trim()
          : undefined;

      if (normalizedAction === 'close_tab') {
        const lookupKey =
          resolvedTabId !== undefined
            ? String(resolvedTabId)
            : resolvedSubagentId || (typeof prompt === 'string' ? prompt.trim() : '');
        if (!lookupKey) {
          sendJson(res, 400, { error: '关闭 Tab 时请提供 targetTabId 或 targetSubagentId' });
          return;
        }
        const found = queue.findTabIdByTarget(lookupKey);
        if (resolvedTabId === undefined && typeof found.tabId === 'number') {
          resolvedTabId = found.tabId;
        }
        if (!resolvedSubagentId && found.subagentId) {
          resolvedSubagentId = found.subagentId;
        }
      }

      const defaultTimeout =
        normalizedAction === 'spawn'
          ? 360000
          : normalizedAction === 'close_tab'
          ? 15000
          : 30000;

      const finalPrompt =
        resolvedSpawnPrompt ||
        `关闭 Subagent Tab (${resolvedSubagentId || `Tab #${resolvedTabId}`})`;

      const { task, waitPromise } = queue.dispatchTask({
        prompt: finalPrompt,
        taskSpec: normalizedSpec,
        action: normalizedAction,
        subagentName,
        activeTab: Boolean(activeTab),
        autoCloseTab: Boolean(autoCloseTab),
        targetTabId: resolvedTabId,
        targetSubagentId: resolvedSubagentId,
        timeoutMs: Number(timeoutMs) || defaultTimeout,
        coroutine: Boolean(coroutine),
        resumeMaster: Boolean(resumeMaster),
        stepCheckpoint,
        nextAction,
        masterMemory,
        memoryPosition,
        batchId,
      });

      pushLog(
        'dispatch',
        `id=${task.id} action=${task.action} coroutine=${Boolean(task.coroutine)} clients=${sseClients.size}`
      );

      if (wait === false || task.coroutine) {
        sendJson(res, 200, {
          ok: true,
          task,
          coroutine: queue.getCoroutineState(),
        });
        return;
      }

      const completedTask = await waitPromise;
      sendJson(res, 200, {
        ok: completedTask.status === 'completed',
        task: completedTask,
        coroutine: queue.getCoroutineState(),
      });
      return;
    }

    // 3. 单任务查询
    if (method === 'GET' && pathname.startsWith('/api/__bridge/task/')) {
      const taskId = decodeURIComponent(pathname.slice('/api/__bridge/task/'.length));
      const task = queue.getTask(taskId);
      if (!task) {
        sendJson(res, 404, { error: `未找到任务 ${taskId}` });
        return;
      }
      sendJson(res, 200, { ok: task.status === 'completed', task });
      return;
    }

    // 4. 协程状态、唤醒回执与重置
    if (method === 'GET' && pathname === '/api/__bridge/coroutine') {
      sendJson(res, 200, { ok: true, coroutine: queue.getCoroutineState() });
      return;
    }

    if (method === 'POST' && pathname === '/api/__bridge/coroutine/resumed') {
      const body = await readJsonBody(req);
      const { batchId, ok = true, error } = body || {};
      const coroutine = queue.markCoroutineResumed(
        typeof batchId === 'string' ? batchId : undefined
      );
      pushLog('coroutine_resume', `batch=${batchId || '-'} ok=${ok}${error ? ` error=${error}` : ''}`);
      sendJson(res, 200, { ok: Boolean(ok), coroutine });
      return;
    }

    if (method === 'POST' && pathname === '/api/__bridge/coroutine/reset') {
      const coroutine = queue.resetCoroutine();
      pushLog('coroutine_reset', 'reset totalSubagentCalls=0 roundCount=0');
      sendJson(res, 200, { ok: true, coroutine });
      return;
    }

    // 5. 插件进度 & 结果回传
    if (method === 'POST' && pathname === '/api/__bridge/ack') {
      const body = await readJsonBody(req);
      const { taskId, source, progress, tabId } = body || {};
      if (!taskId) {
        sendJson(res, 400, { error: '缺少 taskId' });
        return;
      }
      const updated = queue.markProcessing(taskId, {
        source,
        progress,
        tabId: typeof tabId === 'number' ? tabId : undefined,
      });
      sendJson(res, 200, { ok: Boolean(updated), task: updated });
      return;
    }

    if (method === 'POST' && pathname === '/api/__bridge/callback') {
      const body = await readJsonBody(req);
      const {
        taskId,
        result,
        status = 'completed',
        source = 'chrome-extension',
        tabId,
      } = body || {};
      if (!taskId) {
        sendJson(res, 400, { error: '缺少 taskId' });
        return;
      }
      const updated = queue.completeTask({
        taskId,
        result: typeof result === 'string' ? result : JSON.stringify(result),
        status: status === 'error' ? 'error' : 'completed',
        source,
        tabId: typeof tabId === 'number' ? tabId : undefined,
      });
      pushLog('callback', `id=${taskId} status=${status} tabId=${tabId ?? '-'}`);
      if (!updated) {
        sendJson(res, 404, { error: `未找到任务 ${taskId}` });
        return;
      }
      sendJson(res, 200, { ok: true, task: updated });
      return;
    }

    if (method === 'POST' && pathname === '/api/__bridge/tab-closed') {
      const body = await readJsonBody(req);
      const tabId = Number(body?.tabId);
      if (!Number.isInteger(tabId) || tabId <= 0) {
        sendJson(res, 400, { error: '缺少有效的 tabId' });
        return;
      }
      const updatedCount = queue.markTabClosed(tabId);
      sendJson(res, 200, { ok: true, tabId, updatedCount });
      return;
    }

    if (method === 'GET' && pathname === '/api/__bridge/tabs') {
      const openTabs = queue.getOpenSubagentTabs();
      sendJson(res, 200, {
        ok: true,
        count: openTabs.length,
        tabs: openTabs.map((t) => ({
          taskId: t.id,
          subagentId: t.subagentId,
          subagentName: t.subagentName,
          tabId: t.tabId,
          status: t.status,
          createdAt: t.createdAt,
          completedAt: t.completedAt,
        })),
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/__bridge/status') {
      sendJson(res, 200, {
        connectedClients: sseClients.size,
        pendingCount: queue.getPendingTasks().length,
        openTabsCount: queue.getOpenSubagentTabs().length,
        coroutine: queue.getCoroutineState(),
        tasks: queue.getTasks(),
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/__bridge/debug') {
      sendJson(res, 200, {
        connectedClients: sseClients.size,
        taskCount: queue.getTasks().length,
        coroutine: queue.getCoroutineState(),
        logs: debugLogs,
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/__bridge/clear') {
      pushLog('clear', `prevTasks=${queue.getTasks().length}`);
      queue.clearTasks();
      broadcastSse({
        type: 'init',
        connectedClients: sseClients.size,
        tasks: [],
        coroutine: queue.getCoroutineState(),
      });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (typeof next === 'function') {
      next();
    } else {
      sendJson(res, 404, { error: `未知桥接接口: ${method} ${pathname}` });
    }
  };
}

/**
 * 纯前端 Vite 项目专用的零侵入插件（仅在 vite dev / serve 阶段生效，不进生产构建）
 */
export function subagentBridgeVitePlugin(options = {}) {
  return {
    name: 'aistudio-subagent-bridge',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(createBridgeRouter(options));
    },
  };
}
