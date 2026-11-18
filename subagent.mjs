#!/usr/bin/env node
/**
 * AI Studio 容器端 Subagent 协程调度器 CLI (v4.2.0 Portable Coroutine Edition)
 *
 * 零第三方依赖，直接调用本机 http://localhost:3000/api/__bridge/*（支持 BRIDGE_URL 覆盖）。
 * 协程模式强制要求提供「4+1 任务契约」：
 *   1. --problem="..."    问题描述（要解决的现状/背景问题）
 *   2. --intension="..."  任务内涵（真正要让 Subagent 干的核心目标）
 *   3. --extension="..."  任务外延（可能涉及的关联模块边界）
 *   4. --non-goals="..."  非目标与红线（明确不做什么，可配合 --forbidden / --writable 指定禁改/可改目录）
 *   5. --memory="..."     主 Agent 自留记忆（单独字段：不干扰子任务，唤醒主 Agent 时强制追加/前置注入）
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE_URL = process.env.BRIDGE_URL || 'http://localhost:3000';

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

function readSpecFile(filePath) {
  const resolved = path.resolve(process.cwd(), filePath);
  const raw = fs.readFileSync(resolved, 'utf-8');
  return JSON.parse(raw);
}

export function parseCoroutineArgs(args, readFileFn = readSpecFile) {
  let subagentName = '';
  let stepCheckpoint = '';
  let nextAction = '';
  let problem = '';
  let intension = '';
  let extension = '';
  let nonGoals = '';
  let forbiddenPaths = '';
  let writablePaths = '';
  let masterMemory = '';
  let memoryPosition = 'after';
  let autoCloseTab = false;
  let activeTab = false;
  let specFile = '';
  const rawBatchTasks = [];
  const extraParts = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--name=')) {
      subagentName = arg.slice('--name='.length).trim();
    } else if (arg.startsWith('--step=')) {
      stepCheckpoint = arg.slice('--step='.length).trim();
    } else if (arg.startsWith('--next=')) {
      nextAction = arg.slice('--next='.length).trim();
    } else if (arg.startsWith('--problem=')) {
      problem = arg.slice('--problem='.length).trim();
    } else if (arg.startsWith('--intension=')) {
      intension = arg.slice('--intension='.length).trim();
    } else if (arg.startsWith('--core=')) {
      intension = arg.slice('--core='.length).trim();
    } else if (arg.startsWith('--extension=')) {
      extension = arg.slice('--extension='.length).trim();
    } else if (arg.startsWith('--related=')) {
      extension = arg.slice('--related='.length).trim();
    } else if (arg.startsWith('--non-goals=')) {
      nonGoals = arg.slice('--non-goals='.length).trim();
    } else if (arg.startsWith('--nongoals=')) {
      nonGoals = arg.slice('--nongoals='.length).trim();
    } else if (arg.startsWith('--forbidden=')) {
      forbiddenPaths = arg.slice('--forbidden='.length).trim();
    } else if (arg.startsWith('--writable=')) {
      writablePaths = arg.slice('--writable='.length).trim();
    } else if (arg.startsWith('--memory=')) {
      masterMemory = arg.slice('--memory='.length).trim();
    } else if (arg.startsWith('--memo=')) {
      masterMemory = arg.slice('--memo='.length).trim();
    } else if (arg.startsWith('--memory-pos=')) {
      const pos = arg.slice('--memory-pos='.length).trim().toLowerCase();
      memoryPosition = pos === 'before' ? 'before' : 'after';
    } else if (arg.startsWith('--spec-file=')) {
      specFile = arg.slice('--spec-file='.length).trim();
    } else if (arg.startsWith('--task=')) {
      rawBatchTasks.push(arg.slice('--task='.length));
    } else if (arg === '--close') {
      autoCloseTab = true;
    } else if (arg === '--focus') {
      activeTab = true;
    } else {
      extraParts.push(arg);
    }
  }

  let fileData = null;
  if (specFile) {
    fileData = readFileFn(specFile);
    if (fileData && typeof fileData === 'object') {
      subagentName = subagentName || String(fileData.name || fileData.subagentName || '').trim();
      stepCheckpoint = stepCheckpoint || String(fileData.step || fileData.stepCheckpoint || '').trim();
      nextAction = nextAction || String(fileData.next || fileData.nextAction || '').trim();
      problem = problem || String(fileData.problem || '').trim();
      intension = intension || String(fileData.intension || fileData.core || '').trim();
      extension = extension || String(fileData.extension || fileData.related || '').trim();
      nonGoals = nonGoals || String(fileData.nonGoals || fileData.non_goals || '').trim();
      forbiddenPaths =
        forbiddenPaths || String(fileData.forbiddenPaths || fileData.forbidden || '').trim();
      writablePaths =
        writablePaths || String(fileData.writablePaths || fileData.writable || '').trim();
      masterMemory =
        masterMemory || String(fileData.memory || fileData.masterMemory || '').trim();
      if (fileData.memoryPosition === 'before') {
        memoryPosition = 'before';
      }
      if (typeof fileData.autoCloseTab === 'boolean' && !autoCloseTab) {
        autoCloseTab = fileData.autoCloseTab;
      }
      if (typeof fileData.activeTab === 'boolean' && !activeTab) {
        activeTab = fileData.activeTab;
      }
    }
  }

  const extraPrompt = [
    fileData && typeof fileData.extraPrompt === 'string' ? fileData.extraPrompt.trim() : '',
    extraParts.join(' ').trim(),
  ]
    .filter(Boolean)
    .join('\n')
    .trim();

  const sharedSpec = {
    problem,
    intension,
    extension,
    nonGoals,
    forbiddenPaths: forbiddenPaths || undefined,
    writablePaths: writablePaths || undefined,
  };

  const fileTasks =
    fileData && Array.isArray(fileData.tasks) ? fileData.tasks : [];

  if (rawBatchTasks.length > 0 || fileTasks.length > 0) {
    const parsedTasks = [];

    for (const ft of fileTasks) {
      if (!ft || typeof ft !== 'object') continue;
      const spec = {
        problem: String(ft.problem || sharedSpec.problem || '').trim(),
        intension: String(ft.intension || ft.core || sharedSpec.intension || '').trim(),
        extension: String(ft.extension || ft.related || sharedSpec.extension || '').trim(),
        nonGoals: String(ft.nonGoals || ft.non_goals || sharedSpec.nonGoals || '').trim(),
        forbiddenPaths:
          String(ft.forbiddenPaths || ft.forbidden || sharedSpec.forbiddenPaths || '').trim() ||
          undefined,
        writablePaths:
          String(ft.writablePaths || ft.writable || sharedSpec.writablePaths || '').trim() ||
          undefined,
      };
      const check = validateTaskContract(spec);
      if (!check.valid) {
        return {
          ok: false,
          errors: check.errors.map(
            (e) => `子任务 [${ft.name || ft.subagentName || '未命名'}] ${e}`
          ),
        };
      }
      parsedTasks.push({
        subagentName: String(ft.name || ft.subagentName || '').trim() || undefined,
        taskSpec: spec,
        prompt: formatTaskContractPrompt(spec, ft.extraPrompt || extraPrompt),
        masterMemory: String(ft.memory || ft.masterMemory || '').trim() || undefined,
        memoryPosition: ft.memoryPosition === 'before' ? 'before' : memoryPosition,
        autoCloseTab: typeof ft.autoCloseTab === 'boolean' ? ft.autoCloseTab : autoCloseTab,
        activeTab: typeof ft.activeTab === 'boolean' ? ft.activeTab : activeTab,
        stepCheckpoint: stepCheckpoint || undefined,
        nextAction: nextAction || undefined,
      });
    }

    for (let idx = 0; idx < rawBatchTasks.length; idx++) {
      const raw = rawBatchTasks[idx].trim();
      let itemObj = null;
      if (raw.startsWith('{')) {
        try {
          itemObj = JSON.parse(raw);
        } catch {
          return {
            ok: false,
            errors: [`第 ${idx + 1} 个 --task JSON 解析失败，请检查引号或改用 --spec-file`],
          };
        }
      }

      if (itemObj && typeof itemObj === 'object') {
        const spec = {
          problem: String(itemObj.problem || sharedSpec.problem || '').trim(),
          intension: String(itemObj.intension || itemObj.core || sharedSpec.intension || '').trim(),
          extension: String(itemObj.extension || itemObj.related || sharedSpec.extension || '').trim(),
          nonGoals: String(itemObj.nonGoals || itemObj.non_goals || sharedSpec.nonGoals || '').trim(),
          forbiddenPaths:
            String(
              itemObj.forbiddenPaths || itemObj.forbidden || sharedSpec.forbiddenPaths || ''
            ).trim() || undefined,
          writablePaths:
            String(
              itemObj.writablePaths || itemObj.writable || sharedSpec.writablePaths || ''
            ).trim() || undefined,
        };
        const check = validateTaskContract(spec);
        if (!check.valid) {
          return {
            ok: false,
            errors: check.errors.map(
              (e) =>
                `第 ${idx + 1} 个 --task (${itemObj.name || itemObj.subagentName || '未命名'}) ${e}`
            ),
          };
        }
        parsedTasks.push({
          subagentName: String(itemObj.name || itemObj.subagentName || '').trim() || undefined,
          taskSpec: spec,
          prompt: formatTaskContractPrompt(spec, itemObj.extraPrompt || extraPrompt),
          masterMemory: String(itemObj.memory || itemObj.masterMemory || '').trim() || undefined,
          memoryPosition: itemObj.memoryPosition === 'before' ? 'before' : memoryPosition,
          autoCloseTab,
          activeTab,
          stepCheckpoint: stepCheckpoint || undefined,
          nextAction: nextAction || undefined,
        });
      } else {
        const sepIdx = raw.indexOf('::');
        const taskName = sepIdx > 0 ? raw.slice(0, sepIdx).trim() : '';
        const taskIntension = sepIdx > 0 ? raw.slice(sepIdx + 2).trim() : raw;
        const spec = {
          problem: sharedSpec.problem,
          intension: taskIntension || sharedSpec.intension,
          extension: sharedSpec.extension,
          nonGoals: sharedSpec.nonGoals,
          forbiddenPaths: sharedSpec.forbiddenPaths,
          writablePaths: sharedSpec.writablePaths,
        };
        const check = validateTaskContract(spec);
        if (!check.valid) {
          return {
            ok: false,
            errors: check.errors.map(
              (e) => `第 ${idx + 1} 个 --task (${taskName || '未命名'}) ${e}`
            ),
          };
        }
        parsedTasks.push({
          subagentName: taskName || undefined,
          taskSpec: spec,
          prompt: formatTaskContractPrompt(spec, extraPrompt),
          autoCloseTab,
          activeTab,
          stepCheckpoint: stepCheckpoint || undefined,
          nextAction: nextAction || undefined,
        });
      }
    }

    return {
      ok: true,
      mode: 'batch',
      batchTasks: parsedTasks,
      stepCheckpoint: stepCheckpoint || undefined,
      nextAction: nextAction || undefined,
      masterMemory: masterMemory || undefined,
      memoryPosition,
    };
  }

  const check = validateTaskContract(sharedSpec);
  if (!check.valid) {
    return {
      ok: false,
      errors: check.errors,
    };
  }

  return {
    ok: true,
    mode: 'single',
    subagentName: subagentName || undefined,
    taskSpec: sharedSpec,
    prompt: formatTaskContractPrompt(sharedSpec, extraPrompt),
    autoCloseTab,
    activeTab,
    stepCheckpoint: stepCheckpoint || undefined,
    nextAction: nextAction || undefined,
    masterMemory: masterMemory || undefined,
    memoryPosition,
  };
}

function printContractUsageHint(command = 'yield') {
  console.error(`
❌ 启动协程 Subagent 失败：任务契约必须完整框定以下 4 项范围定义！
   1) --problem="..."    问题描述（当前遇到了什么问题/背景）
   2) --intension="..."  任务内涵（真正要让 Subagent 干什么）
   3) --extension="..."  任务外延（可能涉及哪些关联模块/文件，哪些可能不涉及）
   4) --non-goals="..."  非目标（绝对不要做什么；配合 --forbidden / --writable 划定禁改与可改目录）
   5) --memory="..."     [可选强推荐] 主 Agent 自留记忆（不发给 Subagent，唤醒主 Agent 时强制追加到恢复报文）

标准调用示例：
  node scripts/subagent.mjs ${command} \\
    --name="后端审计员" \\
    --step="阶段1/3：只读排查鉴权逻辑" \\
    --next="拿到审计定位后开始修复" \\
    --problem="登录态刷新偶发 401，需要定位中间件与 token 校验链" \\
    --intension="只读检查 server.ts 与 src/auth/* 的 token 校验与过期分支，输出文件+行号+原因" \\
    --extension="可能关联 src/hooks/useAuth.ts 的重试请求，但不必深入 UI 样式层" \\
    --non-goals="禁止修改任何业务代码、禁止重构前端状态、禁止安装依赖" \\
    --forbidden="src/components/,src/bridge/,package.json" \\
    --writable="只读分析，禁止修改或新建任何文件" \\
    --memory="主 Agent 备忘：已排查过 App.tsx 第 120 行无异常，唤醒后重点核对 refreshToken 竞态锁" \\
    --close

（若参数文本较长，也可使用 --spec-file="task-spec.json" 传入 JSON 契约）
`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';

  if (command === 'status') {
    const res = await fetch(`${BASE_URL}/api/__bridge/status`);
    if (!res.ok) {
      console.error(`无法连接本地桥接服务 (${res.status})`);
      process.exit(1);
    }
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (command === 'coroutine' || command === 'checkpoint') {
    const res = await fetch(`${BASE_URL}/api/__bridge/coroutine`);
    if (!res.ok) {
      console.error(`无法获取协程状态 (${res.status})`);
      process.exit(1);
    }
    const data = await res.json();
    console.log(JSON.stringify(data.coroutine, null, 2));
    return;
  }

  if (command === 'coroutine-reset') {
    const res = await fetch(`${BASE_URL}/api/__bridge/coroutine/reset`, {
      method: 'POST',
    });
    if (!res.ok) {
      console.error(`重置协程计数失败 (${res.status})`);
      process.exit(1);
    }
    const data = await res.json();
    console.log('[Coroutine] 已重置协程批次与 Subagent 累计调用计数:', JSON.stringify(data.coroutine));
    return;
  }

  if (command === 'tabs') {
    const res = await fetch(`${BASE_URL}/api/__bridge/tabs`);
    if (!res.ok) {
      console.error(`无法获取打开的 Subagent 标签页列表 (${res.status})`);
      process.exit(1);
    }
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (command === 'result') {
    const taskId = args[1]?.trim();
    if (!taskId) {
      console.error('用法错误：请提供 taskId，例如 node scripts/subagent.mjs result task_123');
      process.exit(1);
    }
    const res = await fetch(`${BASE_URL}/api/__bridge/task/${encodeURIComponent(taskId)}`);
    if (!res.ok) {
      console.error(`查询任务失败 (${res.status}): ${await res.text()}`);
      process.exit(1);
    }
    const data = await res.json();
    console.log(JSON.stringify(data.task, null, 2));
    return;
  }

  if (command === 'close') {
    const target = args.slice(1).join(' ').trim();
    if (!target) {
      console.error(
        '用法错误：请提供要关闭的目标（subagentId、tabId、taskId 或 Subagent 名称），例如：\n  node scripts/subagent.mjs close subagent_1\n  node scripts/subagent.mjs close 123456'
      );
      process.exit(1);
    }

    const isNumericTabId = /^\d+$/.test(target);
    console.log(`[Bridge CLI] 正在通知 Chrome 插件关闭 Subagent Tab: ${target}...`);

    const res = await fetch(`${BASE_URL}/api/__bridge/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'close_tab',
        targetTabId: isNumericTabId ? Number(target) : undefined,
        targetSubagentId: target,
        prompt: `关闭不再需要的 Subagent Tab: ${target}`,
        timeoutMs: 15000,
        wait: true,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[Bridge CLI] 关闭请求失败 (${res.status}): ${errText}`);
      process.exit(1);
    }

    const data = await res.json();
    console.log(`[Bridge CLI] 关闭结果 (${data.task?.status}): ${data.task?.result || ''}`);
    if (!data.ok) process.exit(2);
    return;
  }

  if (command === 'queue' || command === 'yield') {
    const parsed = parseCoroutineArgs(args.slice(1));
    if (!parsed.ok) {
      for (const err of parsed.errors || []) {
        console.error(`[Contract Error] ${err}`);
      }
      printContractUsageHint(command);
      process.exit(1);
    }

    const resumeMaster = command === 'yield';

    if (parsed.mode === 'batch') {
      const res = await fetch(`${BASE_URL}/api/__bridge/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tasks: parsed.batchTasks,
          resumeMaster,
          stepCheckpoint: parsed.stepCheckpoint,
          nextAction: parsed.nextAction,
          masterMemory: parsed.masterMemory,
          memoryPosition: parsed.memoryPosition,
        }),
      });
      if (!res.ok) {
        console.error(`[Coroutine CLI] 批量派发失败 (${res.status}): ${await res.text()}`);
        process.exit(1);
      }
      const data = await res.json();
      const c = data.coroutine || {};
      const ids = (data.tasks || []).map((t) => `#${t.callIndex} ${t.subagentName} (${t.id})`).join(', ');
      console.log(
        `[Coroutine] ✅ 已入队 ${data.tasks?.length || 0} 个带契约约束的 Subagent 任务: ${ids}`
      );
      console.log(
        `[Coroutine] 批次: batch_${c.roundCount} | 累计已调用 Subagent: ${c.totalSubagentCalls} 次 | 位置: "${
          c.currentCheckpoint || '未指定'
        }" | 下一步: "${c.nextAction || '未指定'}"`
      );
      if (c.masterMemory) {
        console.log(
          `[Coroutine] 🧠 已登记主 Agent 挂起记忆 (${c.memoryPosition === 'before' ? '唤醒前置' : '唤醒追加'}): "${c.masterMemory.slice(0, 80)}${
            c.masterMemory.length > 80 ? '...' : ''
          }"`
        );
      }
      if (resumeMaster) {
        console.log(
          '[Coroutine] ⏸️ 主 Agent 请立刻输出挂起提示并停止调用工具，插件将在全部子任务完成后自动把结果、位置与自留记忆回填至主聊天框唤醒你。'
        );
      }
      return;
    }

    const res = await fetch(`${BASE_URL}/api/__bridge/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'spawn',
        subagentName: parsed.subagentName,
        activeTab: parsed.activeTab,
        autoCloseTab: parsed.autoCloseTab,
        prompt: parsed.prompt,
        taskSpec: parsed.taskSpec,
        timeoutMs: 0,
        wait: false,
        coroutine: true,
        resumeMaster,
        stepCheckpoint: parsed.stepCheckpoint,
        nextAction: parsed.nextAction,
        masterMemory: parsed.masterMemory,
        memoryPosition: parsed.memoryPosition,
      }),
    });

    if (!res.ok) {
      console.error(`[Coroutine CLI] 派发失败 (${res.status}): ${await res.text()}`);
      process.exit(1);
    }

    const data = await res.json();
    const t = data.task || {};
    const c = data.coroutine || {};
    console.log(
      `[Coroutine] ✅ 已派发第 ${t.callIndex} 次 Subagent 调用: ${t.subagentName} (taskId: ${t.id}, batch: ${t.batchId})`
    );
    console.log(
      `[Coroutine] 累计调用: ${c.totalSubagentCalls} 次 | 当前位置: "${
        c.currentCheckpoint || '未指定'
      }" | 下一步: "${c.nextAction || '未指定'}" | 触发唤醒: ${resumeMaster ? '是 (请立即停下)' : '否 (等待后续 queue/yield)'}`
    );
    if (c.masterMemory) {
      console.log(
        `[Coroutine] 🧠 已登记主 Agent 挂起记忆 (${c.memoryPosition === 'before' ? '唤醒前置' : '唤醒追加'}): "${c.masterMemory.slice(0, 80)}${
          c.masterMemory.length > 80 ? '...' : ''
        }"`
      );
    }
    if (resumeMaster) {
      console.log(
        '[Coroutine] ⏸️ 请主 Agent 立即停止调用工具并输出简短挂起提示，等待插件唤醒。'
      );
    }
    return;
  }

  if (command === 'spawn' || command === 'send' || command === 'popup') {
    let subagentName = '';
    let autoCloseTab = false;
    let activeTab = false;
    let asyncMode = false;
    const promptParts = [];

    const hasContractFlags = args.slice(1).some((a) =>
      a.startsWith('--problem=') ||
      a.startsWith('--intension=') ||
      a.startsWith('--core=') ||
      a.startsWith('--extension=') ||
      a.startsWith('--non-goals=') ||
      a.startsWith('--spec-file=')
    );

    let contractSpec = null;
    let resolvedPrompt = '';

    if (command === 'spawn' && hasContractFlags) {
      const parsed = parseCoroutineArgs(args.slice(1));
      if (!parsed.ok) {
        for (const err of parsed.errors || []) {
          console.error(`[Contract Error] ${err}`);
        }
        printContractUsageHint('spawn');
        process.exit(1);
      }
      if (parsed.mode === 'single') {
        subagentName = parsed.subagentName || '';
        autoCloseTab = parsed.autoCloseTab;
        activeTab = parsed.activeTab;
        contractSpec = parsed.taskSpec;
        resolvedPrompt = parsed.prompt;
      }
    }

    if (!resolvedPrompt) {
      for (let i = 1; i < args.length; i++) {
        if (args[i].startsWith('--name=')) {
          subagentName = args[i].slice('--name='.length).trim();
        } else if (args[i] === '--close') {
          autoCloseTab = true;
        } else if (args[i] === '--focus') {
          activeTab = true;
        } else if (args[i] === '--async') {
          asyncMode = true;
        } else {
          promptParts.push(args[i]);
        }
      }
      resolvedPrompt = promptParts.join(' ').trim();
    }

    if (!resolvedPrompt) {
      console.error(
        '用法错误：请提供提示词，例如 node scripts/subagent.mjs spawn --name="检索员" "帮我总结..."'
      );
      process.exit(1);
    }

    const action = command === 'popup' ? 'prompt' : 'spawn';
    const timeoutMs = action === 'spawn' ? 360000 : 30000;

    console.log(
      `[Bridge CLI] 正在派发任务 (模式: ${
        action === 'spawn'
          ? activeTab
            ? '前台打开 Tab 跑 Subagent'
            : '后台静默 Subagent (等待主会话空闲)'
          : '5秒弹窗测试'
      }${subagentName ? `, 名称: ${subagentName}` : ''}${asyncMode ? ', 异步非阻塞' : ''})...`
    );

    const startTime = Date.now();
    const res = await fetch(`${BASE_URL}/api/__bridge/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        subagentName: subagentName || undefined,
        activeTab,
        autoCloseTab,
        prompt: resolvedPrompt,
        taskSpec: contractSpec || undefined,
        timeoutMs,
        wait: !asyncMode,
      }),
    });

    if (!res.ok) {
      console.error(`[Bridge CLI] 请求失败 (${res.status}): ${await res.text()}`);
      process.exit(1);
    }

    const data = await res.json();
    if (asyncMode) {
      console.log(`[Bridge CLI] 已异步派发任务 id: ${data.task?.id} (subagentId: ${data.task?.subagentId})`);
      return;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `[Bridge CLI] 状态: ${data.task?.status} (耗时 ${elapsed}s, 执行者: ${
        data.task?.source || data.task?.subagentName || 'unknown'
      }, subagentId: ${data.task?.subagentId || '-'}, tabId: ${data.task?.tabId || '-'})`
    );
    console.log(`[Bridge CLI] 回复内容:\n${data.task?.result || ''}`);
    if (!data.ok) process.exit(2);
    return;
  }

  console.log(`
AI Studio Subagent Bridge CLI (v4.2.0 协程契约约束 + 自留记忆唤醒)
协程必填 4 项契约参数（yield / queue 强制校验，缺一不可）：
  --problem="..."       1. 问题描述
  --intension="..."     2. 任务内涵（真正要让 Subagent 做什么）
  --extension="..."     3. 任务外延（可能涉及的关联模块/文件边界）
  --non-goals="..."     4. 非目标（绝对不要做什么）
可选红线与记忆参数：
  --forbidden="..."     绝对禁止修改的目录/文件（如 "server.ts,src/bridge/"）
  --writable="..."      允许修改的目录/文件（默认：只读分析，禁止改文件）
  --memory="..."        主 Agent 自留记忆（单独字段，唤醒主 Agent 时强制追加注入）
  --memory-pos=after|before  记忆位置（默认 after 追加在结果后，可设为 before 置前）
  --spec-file=path.json 从 JSON 文件读取任务契约与批量任务

核心协程命令:
  node scripts/subagent.mjs yield --name="审计员" --step="阶段1/3" --next="修复漏洞" \\
    --problem="..." --intension="..." --extension="..." --non-goals="..." \\
    --forbidden="server.ts" --writable="只读" --memory="主 Agent 备忘..." --close
  node scripts/subagent.mjs queue ...        入队暂不唤醒（配合后续 yield 批处理）
  node scripts/subagent.mjs coroutine        查看当前协程批次、调用总次数、位置锚点与记忆
  node scripts/subagent.mjs coroutine-reset  新需求开始前清空累计调用计数
  node scripts/subagent.mjs status           查看连接数、协程状态与完整任务队列
  node scripts/subagent.mjs tabs / close <目标>  查看或关闭尚未自动关闭的子标签页
`);
}

const isDirectEntry =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectEntry) {
  main().catch((err) => {
    console.error('[Bridge CLI Error]', err.message || err);
    process.exit(1);
  });
}
