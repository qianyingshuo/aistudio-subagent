# aistudio-subagent
通过chrome插件的方式未ai studio build 提供subagent 功能

# AI Studio Subagent 无面板协程套件 — 安装说明

> **致接收本文件的 AI Agent**：
> 这是一套**无前端 UI 面板、零 API 配额消耗**的 Subagent 协程隔离调度工具。用户浏览器中已长期安装 `Subagent Bridge` Chrome 扩展，扩展会直接通过同源 `/api/__bridge/stream`（SSE）与当前项目通信，**你不需要在业务页面写任何前端代码或调试面板**。
>
> 安装完成后，日常调度 Subagent 的详细规范与命令模板请直接遵循随包附带的 `SKILL.md`。

---

## 1. 套件文件清单与放置位置

本套件仅包含 **2 个运行脚本 + 1 个技能说明文件**（零第三方 npm 依赖，纯 Node.js 原生 ESM）：

| 源文件 | 应放到目标项目的位置 | 作用 |
| :--- | :--- | :--- |
| `bridge-middleware.mjs` | `scripts/bridge-middleware.mjs` | 服务端本地 `/api/__bridge/*` 路由与协程账本持久化中间件（同时兼容 Vite 插件与 Express） |
| `subagent.mjs` | `scripts/subagent.mjs` | 主 Agent 用来派发带契约约束的子任务、记录位置与自留记忆的 CLI 工具 |
| `SKILL.md` | `SKILL.md`（或 `.skills/browser-subagent-bridge/SKILL.md`） | 供目标项目 Agent 日常读取执行的无面板协程技能协议 |

### 自动清理与 `.gitignore` 配置
运行过程中会在项目根目录生成 `.subagent-coroutine.json`（用于跨轮次记忆协程批次数、累计调用次数、阶段位置与自留记忆）。
**请自动检查目标项目的 `.gitignore`**，若尚未包含以下条目，请追加：
```gitignore
.subagent-coroutine.json
```

---

## 2. 按项目类型自动挂载中间件（二选一）

请先查看目标项目根目录结构（是否存在 `server.ts` / `vite.config.ts` / `package.json`），选择对应的 **1 行挂载方式**（**绝对不要破坏目标项目原有的业务路由或前端界面**）：

### 情况 A：纯前端 Vite 项目（无 `server.ts`，有 `vite.config.ts` 或 `vite.config.js`）
不要把项目改造成 Express 全栈！直接在 `vite.config.ts` 中导入 `subagentBridgeVitePlugin`（内置 `apply: 'serve'`，只在开发预览生效，**`npm run build` 打包生产代码时零残留**）：

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { subagentBridgeVitePlugin } from './scripts/bridge-middleware.mjs';

export default defineConfig({
  plugins: [
    react(),
    subagentBridgeVitePlugin(), // 仅开发环境注入 /api/__bridge/* 路由
  ],
});
```

> 若 TypeScript 对导入 `.mjs` 报类型提示且项目开启了严格 `tsc`，可在引用处上方加 `// @ts-expect-error portable mjs plugin` 或确认 `tsconfig.json` 允许 `allowJs: true`。

### 情况 B：全栈 Express + Vite 项目（存在 `server.ts` / `server.js`）
在 `server.ts` 初始化 `app` 之后、`vite.middlewares` / 静态托管 / 通配路由 `app.get('*')` **之前**挂载 `createBridgeRouter()`：

```ts
// server.ts
import express from 'express';
import { createBridgeRouter } from './scripts/bridge-middleware.mjs';

const app = express();
// 建议放在业务路由之前、或仅在非生产环境挂载：
if (process.env.NODE_ENV !== 'production') {
  app.use(createBridgeRouter());
}
```

> 说明：`createBridgeRouter()` 同时兼容已挂载 `express.json()` 和未挂载 `express.json()` 的请求，且对非 `/api/__bridge/*` 请求直接透传 `next()`，对业务接口零影响。

---

## 3. 安装后必须执行的自检步骤

完成文件放置与中间件挂载后：
1. 重启当前项目的开发服务器（确保 3000 端口服务加载了新路由）。
2. 执行状态检查命令：
   ```bash
   node scripts/subagent.mjs status
   ```
3. 验证返回 JSON 中：
   - 接口正常返回 `200`（包含 `"coroutine"` 和 `"tasks"` 字段）；
   - `"connectedClients"` 大于等于 `1`（说明浏览器里的 `Subagent Bridge` 插件已通过 Headless SSE 连上当前项目）。
   - 如果 `"connectedClients"` 为 `0`：提示用户点击右侧 Preview 刷新一下，或打开插件弹窗确认已把当前 AI Studio 标签页设为「主 Agent」。

> **重要安全约束**：自检阶段**只能**运行 `status` / `coroutine` 等只读命令，**严禁在未经用户指令或实际需要前自行调用 `yield` / `dispatch` 触发真实浏览器弹窗/新标签页！**

---

## 4. 协程模式日常使用协议（什么时候用 & 怎么用）

### 4.1 什么时候应该调用 Subagent？
- 需要大范围阅读/检索代码库（避免把大量文件内容塞进主 Agent 上下文）。
- 需要做独立代码审查（Security / Lint / Logic Audit）、架构对比或专项重构方案调研。
- 任务可拆分为多个独立模块检查，希望在干净零历史上下文（`.zero-state`）中验证结论。

### 4.2 什么时候**不要**调用 Subagent？
- 只需要改一两行显而易见的代码或读单个小文件时，直接自己完成更省时。
- 如果在你的子任务里禁止递归调用 `subagent.mjs`（**注意：如果你自己正作为 Subagent Worker 运行，绝对禁止再次调用 `subagent.mjs`!**）。

### 4.3 强制规范：Subagent「4 + 1 任务契约」
调用 `yield` 或 `queue` 启动 Subagent 时，**脚本会在参数校验阶段强制要求填写以下 4 项范围定义（缺失即报错拦截）**，外加第 5 项主 Agent 挂起记忆字段：

1. **`--problem="..."`（问题描述）**：当前遇到了什么问题、上下文背景是什么。
2. **`--intension="..."`（任务内涵）**：真正想要让 Subagent 干的核心目标与交付要求。
3. **`--extension="..."`（任务外延）**：可能涉及的关联模块/周边文件边界（以及哪些无需展开）。
4. **`--non-goals="..."`（非目标）** + **`--forbidden="..."` / `--writable="..."`**：
   - 明确禁止 Subagent 做的事情；
   - **明确指定哪些目录/文件绝对不能改 (`--forbidden`)、哪些目录允许改 (`--writable`)**，若为只读任务则明确声明只读禁止改任何文件。
5. **`--memory="..."`（主 Agent 自留记忆，独立字段）**：
   - 主 Agent 留给**唤醒后的自己**的备忘内容（例如已排查的结论、待验证假设），**不会混入 Subagent 提示词**，而是在子任务全部完成后由插件**强制追加（默认 `--memory-pos=after`，也可设为 `before` 前置）**到 `[COROUTINE_RESUME]` 恢复报文中！

### 4.4 核心调用命令

#### ① 单任务挂起派发（最常用）
```bash
node scripts/subagent.mjs yield \
  --name="代码审计员" \
  --step="阶段1/3：只读排查认证模块与数据库查询" \
  --next="根据审计员定位的文件和行号开始修复问题" \
  --problem="认证接口偶发 401 鉴权失败，需定位校验链漏洞" \
  --intension="只读检查 src/auth 与 src/db 目录下的权限校验逻辑，列出问题文件、行号与修复建议" \
  --extension="可能关联 src/hooks/useAuth.ts 的刷新请求，但不涉及 UI 页面层" \
  --non-goals="禁止修改任何业务代码、禁止重构前端状态、禁止增删依赖" \
  --forbidden="src/components/,src/pages/,package.json" \
  --writable="只读分析，禁止修改或新建任何代码文件" \
  --memory="主 Agent 备忘：已确认前端传参正常，唤醒后直接按审计定位修改后端校验中间件" \
  --close
```

#### ② 一轮挂起串行跑多个 Subagent（批次批处理）
方式 A（多 `--task` 语法，支持共享顶层 `--problem`/`--extension`/`--non-goals` 或 `--task='{...}'` JSON）：
```bash
node scripts/subagent.mjs yield \
  --step="阶段1/3：并行前后端专项排查" \
  --next="汇总前端与后端排查报告并制定修改方案" \
  --problem="前后端鉴权状态存在不同步" \
  --extension="可能涉及 API 响应码与前端拦截器" \
  --non-goals="只读排查，禁止改写代码" \
  --forbidden="server.ts,src/" \
  --writable="只读分析" \
  --memory="主 Agent 备忘：拿到两份报告后决定改造前端拦截器还是后端刷新接口" \
  --close \
  --task="后端排查::只读检查 server.ts 路由鉴权逻辑" \
  --task="前端排查::只读检查 src/hooks/useAuth.ts 状态同步逻辑"
```
方式 B（`queue` + `yield` 组合）：
```bash
node scripts/subagent.mjs queue --name="W1" --problem="..." --intension="..." --extension="..." --non-goals="..." --memory="W1阶段备忘" --close
node scripts/subagent.mjs yield --name="W2" --step="阶段1/3" --next="汇总W1与W2" --problem="..." --intension="..." --extension="..." --non-goals="..." --memory="W2阶段备忘" --close
```
（若长文本不便在 Shell 转义，可使用 `--spec-file="task-spec.json"` 传入标准 JSON 契约。）

#### ③ 参数说明
- `--name="..."`：给子 Agent 命名（如 `审计员`、`前端测试员`），方便结果回填时辨识来源。
- `--step="..."`：**必填习惯**——记录你当前所处的工作阶段（例如 `"阶段2/4：重构支付模块"`），防止多轮唤醒后迷失进度。
- `--next="..."`：**必填习惯**——写清拿到结果后你下一步要做什么，唤醒报文会原样带回给你。
- `--problem` / `--intension` / `--extension` / `--non-goals`：**脚本强制必填**，框定问题边界与禁改红线。
- `--forbidden` / `--writable`：**强烈推荐**——精确限定绝对禁止修改的目录和允许修改的目录。
- `--memory` / `--memory-pos=after|before`：**强推荐**——主 Agent 挂起自留记忆，唤醒时强制追加或前置注入主聊天框。
- `--close`：**强烈推荐**——Subagent 回答完毕并回传结果后自动关闭其标签页，保持浏览器整洁。
- `--focus`（可选）：默认后台静默打开新标签页；加此参数则切到前台显示。

### 4.5 协程调用黄金铁律（必须严格遵守！）

1. **调用 `yield` 后必须立刻停下（Yield & Stop）**  
   `node scripts/subagent.mjs yield ...` 会在 **0.1~0.3 秒内**立即返回成功回执。  
   拿到输出后，你**必须立刻停止调用任何后续工具**，只用一句话告诉用户：
   > “已派发第 X 次 Subagent 调用（当前阶段：...），主 Agent 现挂起等待结果回填唤醒。”
   然后**直接结束当前回复回合**！  
   只有主会话真正停止运行（Idle），Chrome 插件才能安全打开独立空会话执行你的 Subagent，并在结束后把结果填入主聊天框自动唤醒你。

2. **不要在派发后用 `sleep` 或轮询等待**  
   AI Studio 同一工程同时只允许 1 个活跃回合。如果你不结束回合而原地等待，外部标签页会被服务器阻塞无法开启新会话。

3. **识别唤醒报文 `[COROUTINE_RESUME]`**  
   Subagent 执行完毕后，插件会向主聊天框自动发送如下格式的用户消息唤醒你：
   ```text
   [COROUTINE_RESUME | 协程批次 #2 | 累计已调用 Subagent: 3 次]
   📍 主任务当前位置/阶段: 阶段2/4：...
   📋 挂起前预定的下一步动作: ...

   --- 本批次 Subagent 执行结果汇总 ---
   1) [审计员 | 第 3 次调用 | Tab #... | 状态: completed]
   ...

   🧠 [主 Agent 挂起前自留记忆 (强制追加记忆)]:
   <你挂起前写入 --memory 的备忘内容>
   ```
   收到此消息时，结合「当前位置」「预定下一步动作」「自留记忆」与「累计调用次数」继续推进主任务即可。

4. **跨轮次查询与清零**
   ```bash
   node scripts/subagent.mjs coroutine        # 查看当前批次数、累计调用总次数、当前位置与自留记忆
   node scripts/subagent.mjs coroutine-reset  # 开启一个全新无关的大需求前，重置累计计数归零
   node scripts/subagent.mjs tabs             # 查看是否有未关闭的子标签页
   node scripts/subagent.mjs close <目标>     # 关闭指定 tabId / subagentId / 名称的子标签页
   ```

---

## 5. 常见异常快速排障

| 现象 | 原因 | Agent 处理建议 |
| :--- | :--- | :--- |
| `connectedClients: 0` | Preview 尚未刷新或插件未加载 | 请用户刷新 Preview 面板；确认浏览器中已启用 `Subagent Bridge` 扩展 |
| 派发后长时间未唤醒 | 主 Agent 调用 `yield` 后未立刻结束回合，或者未在插件登记主标签页 | 确认结束回合不再运行任何工具；让用户点一下浏览器插件图标确认「主 Agent 标签页」状态为绿色 `Idle` |
| 子任务提示工作区文件未同步 | Subagent 和你在同一个项目目录下工作 | 若要让 Subagent 看最新代码，确保在派发前已保存好修改到磁盘 |
