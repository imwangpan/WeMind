# 方案 C MVP：远程 human-in-the-loop（受控 ACP 工作机）

> 状态：**MVP 已实现** ✅（2026-06-17，真机端到端跑通：派发 → 列方案 → 无前缀注入续跑 → `任务：` explicit 注入 → `问大脑` 逃逸 → `结束任务` 清理 → typing 全程）。
>
> **历史/设计说明（2026-10-24 补）**：文中「`session/load` 恢复」只适用于**支持 load** 的 agent；当前 worker 对不支持者会退化为 `session/resume`，再失败则新建会话。接入新 agent 时以实际能力为准。
> 关联：[方案C-受控ACP工作机设计.md](方案C-受控ACP工作机设计.md)（总设计）、`packages/wechat-daemon/src/{index,acp-brain,brain-agents}.ts`。
> 目标用户故事：**在电脑上派发一个漫长任务后离开；任务在「列方案让我选」或「中断需要继续」时把情况推到微信，我在微信回一句即可让它续跑。**
> 术语：**MVP**（Minimum Viable Product，最小可行产品）——先用最小功能集做出能跑通、验证核心价值的第一版，增强功能往后放。本文的「方案 C MVP」即只做核心闭环（派发 → worker 执行 → 卡点推微信 → 回复注入续跑 → 结束任务），暂不做本地命令派发 / 本地看敲视图 / 多任务并发 / worker 发图等增强。

---

## 1. 聚焦的需求

不是「把电脑上 kiro 的全部输出实时镜像到微信」，而是更聚焦的 **human-in-the-loop（人在回路）的远程化**：

- 漫长任务自己跑，平时不打扰人；
- 只在两个时刻找人：① 任务**主动征询**（列出多种方案让你选 / 问要不要继续）；② 任务**异常中断**（崩溃 / 卡死，需要你发「继续」）；
- 人在微信收到这些时刻的内容，**回一句指令**（选哪个 / 继续 / 追加要求），让电脑上的 kiro 接着干。

由此带来的简化：**不需要解析面向人眼的 TUI 字符流**，只需在「一轮结束」时把那一段结构化输出推给微信。

---

## 2. 核心模型：worker = 独立的多轮对话 agent

把「工作机」看成一个**独立的、跑在任务目录里的多轮对话 agent**，它和现有「对话大脑（brain）」是两个互不干扰的 ACP 进程：

```
派发任务  = 给 worker 发第 1 个 prompt（任务描述）
一轮结束  = worker 这一轮 ACP 响应完成 → 把本轮输出推微信
微信回复  = 给 worker 发下一个 prompt（注入）→ 又一轮 → 再推送 …
任务中断  = worker 进程退出/超时 → 推微信告警 → 用户回「继续」→ session/load 恢复后续跑
```

关键洞察：现有 `acp-brain.askBrain(userId, msg, onProgress)` 的语义恰好就是「发一个 prompt、等这一轮结束、返回拼接文本」——**这正是「一轮」的天然单元**。worker 的派发与注入，本质都是对 worker 版 `askBrain` 的调用；每次调用的返回值，就是要推给微信的「决策请求 / 阶段结果」。

为什么 ACP 模式天然适配：agent 每响应完一轮就**明确进入「等待下一条指令」**状态，daemon 一清二楚，无需靠抓屏去猜「它是不是在等我」。

---

## 3. 架构总览

```
                ┌─────────────────────────── daemon ───────────────────────────┐
微信(用户) ⇄ iLink ⇄ │  pollerLoop ──(入队)──► msgQueue ──► workerLoop（瞬时路由）   │
                │                                          │                      │
                │   普通对话 ─────────────────────────────►  handleMessage → brain │
                │   任务：xxx / 注入 / 结束任务 ───────────►  TaskManager           │
                │                                          │   ▲ 不 await 长执行    │
                │                                          ▼   │                    │
                │                              runTask（后台异步）──► worker-acp     │
                │                                  │  askWorker(prompt) 一轮          │
                │                                  └─ 轮次结束/中断 ─► 发送层 ─► 微信 │
                └───────────────────────────────────────────────────────────────────┘
```

- **brain**（`acp-brain.ts`）：日常对话，`handleMessage` 同步处理。**保持不变**。
- **worker**（新 `worker-acp.ts`）：跑漫长任务，独立 ACP 进程 / 独立会话 / 独立沙箱。
- **TaskManager**（新，在 daemon 内）：维护单个活跃任务的状态机，`runTask` 在后台异步推进，`workerLoop` 只做**瞬时路由**（派发 / 注入 / 停止），绝不 await 长执行。

---

## 4. 关键流程

### 4.1 派发
```
微信:「任务：抓取并核实文章 X，结果写进笔记」
 → workerLoop 识别任务派发前缀
 → 若已有活跃任务：提示「已有任务在跑，先回复『结束任务』」
 → 否则：void runTask(taskId, 指令, to)（后台异步，立即返回）
 → 立即回执:「✅ 已派给工作机执行（任务运行中）。它需要你决策或中断时会主动找你。」
```

### 4.2 一轮结束 → 推送
```
runTask: const out = await askWorker(taskId, 指令, onProgress)   // 阻塞几分钟，但在后台
 → 推送 out 给微信（worker 在问你 / 给阶段结果）
 → status = "waiting"，等待用户注入
```

### 4.3 注入续跑
```
微信:「用方案 B，数据源优先国内可达的」
 → workerLoop 发现有 waiting 中的任务 → 喂给该任务（resolve 注入 promise，不 await）
 → runTask: status = "running"，instruction = 注入内容 → askWorker(注入) → 下一轮 → 4.2
```

### 4.4 中断与恢复
```
askWorker 抛错（进程退出 / idle / cap 超时）
 → 推送:「⚠️ 任务中断了（原因）。回复『继续』我从中断处恢复，或『结束任务』终止。」
 → status = "waiting"
用户回「继续」→ askWorker("继续")；worker-acp 内部 reset 后下次 ensureSession 走 session/load 恢复上下文
```

### 4.5 结束
```
微信:「结束任务」→ TaskManager.stop()：杀 worker 进程、清状态、回执「🛑 任务已结束」
```

---

## 5. 消息路由与状态机

### 5.1 路由（在 `workerLoop` 内，`parseControl` 之后、`handleMessage` 之前）

按优先级判断每条出队消息：

| 优先级 | 条件 | 动作 |
|---|---|---|
| 1 | `parseControl` 命中（mcp / 新会话 / 加载…） | 走 `handleControl`（brain 控制，保持） |
| 2 | `结束任务` / `停止任务` / `/stop` | **停止**当前任务 |
| 3 | **明确发 worker**：`任务：` / `task:` / `>` 前缀（**只有这三种**；`任务 ` + 空格**不是**有效前缀——`parseTaskControl` 要求冒号，避免把「任务很重要」这类正常对话误判为派发） | 无活跃任务 → **派发**新任务；有 → **注入/追加**（waiting 喂下一轮、running 暂存） |
| 4 | **明确问大脑**：`问大脑` / `问大脑：` 前缀 | 去前缀 → 强制走 `handleMessage`（brain），即使 worker 在等你 |
| 5 | 无前缀 ＋ worker 处于 **waiting**（刚问你、在等你回）＋ 非图片 | 作为**注入**喂 worker |
| 6 | 其余（running / 无任务 / 图片消息） | 走 `handleMessage`（brain 对话） |

**核心**：
- **状态分流**——worker 只在 waiting（刚停下问你）时才默认接管你的无前缀消息；running（埋头跑）时大脑照常可用，互不干扰。
- **三种明确性**——`任务：`/`>` 强制发 worker、`问大脑` 强制发 brain、无前缀按 worker 状态。
- worker 每轮输出带 `🤖【任务】` 来源标记，一眼可辨。
- 图片消息始终走 brain（worker MVP 不收图）。

### 5.2 任务状态机（单任务 MVP）

```
        派发                askWorker 返回
 idle ────────► running ──────────────────► waiting
   ▲              ▲  │ askWorker 抛错            │
   │              │  └──────────► waiting ◄──────┘
   │  stop        │      注入(或暂存的 pendingInject)
   └──────────────┴───────────────────────────────
```

- `running`：worker 正在跑一轮。此时若用户来消息 → **暂存为 `pendingInject`**（只留最近一条，新的覆盖旧的）并回执「任务执行中，已记下，等它停下来会处理」；下次进入 waiting 时若有 pendingInject 直接消费。
- `waiting`：等用户注入。收到注入即 `running`。
- `stop`/完成：回 `idle`，清状态。

状态对象（约）：
```ts
type ActiveTask = {
  taskId: string;
  to: string;                 // 用户 userId
  status: "running" | "waiting";
  injectResolver?: (text: string) => void;  // waiting 时等待注入
  pendingInject?: string;     // running 期间暂存的注入
};
let activeTask: ActiveTask | null = null;   // MVP 单任务
```

---

## 6. worker-acp.ts（复用 acp-brain，约 70% 复制）

复制 `acp-brain.ts` 的 JSON-RPC over stdio 客户端，**独立模块状态**（独立 `child` / `pending` / 单一 session），改造点：

| 项 | brain | worker |
|---|---|---|
| 进程 | 全局单例 1 个 | 独立单例 1 个（与 brain 并存，互不影响） |
| 会话 | 每用户一 session（`userSessions` Map） | **单任务一 session**（MVP 单任务，一个 sessionId） |
| 会话持久化 | `brain-sessions.json` | `worker-sessions.json` |
| cwd | `BRAIN_HOME` 沙箱 | **任务工作目录**（按 kiro 约定，见 §8.3；`WEMIND_WORKER_CWD` 可覆盖） |
| 沙箱 home | `BRAIN_HOME`（默认空 MCP，按需加载） | 独立 `WORKER_HOME`：**继承真实 ~/.kiro 全部 MCP（仅排除 `wechat` 防回环）** + 记忆/技能/规则 + settings(模型/信任) |
| 超时 | idle 120s / cap 15min / 首帧 25s | 可更宽松（漫长任务），env 可调 |
| agent | `resolveAgent()`（kiro acp --trust-all-tools） | **复用同一 `resolveAgent()`** |

对外接口（约）：
```ts
askWorker(taskId, instruction, onProgress?) → Promise<string>  // 发一轮、等结束、返回输出（含失败抛错）
stopWorker() → void                                            // 杀进程、清状态
isWorkerAlive() → boolean
```

> 复用而非参数化 acp-brain 的理由：两者超时策略、cwd、沙箱、会话粒度都不同；强行参数化会让本就微妙的单例状态更难维护。复制后各自演进更安全（与里程碑 24 文档 §6 估算一致）。

---

## 7. 与现有代码的复用与改动点

**复用（不改）**：
- 发送层 `sendOrdered` / `reply`（ret=-2 退避重试）/ `sendMdOrdered`（长回复转 md）；
- 连续发送上限 `budgetOf`（worker 推送同样过它，但 worker 一轮通常只推 1 条，几乎不触发上限）；
- 鉴权 `isAuthorized`（poller 已对所有入队消息鉴权）；
- 最新 token `state.contextTokens[\`${botId}:${userId}\`]`（worker 推送时取，规避 -2）；
- `brain-agents.resolveAgent()`、`mcp-sandbox` 的沙箱构建机制（泛化出 worker 版 home）。

**改动 / 新增**：
1. 新增 `worker-acp.ts`（§6）。
2. 新增 `task-manager.ts`（或并入 index）：`ActiveTask` 状态机 + `runTask` 后台循环 + `dispatchTask` / `injectTask` / `stopTask`。
3. `index.ts` 的 `workerLoop`：插入 §5.1 路由分支（瞬时，不 await 长执行）。
4. worker 推送复用发送层：`pushToUser(to, text)` = 取 `latestToken(to)` → `sendOrdered(...)`。
5. 新增 env（§10）。

> ⚠️ 绝不在 `workerLoop` 里 `await runTask`/`await askWorker`——否则长任务会阻塞 poller 入队消息的处理（含用户的注入回复），整个机制失效。`runTask` 必须 `void` 掉、后台跑；`workerLoop` 只 resolve 注入 promise。

---

## 8. 关键设计决策（含 MVP 取值）

1. **派发入口** ✅ 已确认（2026-06-17）：MVP 用**微信「任务：xxx」**（零额外 IPC，最快闭环）。本地命令派发（`manage.js task "..."`，贴合「电脑上开启任务」原场景）为**紧接着的下一步**——本地 CLI 写任务文件、poller 顺带扫描启动（轻量文件桥）。
2. **单任务 vs 多任务**：MVP **单任务**（一个 activeTask）。多任务（多 worker 进程 + 任务标识）后续。
3. **worker cwd（按 kiro 约定）** ✅：MVP 微信派发无「用户所在目录」概念 → 默认用户主目录（`WEMIND_WORKER_CWD` 可覆盖）；任务用绝对路径仍可访问任意项目。下一步本地命令派发时取「执行派发命令时所在目录」为 cwd——与本地开 kiro 完全一致（真正的 kiro 约定）。
4. **worker 继承（按用户确认：尽可能继承 kiro 的一切）** ✅：独立 `WORKER_HOME`，**继承真实 ~/.kiro 的全部 MCP，仅排除 `wechat`（防回环，技术必然，同坑①）**；同时继承记忆/技能/规则（steering/memories/skills/agents/powers/tasks/extensions）与 settings（含模型 `claude-opus-4.8`、信任配置）；会话独立（`worker-sessions.json`）。**与 brain 的差异**：brain 是对话助手，默认空 MCP、对话中按需「加载 X」；worker 无人值守跑任务，故**默认全继承**（开箱即用的完整工具能力）。实现复用 `mcp-sandbox` 的 `mirrorRealKiro`/`syncSettings`，MCP 由「复制 catalog 全量 − 排除集」生成（而非 brain 的「空 + 激活集」）。
5. **进度反馈**：文字 **默认安静**——只在「轮次结束 / 中断 / 派发回执」推送文字（正合「只在卡点找我」，也避开连续发送上限）；但 worker 跑每一轮期间**持续发 typing「正在输入中」**（每 8s，不占连续发送上限），让用户知道在干活、不焦虑（真机实测：长任务文字静默会让人以为卡了）。全程文字进度可选 `WEMIND_WORKER_PROGRESS=1` 开启。
6. **「继续」语义消歧** ⚠️：现有 poller 里「继续」用于**连续发送上限的等待段恢复**（`budgetOf.awaiting`）。任务的「继续」是**注入 worker**。二者需分流：当存在 waiting 中的 activeTask 且不处于发送上限等待段时，「继续」路由给任务；否则维持原有上限恢复语义。实现时明确判定顺序，避免互相吞掉。

---

## 9. 异步执行模型（最关键的实现要点）

现有 `workerLoop` 是 `await handleMessage` 同步阻塞模型。引入后台任务后：

```ts
// workerLoop 内（伪代码）——全部分支都是“瞬时返回”，不 await 长执行
const ctrl = parseControl(item.text);
if (ctrl) { await handleControl(...); continue; }            // brain 控制（快）
const tcmd = parseTaskControl(item.text);
if (tcmd?.kind === "dispatch") { dispatchTask(tcmd.text, from); continue; }   // void runTask 后台
if (tcmd?.kind === "stop")     { stopTask(from); continue; }
if (activeTask && activeTask.to === from) { injectTask(from, item.text); continue; } // resolve 注入
await handleMessage(...);                                    // brain 对话（保持同步）

// runTask（后台，void 调用）
async function runTask(taskId, firstInstruction, to) {
  activeTask = { taskId, to, status: "running" };
  let instruction: string | null = firstInstruction;
  while (activeTask && instruction !== null) {
    try {
      const out = await askWorker(taskId, instruction, onProgress);  // 一轮（几分钟）
      await pushToUser(to, out || "（本轮无输出）");
    } catch (e) {
      await pushToUser(to, `⚠️ 任务中断：${reason(e)}。回复「继续」恢复，或「结束任务」终止。`);
    }
    if (!activeTask) break;                  // 期间被 stop
    activeTask.status = "waiting";
    instruction = await waitForInject();     // 等注入；stop 时 resolve(null) 退出
    if (activeTask) activeTask.status = "running";
  }
}
```

`askWorker`（worker）与 `askBrain`（brain）是两个独立 ACP 进程，各自串行；daemon 单线程事件循环里两个 `await` 并发安全。发送层 `sendOrdered` 全局串行 + 节流，brain/worker 共用，保证不乱序。

---

## 10. 配置项（env）

| 变量 | 默认 | 说明 |
|---|---|---|
| `WEMIND_WORKER_CWD` | `os.homedir()` | worker 任务工作目录 |
| `WEMIND_WORKER_IDLE_MS` | 180000 | worker 单轮空闲超时（比 brain 宽松） |
| `WEMIND_WORKER_CAP_MS` | 1800000 | worker 单轮硬上限（30min） |
| `WEMIND_WORKER_FIRST_FRAME_MS` | 30000 | worker 首帧超时 |
| `WEMIND_WORKER_PROGRESS` | `0` | 是否推送全程进度（默认安静） |
| `WEMIND_WORKER_HOME` | `~/.wemind/<account>/worker-home` | worker 沙箱配置目录（继承记忆/技能/settings + 全量 MCP 除排除项） |
| `WEMIND_WORKER_MCP_EXCLUDE` | `wechat` | worker **不**继承的 MCP（逗号分隔；`wechat` 始终强制排除，防回环） |

worker 复用现有 `WEMIND_BRAIN*` 的 agent 解析（同一 `resolveAgent()`）。

---

## 11. 安全

- worker 指向真实目录 + `--trust-all-tools` → 微信回复即可驱动它在你电脑上全权操作。**已与用户确认接受**，靠 `allowFrom` 发件人白名单兜底（poller 已对所有消息 `isAuthorized`）。
- `wechat` MCP 在 worker 沙箱永禁，防回环抢连接（同 brain 坑①）。

---

## 12. MVP 范围与非目标

**做**：微信「任务：xxx」派发 → worker 后台执行 → 轮次结束/中断推微信 → 微信回复注入续跑 → `session/load` 崩溃恢复 → 「结束任务」。

**先不做**（后续迭代）：本地命令派发、本地看/敲视图、多任务并发、全程进度镜像、任务历史/列表、worker 部署到独立机器。

---

## 13. 落地步骤

1. `worker-acp.ts`：复制 acp-brain，改独立单例 / 单任务 session / 可配 cwd / 独立沙箱 / 宽松超时。
2. worker 沙箱：泛化 `mcp-sandbox` 产出 `WORKER_HOME`（空 MCP、继承 steering/skills）。
3. `task-manager.ts`：`ActiveTask` 状态机 + `runTask` 后台循环 + dispatch/inject/stop + `pushToUser`。
4. `index.ts` `workerLoop`：插入路由分支（§5.1、§9）；「继续」消歧（§8.6）。
5. 构建 + typecheck + 单元测试（状态机路由、消歧、注入/暂存）+ 真机跑一个漫长任务验证端到端闭环。

---

## 14. 风险与待验证

- kiro-cli ACP 长时间多轮 worker 会话的稳定性（brain 侧已验证，worker 跑数十分钟级任务需真机实测）。
- 「任务征询」与「任务真做完」在 ACP 层都是「轮次结束」——MVP 一律推送本轮输出，由用户自行判断要不要回复（无需 AI 判定是否需决策）。是否要再加「完成/待决策」标识，看实测体感。
- worker 与 brain 双 ACP 进程对本机资源 / 网络（联网工具）的压力。
- 「结束任务」时杀 worker 进程树要按 PID（同坑⑧，复用 acp-brain 的 `taskkill /T /F` 逻辑）。
