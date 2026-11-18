# T07 — MCP Task Cancellation：生命周期、AbortSignal 传播与资源清理

> 状态：**Phase A（只读审查）已完成 / Phase B（方案确认）待批准**
> 审查基线：`main` @ `0c85ccd`，`vino-godot-mcp@1.2.3`
> 本文件只描述现状与计划，Phase A 期间未修改任何生产代码。

---

## 1. 核实结果（先验证，再设计）

| 待核实项 | 结论 | 证据 |
|---|---|---|
| MCP SDK 版本 | `@modelcontextprotocol/server` **2.2.0**（v2，MCP 2026-07-28；非 v1 的 `@modelcontextprotocol/sdk`） | `node_modules/@modelcontextprotocol/server/package.json` |
| 是否提供 `ctx.mcpReq.signal` | **是**。`ServerContext.mcpReq.signal: AbortSignal`，每个请求独立创建 | `dist/createMcpHandler-*.d.mts:2180-2182`；server `src-*.mjs:6499-6501` |
| 信号生命周期 | 请求进入时创建 → 收到 `notifications/cancelled` 或连接关闭时 `abort(reason)` → 响应发送后从 `_requestHandlerAbortControllers` 删除 | `src-*.mjs:6331`（abort）、`:6500`（创建）、`:6556`（删除） |
| 客户端如何触发 | `client.callTool(params, { signal })` 中止 → 协议层发出 `notifications/cancelled` → 服务端 signal abort | 本地探针实测（见 §7-E1） |
| 取消后 SDK 行为 | `if (abortController.signal.aborted) return;` —— **不再发送响应**，客户端侧抛 `SdkError`（reason 即 abort reason） | `src-*.mjs:6527`（成功路径）、`:6543`（错误路径） |
| 工具回调是否拿得到 ctx | **拿得到**：`registerTool(name, cfg, cb)` 的 `cb(args, ctx)`。当前 `sdkServer.ts:44` 只用了第一个参数 | `createMcpHandler-*.d.mts:3519`（`ToolCallback`） |
| Node 运行环境 | **v22.22.2**，`AbortSignal.any()` / `AbortSignal.timeout()` 均可用（Node ≥20.3） | `node -e process.version` |
| TaskQueue 现有 AbortController | 一任务一个，但**仅在 `runTimeoutMs` 超时路径使用**；创建于加锁之后，`finally` 只清 timer 与释放锁，从不 abort、从不 retain | `taskQueue.ts:27, 30-44` |
| 现有取消/超时语义 | 超时 = `reject` **先于** `abort`（注释明说为了让错误抢先返回），随后 `finally` 立刻释放队列位 | `taskQueue.ts:31-43` |

---

## 2. 真实生命周期（按代码绘制，未按理想图改写）

```text
tools/call 请求到达 (SDK)
        │  ctx.mcpReq.signal 创建，并注册到 _requestHandlerAbortControllers
        ▼
ToolHost.callTool(name, args)                 ← 无 signal 参数（现状）
        │  权限检查 → 参数校验
        ▼
tool.handler(args, ctx)                        ← 69 个 handler 签名统一 2 参数
        ▼
Service (runtime / validation / godotApi)
        ▼
TaskQueue.runExclusive(project, owner, fn, {runTimeoutMs})
        │  locks.acquire(key)  ← 排队阶段没有任何取消手段
        ▼
   Controller Created (ctrl = new AbortController())
        │
        ▼
   Task Running  ── fn(signal) ─→ defaultRunRunner → Godot 子进程
        ├── fn resolves ─────────→ Completed ─→ finally: clearTimer + release(lock)
        ├── fn rejects   ─────────→ Failed    ─→ finally: clearTimer + release(lock)
        └── runTimeoutMs 到点 ────→ Timeline:
                                     reject(TASK_TIMEOUT)   ← 先
                                     ctrl.abort()           ← 后（同步触发 fn 内 kill）
                                     finally: release(lock)  ← 立即，不等子进程 close
                                     child SIGKILL → close 事件 → fn 的 Promise 才 settle（无人等待）

   客户端取消（现状）：
   notifications/cancelled → ctx.mcpReq.signal.abort() → SDK 丢弃响应
                             ↑ 到这里就断了：TaskQueue / 子进程完全不知情
```

现状一句话总结：**取消信号在 MCP 层就终止了，TaskQueue 的 AbortController 只服务超时，两者之间没有连接。**

---

## 3. 问题清单

### P0 — 阻断级（会导致"假取消"或误判）

| # | 问题 | 位置 | 后果 |
|---|---|---|---|
| P0-1 | 请求取消无法传达到执行层 | `sdkServer.ts:44`、`toolHost.ts:57`、`taskQueue.ts:18` | 客户端取消后 Godot 进程继续跑满 timeout，白烧 CPU/内存 |
| P0-2 | abort 与 timeout 共用同一标志 | `run.ts:145-153`（`kill()` 无条件 `timedOut = true`） | 取消会被报成 `TASK_TIMEOUT`（且 `retryable=true`），AI 会误判为"慢"而重试，反而再起一次 Godot |
| P0-3 | 超时路径"先 release 后收尸" | `taskQueue.ts:31-43` | 锁已释放、下一个任务已开始，旧进程可能仍在写 `.godot`/场景文件 |
| P0-4 | 无 `CANCELLED` 语义 | `types/index.ts:4-24`、`errors.ts:7-47` | 取消只能落进 `GODOT_PROCESS_FAILED` 或 `TASK_TIMEOUT`，污染失败统计 |

### P1 — 正确性 / 资源

| # | 问题 | 位置 | 后果 |
|---|---|---|---|
| P1-1 | 排队阶段不可取消 | `lockManager.ts:39-56` | `waitTimeoutMs` 之外的等待只能干等；客户端取消后仍会抢到锁并启动进程 |
| P1-2 | 子进程 kill 后无退出确认 | `processAdapter.ts:63`（`stop` 不 await exit）、`run.ts:150-153` | 只发 SIGKILL 就返回；`kill` 失败时 Promise 可能永久悬挂 |
| P1-3 | abort 监听器未在"未启动"分支清理 | `run.ts:150-153` 与 `:160/168` 的 removeEventListener 成对性 | 提前 aborted 走 `kill()` 但 listener 从未 add，属良性；但若后续改写容易漏 |
| P1-4 | 取消后临时产物残留 | `runtimeService.ts:255-325`（`shot-*.png`） | 取消的截图任务留下 PNG；`withTempScript` 已用 `finally` 清理 `.gd`，PNG 没有 |
| P1-5 | `project_validate` 串行 N 次 spawn 无中断点 | `projectValidationService.ts:52-56` | 大工程要跑几分钟，中途取消无从插入 |
| P1-6 | ClassDB dump 被多个工具隐式触发 | `godotApiService.ts:386-459`（`load`→`dump`，60s） | 取消 `class_get_info` 后 dump 继续，缓存目录里可能留半成品（`finally` 已删 `produced`，可接受） |

### P2 — 语义/可观测

| # | 问题 | 位置 | 说明 |
|---|---|---|---|
| P2-1 | `TaskQueue` 无取消原因（request vs timeout） | `taskQueue.ts` | 需区分两种 abort 来源，才能给出正确 code |
| P2-2 | 取消被记录成 "Unhandled error" | `toolHost.ts:69` | 若 handler 抛非 `GodotMcpError` 的 AbortError，会被当 bug 打日志 |
| P2-3 | `AppContext` 是单例共享 | `context.ts:28-67` | **绝不能**把 signal 挂在 AppContext 上，否则并发请求串扰（这正是要避免的） |
| P2-4 | 会话进程按设计不随请求取消 | `runtimeSessionManager.ts:60-92` | `runtime_start_session` 成功后进程本就该存活；取消只应停止"等待"，不该杀会话 |

---

## 4. 最小改造方案（Phase B）

### 4.1 传播链

```text
Client notifications/cancelled
        ▼
ctx.mcpReq.signal                       (SDK，已存在)
        ▼
sdkServer: host.callTool(name, args, { signal: ctx.mcpReq.signal })
        ▼
ToolHost.callTool(name, rawArgs, exec?) → tool.handler(args, ctx, exec)
        ▼                                   （仅长任务 handler 声明第 3 参数）
Service 选项 signal?: AbortSignal
        ▼
TaskQueue.runExclusive(..., { signal }) → 链接到任务级 ctrl
        ▼
defaultRunRunner(..., { signal }) → SIGKILL → await close
```

三层信号的关系：

- **请求级**：`ctx.mcpReq.signal`，SDK 拥有，一个请求一个；
- **任务级**：`TaskQueue` 内 `new AbortController()`，一个任务一个，用于统一"请求取消 + 超时"两种来源；
- 用 `AbortSignal.any([request, ctrl.signal])` **不需要**——因为任务级 ctrl 已经由请求级 abort 主动触发（`ctrl.abort(reason)`），只需在 `finally` 里 `removeEventListener`，避免闭包持有过期 signal。这样每任务信号天然独立，不会串扰。

### 4.2 类型/方法新增（全部为可选参数，不破坏既有调用）

| 位置 | 新增 |
|---|---|
| `types/index.ts` | `ErrorCode` + `"TASK_CANCELLED"`；`ErrorCategory` + `"cancelled"`；`interface ToolExecutionContext { signal?: AbortSignal }`；`ToolDefinition.handler(args, ctx, exec?: ToolExecutionContext)` |
| `core/errors.ts` | `CATEGORY.TASK_CANCELLED = "cancelled"`；不进 `RETRYABLE`（取消不可重试） |
| `core/concurrency/cancellation.ts`（新） | `cancelledError(operation, reason)`、`throwIfAborted(signal, operation)`、`abortReasonText(signal)`；集中构造 `TASK_CANCELLED`，保证 `cause`/`details` 一致 |
| `core/concurrency/lockManager.ts` | `AcquireOptions.signal?: AbortSignal`：等待中被 abort → 从队列移除 + `reject(TASK_CANCELLED)`；已持锁则正常返回，由调用方立即 `throwIfAborted` |
| `core/concurrency/taskQueue.ts` | `RunOptions.signal?: AbortSignal`；内部记录 `abortSource: "request" \| "timeout"`；进入前已 abort → 直接抛 `TASK_CANCELLED`（不占锁）；`fn` 返回后若已 abort → 丢弃结果抛 `TASK_CANCELLED`；`finally` 里 `removeEventListener` + 释放锁 |
| `godot/runtime/run.ts` | `RunProcessResult.aborted: boolean`；abort → `SIGKILL` + `aborted=true`（`timedOut` 不再被污染）；kill 后 `KILL_GRACE_MS` 未退出 → 明确 `exitConfirmed:false` 并释放监听 |
| `services/runtimeService.ts` | 各 Options + `signal?`；`execute` 透传；`res.aborted` → `TASK_CANCELLED`；取消时删除未完成的截图 PNG |
| `services/projectValidationService.ts` | Options + `signal?`；每个脚本前 `throwIfAborted`（脚本之间是可安全中断点） |
| `services/godotApiService.ts` | `getClassInfo(projectPath, nodeType, signal?)` 等末位可选参数，透传到 `load/dump`；dump 前后清理半成品（已有 `finally`，仅补 abort 分支） |
| `mcp/server/toolHost.ts` | `callTool(name, rawArgs, exec?)`；handler 第 3 参数；`TASK_CANCELLED` 不记 error 栈 |
| `mcp/server/sdkServer.ts` | 传入 `{ signal: ctx.mcpReq.signal }`；**该文件是唯一接触 SDK 的地方，保持不变** |
| 8 个长任务 handler | `runtime_run_project`、`runtime_run_scene`、`runtime_export_project`、`runtime_capture_screenshot`、`runtime_inspect_ui`、`runtime_visual_debug`、`project_validate`、`class_get_info` |

> 数量对比：**8 / 69**。其余工具（纯文件解析、`.tscn` 读写、权限检查）单次执行在毫秒级，不接入，也不改动。

### 4.3 长任务可中断性分级（先分级，再接入）

| 操作 | 可安全中断 | 中断后残留 | 底层是否支持取消 | 结论 |
|---|---|---|---|---|
| `runtime_run_project` / `run_scene` | 是 | 无（`--quit` 是只读冒烟；非 quit 模式可能停在任意点，但进程已杀） | SIGKILL 生效，需等 `close` | **接入**，取消 = 杀进程 + 等退出 |
| `runtime_export_project` | 是 | **可能留下半个导出文件** | 同上 | **接入**，取消后删 `outputPath`（仅当本次新建/我们在写） |
| `runtime_capture_screenshot` | 是 | 临时 PNG | 同上 | **接入**，取消即删 PNG |
| `runtime_inspect_ui` | 是 | 无（只读） | 同上 | **接入** |
| `runtime_visual_debug` | 是 | 两段串行：第一段取消则第二段不启动 | 同上 | **接入**，段间检查 |
| `project_validate` | 是 | 无（`--check-only` / `--quit`） | 逐脚本之间 | **接入**，脚本级检查点 |
| ClassDB dump（`class_get_info` 等） | 是 | 缓存目录半成品 | 同上 | **接入**（`finally` 已清理） |
| `runtime_start_session` | **否（按设计）** | 会话本应存活 | 无 | **不接入**：明确记录"启动不可取消；用 `runtime_stop_session` 结束" |
| Editor Bridge 调用（`editor_*`） | 部分 | 编辑器侧可能已执行 | TCP 请求无取消 | **不接入**：文档标注限制 |
| 纯文件解析/写入（scene/script/resource/shader） | 毫秒级 | — | — | **不接入** |

### 4.4 状态语义（兼容现有，仅补 2 个状态）

`RuntimeSessionState` 已有 `starting|running|stopping|exited|failed|timed_out`，保持不动。
任务侧不引入新的持久任务表（现状没有任务记录实体，锁快照即"任务视图"），只补任务结果语义：

| 状态 | 现有表达 | 本阶段 |
|---|---|---|
| pending | 锁队列中的 waiter | 复用；新增"等待中可取消" |
| running | 锁 holder | 复用 |
| completed | `fn` resolve | 复用 |
| failed | `fn` reject | 复用 |
| cancelling | — | **新增**（仅日志/诊断字段 `abortSource`，不做持久状态机） |
| cancelled | — | **新增** `TASK_CANCELLED` 结果 |

### 4.5 错误语义

```text
code:      TASK_CANCELLED
category:  cancelled        （新增分类，第 10 类）
retryable: false            （用户主动取消，重试没有意义）
message:   "Task runtime_run_project was cancelled by the client"
details: {
  operation: "runtime_run_project",
  abortSource: "request" | "timeout",     ← timeout 仍走 TASK_TIMEOUT
  stage: "queue" | "running" | "cleanup",
  signalReason?: string,
  cleanup?: { processExitConfirmed: boolean, pid?: number, residual?: string[] }
}
```

- `TASK_TIMEOUT` 保留原义与 `retryable: true`，**不与取消混用**；
- 清理失败时：`details.cleanup` 携带残留诊断，`message` 仍以取消原因为主（不覆盖），并 `logger.warn` 一条 `cancel-cleanup-failed`；
- `ToolHost` 对 `TASK_CANCELLED` 不打 `INTERNAL` 堆栈（避免污染 bug 统计）。

### 4.6 资源清理策略

1. **统一 `try/finally`**：`TaskQueue`（锁 + listener + timer）、`withTempScript`（已有）、`dump`（已有）、`captureScreenshot`（补 PNG）、`exportProject`（补输出文件）。
2. **子进程终止策略**：`SIGKILL` → 等 `close` → 若 `KILL_GRACE_MS`(3000) 未退，标记 `processExitConfirmed:false` 并解除监听（不谎报成功）。
3. **只杀本任务子进程**：句柄由 `ProcessAdapter.start` 返回，绝不用 `taskkill /IM godot.exe` 之类按名字杀。
4. **取消后不再落盘**：`TaskQueue` 在 `fn` 返回后再次检查 aborted，丢弃结果；写文件类工具本身不接入取消，保持原子写语义。
5. **不触发成功回调**：SDK 已丢弃响应；`TaskQueue` 再兜一层，避免"取消后 ok:true"。
6. **清理互不影响**：每任务独立 ctrl / 独立 handle / 独立 finally。

### 4.7 测试计划（Mock 与真实分离）

| 文件 | 类型 | 覆盖 |
|---|---|---|
| `tests/taskQueueCancellation.test.ts` | Mock（无引擎） | 正常完成、执行中取消、等待中取消、重复取消、取消已完成任务、并发独立取消、状态与锁快照清理、listener 清理、超时 vs 取消 |
| `tests/abortPropagation.test.ts` | 进程内 + InMemoryTransport | `ctx.mcpReq.signal` → handler → TaskQueue → runner；已取消 signal 不被忽略；多任务不串扰；正常完成不触发取消 |
| `tests/runtimeCancellation.test.ts` | Mock runner | 运行中取消、取消后不再执行后续步骤、`aborted` 结果映射、不支持中断时的限制报告 |
| `tests/cancelCleanup.test.ts` | Mock adapter + 真实短命子进程（`node -e` 长睡） | 子进程退出确认、stdout/stderr 监听释放、临时文件清理、finally 执行、清理失败诊断 |
| `tests/cancelDiagnostics.test.ts` | Mock | `cancelled` vs `failed` vs `timeout` 的 code/category/retryable、错误统计不污染、既有结构化错误回归 |
| `tests/runtime.cancel.real.test.ts` | **真实 Godot**（可选 CI 标记） | 真实长任务取消后子进程确实退出 |

> 明确区分：前 5 个是 Mock/进程内测试，**不能**等同于真实引擎验证；真实引擎只在最后一个文件（沿用仓库现有 `*.real.test.ts` 约定）。

---

## 5. 明确不做（约束对照）

- 不重写 `TaskQueue`，只加可选 `signal` + abort 来源标记；
- 不改 69 个 handler，只动 8 个长任务；
- 不引入新调度框架、不引入全局 signal 注册表（避免 P2-3 串扰）；
- 不改 `TaskQueue` 的对外契约（`runExclusive` 参数只增不改）；
- 不改权限体系、`ToolResult` 信封结构、既有 `ErrorCode` 命名；
- 对不可取消的操作（session 启动、editor bridge）**明确标注限制**，不伪装支持。

---

## 6. 待确认事项

1. **超时路径是否一并修 P0-3**（先 abort 等子进程退出，再释放锁）？会改变 `TASK_TIMEOUT` 的返回时机（最多多等一次 `close`，通常 <100ms），但能避免"锁已释放、旧进程还在写"。
2. **`runtime_export_project` 取消后是否删除半成品导出文件**？删除更干净，但若 `outputPath` 原本就有旧文件，需要"仅删本次新建"的判定。
3. `TASK_CANCELLED` 还是 `CANCELLED` 命名（我倾向 `TASK_CANCELLED`，与 `TASK_TIMEOUT` 成对）。
4. 真实引擎回归测试是否纳入默认 `npm test`（现有 `*.real.test.ts` 已在默认套件里，我倾向保持一致）。

---

## 7. Phase C 实施记录（写完代码之后回填的真实状态）

### 7.1 落地清单

| 类别 | 文件 |
|---|---|
| 新增 | `src/core/concurrency/cancellation.ts`（`InterruptAwareError` / `TaskCancelledError` / `TaskTimeoutError` / `throwIfAborted` / `attachCleanup`） |
| 新增 | `src/services/exportStaging.ts`（staging → commit，正式路径全程不被触碰） |
| 改造 | `taskQueue.ts`、`lockManager.ts`、`run.ts`、`processAdapter.ts`、`toolHost.ts`、`sdkServer.ts`、`runtimeService.ts`、`godotApiService.ts`、`projectValidationService.ts`、`types/index.ts`、`core/errors.ts` |
| 接入取消的 8 个长任务 | `runtime/runProject.ts`、`runScene.ts`、`exportProject.ts`、`captureScreenshot.ts`、`inspectUi.ts`、`visualDebug.ts`、`project/validate.ts`、`class/metadata.ts`（仅 `class_get_info`） |
| 测试 | 新增 6 个文件 40 个用例；修改 `runtime.test.ts`、`runtimeSessionManager.test.ts`、`errorDiagnostics.test.ts` |

`git diff --stat`：22 files changed, 603 insertions(+), 110 deletions(-)（另含 9 个新文件未计入）。

### 7.2 与 Phase B 设计的一处偏离（真实引擎测试逼出来的）

`RunProcessResult.aborted` 原本的语义是"取消后 resolve 一个 `aborted: true` 的结果"。真实引擎测试证明这条契约会**丢证据**：

1. `run.ts` 在 `close` 之后 resolve `{ aborted: true, exitConfirmed: true, pid }`；
2. `TaskQueue` 的"取消与成功赛跑"分支（`abortSource === "request"` 时不允许返回 value）把它替换成一个**新建的** `cancelledError`，`pid` / `exitConfirmed` / 输出全部丢失；
3. 该错误一旦携带 `pendingExit`，`release()` 会被推迟，而 `TaskQueue` 判断 `pendingExit` 依赖的正是被替换掉的那个错误 —— 细节还会影响"能不能确定是否需要延迟放锁"。

修复（`run.ts`，唯一的语义变更）：进程确认退出之后，取消走 **reject**（`TaskCancelledError` 带 `cleanup.processExitConfirmed: true` + `pid` + 输出 + `exitCode`），`resolve` 一律代表成功。`TaskQueue` 的 `mapInterrupt` 对 `TaskCancelledError` 原样保留，证据完整到达工具层。`runtimeService` 里 `res.aborted` 的分支保留为兜底（注入的 runner 违约时也不许报成功），并由 `runtimeCancellation.test.ts` 覆盖。

### 7.3 真实引擎验证结果（单独执行，不代表 Mock 结果）

环境：`Godot_v4.7.2-stable_win64.exe`，`GODOT_BIN` 显式指定。

| 用例 | 结果 | 观察到的证据 |
|---|---|---|
| 取消正在运行的 Godot | **pass** | `TASK_CANCELLED`、`abortSource=request`、`cleanup.processExitConfirmed=true`、`cleanup.pid` 为数字；耗时约 2.8s；`locks.snapshot()` 为空；随后同项目再跑一次 `--quit` 正常 `exitCode 0`（引擎仍健康） |
| 执行超时 | **pass** | 仍是 `TASK_TIMEOUT`，`details.timeoutMs=3000`，未被取消语义污染 |
| 回归：`runtime.real` / `runtime.inspectUi.real` / `runtime.checkAddonStatus.real` | **15/15 pass** | 我改动的导出/截图/UI 检查路径在真实引擎下无退化 |

取消测试跑完后 `Get-Process *odot*` 无任何残留进程。

### 7.4 未覆盖 / 已知限制（不粉饰）

1. **真实导出取消未验证**：本机导出模板是 `4.6.stable`，引擎是 `4.7.2`，`--export-release` 在模板匹配阶段就会失败，无法制造"导出进行中被取消"的场景；该路径由 Mock（`runtimeCancellation.test.ts` 的 staging 用例）+ 纯文件系统逻辑（`exportStaging.ts`）覆盖。
2. `runtime_start_session` 不接取消（会话按设计持续存活，取消等于杀会话，属于另一件事）。
3. `editor_*`（TCP 桥）不接取消：协议层没有请求 id 可对应，只能等超时。
4. Windows 上 `SIGKILL` 即 `TerminateProcess`，**不会**清理 Godot 自己 spawn 的子进程树；本任务只杀自己持有的 PID（不按名字杀，避免误伤）。
5. 宽限 `CANCEL_GRACE_MS=30000`、硬上限 `EXIT_CONFIRM_HARD_CAP_MS=120000`：超过宽限会上报 `processExitConfirmed:false` 并**继续持锁**，也就是"同项目的新任务会排队等它"，这是刻意选择（宁可等，不并发写同一个工程）。
