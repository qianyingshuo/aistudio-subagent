---
name: browser-subagent-bridge
description: >
  无面板协程 Subagent 调度技能。通过容器内 3000 端口同源 SSE (/api/__bridge/stream) 与浏览器扩展通信，
  实现零 API 配额的「主 Agent 契约派发挂起 → 后台独立空会话串行执行 Subagent → 累计计数、位置锚点与主 Agent 自留记忆回填唤醒」协程调度。
---

# Browser Subagent Bridge Skill（无面板协程模式）

本技能用于**纯无前端面板（Headless）**的协程隔离调度：业务项目无需添加任何前端调试页面或 UI 代码，浏览器中的 Subagent Bridge 扩展会自动连接同源 `/api/__bridge/stream`（SSE）接收指令并执行。

当主 Agent 需要隔离上下文（避免读取大量文件或试错污染主会话），并希望在多轮交互中**清晰追踪阶段位置、严格框定子任务范围、并在唤醒后恢复挂起前思路**时，使用 `scripts/subagent.mjs` 的**协程模式（`yield` / `queue`）**。

> **核心协程机制**：同一工程同一时间只允许 1 个活跃回合。主 Agent 派发 Subagent 后**必须立刻停止工具调用并结束当前回合（挂起）**；浏览器扩展监测到主会话空闲后，依次在独立全新空会话（`+ → Start new chat`）执行所有入队的 Subagent，全部完成后将 **`[COROUTINE_RESUME]` 位置锚点 + 累计调用次数 + 全部结果 + 主 Agent 自留记忆** 自动填入主聊天框并发送，重新唤醒主 Agent。

---

## 1. 什么时候用 & 什么时候不要用

- **应该调用 Subagent**：
  - 需要大范围检索/阅读多个文件（避免海量代码塞满主会话上下文）。
  - 需要做独立代码审查、接口核对、逻辑排查或方案对比，希望在干净零历史上下文（`.zero-state`）中验证结论。
  - 需拆分为多个独立只读排查任务并行推进（通过多 `--task` 或 `queue` + `yield` 一轮挂起串行执行）。
- **不要调用 Subagent**：
  - 只需修改一两行明确代码或读取单个小文件时，直接自己完成更高效。
  - **严禁递归**：如果你当前正作为 Subagent Worker 在子会话中运行，**绝对禁止调用 `scripts/subagent.mjs`**。

---

## 2. 强制规范：Subagent「4 + 1 任务契约」

每次调用 `yield` 或 `queue` 启动 Subagent，**脚本会在参数阶段强制校验**以下 4 项范围定义（缺一不可，缺失将直接报错拦截），并推荐附带第 5 项主 Agent 挂起自留记忆：

1. **`--problem="..."`（问题描述）**：当前面临的背景问题与现状描述（为什么要派发此任务）。
2. **`--intension="..."`（任务内涵）**：真正想让 Subagent 干的核心事项、分析目标与交付格式。
3. **`--extension="..."`（任务外延）**：可能涉及的周边模块/关联文件边界（哪些模块可能相关，哪些无需展开）。
4. **`--non-goals="..."`（非目标）** + **`--forbidden="..."` / `--writable="..."`（目录红线）**：
   - `--non-goals`：明确告诉 Subagent **绝对不要做什么**；
   - `--forbidden`：明确列出**绝对禁止修改的目录或文件**（如 `"server.ts,src/bridge/"`）；
   - `--writable`：明确列出**允许修改的目录或文件**（若只读审查，填 `"只读分析，禁止修改或新建任何代码文件"`）。
5. **`--memory="..."` / `--memory-pos=after|before`（主 Agent 自留记忆，独立字段）**：
   - 这是主 Agent 留给**唤醒后的自己**的备忘录（例如已排查结论、待验证假设、唤醒后的决策分支）。
   - 该字段**不会混入 Subagent 提示词干扰子任务**，而是在子任务全部完成、插件唤醒主 Agent 时，**强制追加（默认 `after`，也可设为 `before` 前置）**到 `[COROUTINE_RESUME]` 恢复报文中。

---

## 3. 核心调用命令

### ① 单次派发并立即挂起等待唤醒（最常用）
```bash
node scripts/subagent.mjs yield \
  --name="审计员" \
  --step="阶段1/3：排查 server.ts 路由" \
  --next="拿到排查结论后修复接口" \
  --problem="鉴权接口偶发返回 401，需定位具体校验分支与中间件顺序" \
  --intension="只读检查 server.ts 与 src/auth/* 的 token 校验逻辑，列出问题文件、行号与修复建议" \
  --extension="可能关联 src/hooks/useAuth.ts 中的重试请求，但不必深入 UI 组件样式" \
  --non-goals="严禁修改任何业务代码、严禁重构状态管理、严禁新增依赖" \
  --forbidden="src/components/,src/bridge/,package.json" \
  --writable="只读分析，禁止修改或新建任何代码文件" \
  --memory="主 Agent 备忘：已确认前端登录表单传参正确，唤醒后优先对比审计员给出的 server.ts 行号再改后端。" \
  --close
```

### ② 使用 JSON 文件传入复杂契约（避免长文本引号转义）
```bash
node scripts/subagent.mjs yield --spec-file="task-spec.json" --close
```

### ③ 一轮挂起串行执行多个 Subagent（批次批处理）
方式 A（多 `--task` 语法，支持共享顶层 `--problem`/`--extension`/`--non-goals` 或 `--task='{...}'` JSON）：
```bash
node scripts/subagent.mjs yield \
  --step="阶段1/3：并列检查前后端" \
  --next="汇总两份检查报告开始修改" \
  --problem="前后端接口字段疑似不对齐" \
  --extension="可能涉及 API DTO 与表单状态同步" \
  --non-goals="只读核对，禁止改写任何文件" \
  --forbidden="server.ts,src/" \
  --writable="只读分析" \
  --memory="主 Agent 备忘：汇总两份报告后决定改前端适配还是后端兼容" \
  --close \
  --task="后端检查::只读核对 server.ts 返回的 JSON 字段结构" \
  --task="前端检查::只读核对 src/App.tsx 消费的字段名称"
```
方式 B（先 `queue` 入队，最后一条 `yield` 触发唤醒）：
```bash
node scripts/subagent.mjs queue --name="W1" --problem="..." --intension="..." --extension="..." --non-goals="..." --memory="阶段备忘1" --close
node scripts/subagent.mjs yield --name="W2" --step="阶段1" --next="汇总W1与W2" --problem="..." --intension="..." --extension="..." --non-goals="..." --memory="阶段备忘2" --close
```

### ④ 状态查询、进度检查与计数重置
```bash
node scripts/subagent.mjs status           # 查看连接数（connectedClients >= 1）、协程状态与队列
node scripts/subagent.mjs coroutine        # 查看批次数、累计调用 Subagent 次数、当前位置与自留记忆
node scripts/subagent.mjs coroutine-reset  # 开启全新无关需求前重置累计计数与记忆
node scripts/subagent.mjs tabs             # 查看尚未关闭的 Subagent Tab
node scripts/subagent.mjs close <目标>     # 手动关闭指定 tabId / subagentId / 名称的 Tab
```

---

## 4. 协程调用铁律

1. **调用 `yield` 后必须立刻停下**：`yield` 在 0.1~0.3 秒内即返回成功回执。拿到输出后，**立刻停止调用任何后续工具**，只用一句话告知用户当前已挂起，然后直接结束本轮回复。
2. **禁止 `sleep` 或轮询等待**：不要在派发后用命令轮询结果；必须结束本轮，让主会话处于空闲态，浏览器扩展才能安全启动后台子会话并在完成后自动唤醒你。
3. **识别唤醒报文 `[COROUTINE_RESUME]`**：扩展回填的唤醒消息中会包含批次数、累计调用次数、位置锚点、所有 Subagent 结果汇总，以及你挂起前留存的 `🧠 [主 Agent 挂起前自留记忆]`，结合这些信息直接推进下一步即可。
4. **长输出自动写文件交接（>200 字）**：当 Subagent 回复超过 200 字时，插件不会关闭子标签页，而是自动在该 Subagent 会话中续发指令让它把上一条完整输出写入 `.subagent-results/<taskId>.md`，并要求其用不超过 400 字回复确认并给出文件路径。主 Agent 收到文件路径后直接读取该文件继续工作即可，严禁重复派发同一 Subagent。
5. **权限遭拒自动 4 步恢复**：若 Subagent 或主窗口出现「权限遭拒」(`.error-header`)，插件会自动执行「点击 Retry -> 确认已开始运行 -> 点击停止并确认已停止 -> 重发完整提示词」。
