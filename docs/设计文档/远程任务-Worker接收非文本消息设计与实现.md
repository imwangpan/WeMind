# 远程任务：Worker 接收非文本消息（图片 / 文件 / 视频 / 语音）设计与实现

> **状态**：已实现（2026-11-16，`feat/worker-inbound-media`；含评审修复）｜ **分支**：`feat/worker-inbound-media`（worktree `.worktrees/worker-media`）｜ **基线**：`origin/main` @ `1b6b703`
>
> 本文是「让 worker 也能像 brain 一样接收图片、文件等非文本消息」的完整设计与实施清单。落地时与代码、测试、其余文档同提交（见 §14–§16）。

---

## 1. 目标与非目标

### 1.1 目标

- 用户能对**正在等的任务**（或新派发的任务）发**图片 / 文件 / 视频 / 无转写语音**，worker 能收到并处理。
- 保持与现有行为**完全兼容**：不带任何前缀的普通消息、控制指令、任务指令的语义不变；brain 的媒体处理不变。

### 1.2 非目标

- 不实现「一条消息同时带文本 + 媒体」（微信协议不允许，见 §3）的合并发送——由「待投递队列」重组。
- 不做引用寻址（引用某条任务回复再发媒体）——留作后续（§17）。
- ~~不改出站附件~~ —— 已追加：worker 结果里的 `![](路径)` / `[附件](file://…)` 同样会发出（见 §19）。
- 不落盘收件人 / 待投递队列状态（重启即失效，安全默认回大脑，§13）。

---

## 2. 现状与差距（代码锚点）

### 2.1 brain 路径（已支持媒体）

`packages/wechat-daemon/src/index.ts` 的 `handleMessage()`：

- `packages/wechat-daemon/src/daemon/daemon-routing.ts` 的 `extractInbound(msg)` 把一条入站消息拆成 `InboundParts = { text, attachments, quote?, unsupportedTypes }`；`InboundAttachment = {kind:"image",item} | {kind:"voice",item} | {kind:"file",item} | {kind:"video",item}`。
- `index.ts` 的媒体段（约 `:512–590`）：图片 → `downloadImage()` → base64（`{data,mimeType}`）；文件 / 视频 / 无转写语音 → `downloadMediaBuffer()` + `saveInboundMedia()` 落盘 `<账号>/media/inbound`（`managed` 见 §4.19 口径），把**绝对路径**写进 `incomingNotes`。
- `askBrain(userId, message, onProgress?, images?, opts?)`（`packages/wechat-daemon/src/acp/acp-brain.ts`）的 `runTurn()` 组装 prompt：图片按 `ag.images` 能力决定注入 ACP `{type:"image",…}` 还是降级文本提示；`incomingNotes` 已拼进 `message`。
- 能力位 `ResolvedAgent.images: boolean`（`packages/wechat-daemon/src/agents/brain-agents.ts`，来源 `agents/brain-presets.ts` 的预设字段）。

### 2.2 worker 路径（不支持媒体）

- `packages/wechat-daemon/src/tasks/worker-acp.ts` 的 `WorkerConn.ask(instruction, key, onProgress?, opts?)` **只发纯文本**：

  ```ts
  const prompt: unknown[] = [{ type: "text", text: instruction || "（继续）" }];
  ```

  没有 images / notes 参数、没有降级逻辑。`WorkerConn.agent: ResolvedAgent` 已带 `images` 能力位，可直接复用。
- `packages/wechat-daemon/src/tasks/task-manager.ts` 的 `dispatchTask()` / `injectTask()` / `resumeTask()` 只传字符串指令。
- 路由闸门（`daemon/daemon-routing.ts`）：
  - `isFastLane(text, tasks, attachmentCount = 0)` 第一道闸 `if (attachmentCount > 0) return false;`——**带任何附件的消息一律走大脑**。
  - `shouldResumeInBrainQueue(text, mediaCount, tasks)` 要求 `mediaCount === 0`——**带媒体的消息永远不续跑任务**。
  - 注释口径：「控制 / 任务指令目前不处理附件，进快车道或任务侧会静默丢掉用户刚发的文件」。

### 2.3 结论

worker 缺的不是「读图能力」（`WorkerConn.agent.images` 已在），而是：**① prompt 组装不会带图 / 带附件路径；② 路由从不把带附件的消息引到任务侧。**本设计补齐这两处，并把 brain 已有的媒体下载 / 降级逻辑抽成共享层复用。

---

## 3. 关键约束：微信消息的形态

用户已确认的两条前提：

1. **微信侧一条消息无法同时包含文本和非文本内容**——图片 / 文件各自独立成一条入站 item。
2. **一个图片 / 文档 = 一条消息**；多个文档 = 多条消息（多张图片是一条带 N 个 attachment 还是 N 条消息，**待实测**，但对本设计无影响：两种形态都会进同一个待投递队列，见 §17）。

推论：非文本消息**没有可寻址的正文**（`text` 为空），无法像 `#5 正文` / `任务：正文` 那样在一次消息里写出目标。因此「这条图该给谁」只能靠**上文状态**（收件人）或**引用**（本设计不做）。这就是收件人模型的由来。

（对 brain 的既有含义：非文本消息默认仍归 brain，行为不变。）

---

## 4. 核心模型

两个按**发送者（`from`）**维度隔离的内存状态；逻辑集中在**新模块** `packages/wechat-daemon/src/daemon/media-route.ts`，`index.ts` 只持有 Map 与调度。

### 4.1 收件人（recipient，原方案里的「arm」）

```ts
type Recipient = {
  taskId: number;      // 指向某个任务的编号（#N）
  taskKey: string;     // taskKeyOf(taskId, userId)，用于定位运行中的连接
  armedAt: number;
  expiresAt: number;   // 滑动空闲 TTL 的到期时刻（§8）
};
```

语义：**当前这个人的文字消息默认发给 `taskId` 那条任务**（§7）。

### 4.2 待投递队列（pending，原方案里的「buffer」）

```ts
type PendingBatch = {
  items: InboundAttachment[];   // 原样攒着，flush 时才下载 / 落盘（§7.3）
  messageIds: string[];         // 去重 / 日志
  taskId?: number;              // 这批附件当初是给哪条任务攒的（指针过期后仍按它认账）
};
```

`taskId` 是**投递归属的唯一依据**：指针（`recipients`）只决定「新到的附件算谁的」，批次一旦建立就跟着自己的 `taskId` 走。换收件人、指针过期、TTL 清扫、结束任务都以它为准（见 §20.1–§20.3），这样「给 #5 的图」不会因为指针变了而被 #7 认领。

语义：**收件人期间收到的非文本消息先攒着**，等一个「提交点」到达时，与随后到达的文本一起、作为一个多模态回合投给任务。

**中途换收件人**：再发 `#M`（或 `任务：…` 等会设置收件人的指令）时，若队列里还有指向旧任务的附件，**先把它们作为一批提交给旧任务、再切换指针**（`MediaRoute.swapRecipient()` 返回被换下来的批次，`armAndFlush()` 负责投递并回执「📎 已先把 N 个暂存附件提交给 #5，现在 #7 是收件人」）。因此附件永远不会被错投给新任务，也不会被静默丢弃。

### 4.3 一个回合 = 文本 + 全部积压附件

因为文本与媒体必然分成多条消息，二者在**提交点**重组为**一次** `injectTask`：worker 的同一个回合同时看到文字和所有积压的图 / 文件。这既贴合「多个文档是多条消息」的现实，也让 worker 的上下文完整。提交的文本若带微信引用，按与大脑相同的 `formatQuote()` 前缀（`[引用消息] …`）一并带入。

---

## 5. 指令集

### 5.1 复用（进入收件人）

| 指令 | 现状 | 变更 |
| --- | --- | --- |
| `任务：正文` / `任务 <agent>：正文` / `/task …` / `> 正文` | 派发新任务 | 派发**并**把该任务设为收件人（`task.toWorker`） |
| `#N 正文` / `/reply N 正文` | 回话给 #N | 回话**并**设为收件人（`task.reply`） |
| `继续` 类短句（有可续跑任务） | 续跑 | 续跑**并**设为收件人 |

### 5.2 新增

| 指令 | 解析结果 | 行为 |
| --- | --- | --- |
| 裸 `#N`（仅编号，无正文） | `TaskCommand { kind: "recipient"; id }` | **只设收件人，不产生回合、不占额度** |
| `发给任务 N`（别名，与裸 `#N` 并存） | 同上 | 同上（比裸 `#N` 更好读） |
| `回到大脑`（斜杠 `/to-brain`） | `ChatCommand { kind: "toBrain" }` | **退出收件人** + 回执；先按 §8.3 处理积压再清 |

> 冲突校验：`#N` 需与既有 `#1 号文件在哪`（普通消息）、`#1:30`（时间）区分——裸 `#N` 只在整串恰好是编号时命中，且数字后紧跟「号」按普通消息；`回到大脑` 与既有 `回到会话`（`session.resume` 别名）不同串，不冲突（§12）。

### 5.3 不变

`任务列表` / `结束任务 [N]` / `结束全部任务` 等控制指令解析不变；`结束任务` 额外**清理指向该任务（或全部）的收件人**（§8.2）。

---

## 6. 路由决策表

### 6.1 决策表（按 `from` 的收件人状态）

| 消息 | 是否命中收件人 | 路由 |
| --- | --- | --- |
| 非文本（图 / 文件 / 视频 / 无转写语音） | 否 | **不变**：`msgQueue` → brain |
| 非文本 | 是 | **待投递队列**：入队 + 重置 TTL +（首批）回执；**不**入任何队列 |
| 纯文本 = 控制指令 | — | 快车道；`回到大脑` 清收件人；`结束任务` 清对应收件人 |
| 纯文本 = 任务指令 | — | 快车道；按 §5.1 更新 / 设置收件人；（如 `任务：…`）立即派发（A1，§7.2） |
| 纯文本 = `问大脑：…` / `大脑：…` / `brain: …` | — | **一次性逃逸**：本条给 brain，**不清收件人**（§12） |
| 纯文本 = 其它 | 是 | **给收件人任务**：与积压附件一起提交（§7） |
| 纯文本 = 其它 | 否 | **不变**：`msgQueue` → brain |
| 无文本、无媒体、无引用 | — | 丢弃 + 日志（不变） |

口诀：**「命令归命令，逃逸是例外，其余全部给收件人。」**

### 6.2 poller 分拣（`index.ts`，决策抽在 `decideInboundRoute()` 里）

```ts
const parts = extractInbound(msg);
const ctrl = parseControl(parts.text);
const tctrl = parseTaskControl(parts.text);
const escaped = parts.text ? parseBrainEscape(parts.text) : null;   // 问大脑 / 大脑 / brain
const recipient = mediaRoute.recipient(from);
const route = decideInboundRoute({
  recipientTaskId: recipient?.taskId ?? null,
  attachmentCount: parts.attachments.length,
  hasText: !!parts.text.trim(),
  hasCommand: !!(ctrl || tctrl || escaped),   // 命令/逃逸永远优先
  fastLane: isFastLane(parts.text, facts, parts.attachments.length),
  mcpToBrain: passMcpToggleToBrain(ctrl, homeModeAtBoot === "direct"),
});

switch (route.kind) {
  case "buffer": {                             // 非文本 + 收件人：攒起来
    const { first, count } = mediaRoute.buffer(from, parts.attachments, messageId, route.recipientTaskId);
    if (first) void sends.sendNotice(from, msg.context_token, `📎 已把收到的附件交给 #${route.recipientTaskId}…`, token);
    if (parts.text.trim()) {                   // 同条消息还带文字（客户端组合）：文字进快车道，出队时合并提交
      queued.attachments = [];                 // 附件已归队列，清掉副本防重复
      queued.toRecipientTaskId = route.recipientTaskId;
      fastQueue.push(queued); enq = true;
    }
    continue;
  }
  case "recipient":                            // 无前缀文字 + 收件人：出队时合并附件
    queued.toRecipientTaskId = route.recipientTaskId;
    fastQueue.push(queued); enq = true; continue;
  case "fast": fastQueue.push(queued); break;
  default: msgQueue.push(queued);              // brain
}
```

`decideInboundRoute()` 在 `daemon/media-route.ts`，是**纯函数**（表驱动单测覆盖「命令 + 附件不被吞」「有文字有附件双投」等边界）。命令/逃逸命中时即使带附件也不入队：走回原路径（附件消息本就不进快车道 → 大脑），这是 2026-11-16 审查后修的 P0。

> `isFastLane` 不需要改「附件一律 false」那条闸：附件消息在 `#1`（命中收件人）已经被拦下；**未命中收件人的附件消息**继续按现状走大脑，正是我们要保留的行为。改动只发生在 poller 的前置分支，未命中收件人时逻辑与今天完全一致。

### 6.3 执行侧

`handleFastItem()` 里新增两个分支：

- `TaskCommand { kind:"recipient" }`：解析目标任务 → `armAndFlush()` → 回执（§11）。
- `QueuedMsg.toRecipientTaskId`：`takePending()` → `deliverPending()`（内部 `prepareInboundMedia()` + `injectTask(..., { images })`）→ 视情况回执。
- `ChatCommand { kind:"toBrain" }`：§8.2 的清退流程 → 回执。
- 既有 `任务 / reply / 继续` 分支：在成功解析出目标任务后 `armAndFlush()`（同一函数里顺带把换收件人前的旧附件交回原任务）。

`workerLoop()` 的 `parseBrainEscape` / `shouldResumeInBrainQueue` 保持原样（逃逸前缀自动获得新写法，因为仍是同一个函数）。

---

## 7. 提交时机、粒度与组装

### 7.1 提交点（三个）

1. **文本到达**（收件人命中）：文本 + 全部积压附件 → 一个回合（§4.3）。
2. **`好了` / `就这样`**：不配文字，把积压附件立即提交（不等 TTL）。实现上没有单独的 `flush` 指令：这两个词命中 `isFlushWord()`，在收件人分支里把正文置空（`flushOnly`），只提交附件；**队列为空时**直接回一句「现在没有待提交的附件。」，不再把这两个词当正文发给任务（否则会白白多一个空回合）。
3. **空闲 TTL 到期兜底**（§8.1）：积压非空 → 用兜底指令提交，防丢文件。

**不设独立的短防抖**：短防抖会在图刚发完就抢先提交，随后到达的说明文字跟不上，白白多一个回合。滑动 3 分钟 TTL 本身就充当批处理窗口。

### 7.2 开跑时机：先跑后注入（A1）

`任务：正文` **立即派发**（worker 马上开跑，无额外延迟）；随后发来的附件进待投递队列，在下一个提交点作为**后续回合**注入这条在跑的任务。附件与首句不同回合，符合「微信装不下图文同条」的现实。

### 7.3 组装与媒体准备

- 攒入队时**只存元数据**（`InboundAttachment`），**不**下载；
- 提交时调 `prepareInboundMedia(items, { messageId })`（§9.1）一次性下载 / 落盘，产出 `{ images, notes, failures }`；
- 文本为空时用兜底指令（`mediaInstructionFallback()`，镜像 brain 的口径）：纯图「（用户发来图片，请查看并回应）」、纯附件「（用户发来附件，请查看并回应）」、混合「（用户发来图片和附件，请查看并回应）」。
- `notes`（文件 / 视频 / 语音的绝对路径）与文本按 `\n\n` 拼接进同一条 worker 指令；`images` 作为 ACP image blocks（§9.3）。

### 7.4 提交粒度：一批一回合

一次提交 = 一次 `injectTask` = worker 的一个回合（`task-manager` 现有的 `pendingInjects` / `injectResolver` 机制天然支持）。

---

## 8. 生命周期与自动退出

### 8.1 滑动空闲 TTL（默认 3 分钟）

- **进入**收件人时启动计时；**任何收件人模式内的活动**（非文本入队、或向任务投递内容）都**重置** `expiresAt = now + ttl`。
- **到期**（`expiresAt <= now` 且有积压 → 先兜底提交，再清；无积压 → 直接清）+ **超时回执**（§11）。
- **滑动**而非固定窗口：固定窗口会在用户连续发文件时中途到点、切回大脑，最招误解；滑动 = 「停手一会儿才自动回大脑」，中途不打断。
- 默认 3 分钟（2026-11-17 由 1 分钟改来：一组图每张都是一条消息，再加一句说明很容易超过 1 分钟，太短会在中途切回大脑）；实现为常量并允许配置项覆盖（环境变量 `WEMIND_MEDIA_RECIPIENT_TTL_MS`，默认 `180_000`）。
- **无单窗口硬上限**（用户明确不要）——空闲 TTL 足够。

### 8.2 清退通道

| 通道 | 行为 |
| --- | --- |
| `回到大脑` | 积压非空→先提交给任务；再清；回执 |
| 空闲 TTL 到期 | 积压非空→兜底提交；再清；超时回执 |
| 收件人任务结束 / 被 `结束任务` | 清收件人；积压非空 → 在答复末尾回执「（还有 N 个暂存的附件没有提交，已一并丢弃。）」并丢弃 |
| 进程重启 | 不落盘、不清迁移，自然失效（§13） |

### 8.3 状态可见：不做

用户明确：TTL 只有几分钟，**不加**任务列表标记、**不加**临期提醒。可见性只靠进入 / 退出 / 超时的**回执**（§11）。

---

## 9. 与 brain 复用媒体管线（三个共享抽层）

### 9.1 `packages/wechat-daemon/src/daemon/messaging/inbound-media.ts`（新）

从 `index.ts` 的媒体段抽出：

```ts
export interface PreparedMedia {
  images: Array<{ data: string; mimeType: string }>; // base64
  notes: string[];      // 文件/视频/语音的 [用户发来…] 绝对路径说明
  failures: string[];   // 中文失败标签
  imageCount: number;   // 收到的图片条数（含下载失败的）
  otherCount: number;   // 文件 / 视频 / 语音条数
}
export async function prepareInboundMedia(
  attachments: InboundAttachment[],
  opts: { messageId: string; onHint?: (text: string) => void },
): Promise<PreparedMedia>;
```

进度文案不进返回值，而是通过 `onHint` 回调交给调用侧（`index.ts` 直接转给 `sendProgress`），因为提示是否发得出去要看额度与回合状态，属于调用侧的职责。

brain（`index.ts` `handleMessage`）与 worker（`handleFastItem` / 待投递 flush）共用，行为与今天 brain 完全一致；`index.ts` 的 5s/15s 进度与额度逻辑**留在调用侧**，不进这个纯函数。

### 9.2 `packages/wechat-daemon/src/acp/prompt-media.ts`（新）

把 `acp-brain.ts` `runTurn()` 里「按 `images` 能力注入 image block / 否则注入降级文本」这段抽成：

```ts
export function applyMediaToPrompt(
  prompt: unknown[],
  images: Array<{ data: string; mimeType: string }> | undefined,
  supportsImages: boolean,
  opts?: { unsupportedNote?: string },
): void;
```

brain 与 worker 共用（默认降级文案可覆盖）。`acp-brain.ts` 改为调用它，**行为不变**（等价重构，靠现有测试兜底）。

### 9.3 `worker-acp.ts` 的 `ask()` 扩展

```ts
ask(
  instruction: string,
  key: string,
  onProgress?: (ev: WorkerProgressEvent) => void,
  opts: { strictResume?: boolean; images?: Array<{ data: string; mimeType: string }> } = {},
): Promise<string>
```

prompt 组装：`applyMediaToPrompt(prompt, opts.images, this.agent.images)` → push 文本指令。其余（`ensureProcess` / `ensureSession` / `promptAcp` / `acpTurnText`）不变。

### 9.4 `task-manager.ts` 贯通媒体

- `Task` 增 `pendingInjects?: InjectPayload[]`（`InjectPayload = { text: string; images?: PromptImage[] }`），不再另存整份 `PreparedMedia`。
- `dispatchTask(to, instruction, opts: { cwd?, agentKey?, ackId?, images?, onTaskId? })`：首个回合带上 `images`。
- `injectTask(to, text, id?, ackId?, opts: { images?, onTaskId? })`：把 `images` 与文本一起交给下一个回合（`waitForInject()` 合并文本、`flatMap` 图片）。
- `runTask` 循环：`conn.ask(instruction, task.key, onProgress, { strictResume: wasResume, images })`。
- `resumeTask(task, instruction, media?)` 同理。

---

## 10. worker 能力差异与降级

- **图片**：`WorkerConn.agent.images === false` 时，`applyMediaToPrompt` 注入降级文本「（用户发来图片，但当前任务 agent 不支持图片输入；请让用户改用文字，或换一个支持图片的任务 agent。不要臆测图片内容。）」——与 brain 同口径，**不静默丢**。
- **文件 / 视频 / 语音**：与能力位无关，一律落盘 + 绝对路径进 prompt（worker agent 用文件读取能力处理），与 brain 一致。
- 指定 agent（`任务 <agent>：…` / `#N`）时用的是该任务的 `agent`，能力位以**任务自身的 agent** 为准（不是全局默认 worker）。

---

## 11. 进度、回执与发送额度

- **进入回执**（占 1 条额度）：
  `✅ 已把 #5 设为收件人：接下来 180 秒内你发的文字、图片、文件都交给它。` + 换行 + `想回大脑发「回到大脑」，只想问大脑一句发「问大脑：…」。`
- **per-batch ack**（首批附件入队时 1 条，占额度）：
  `📎 已把收到的附件交给 #5（再发文字、「好了」就一起提交）。`
- **退出 / 超时回执**（占额度），见 §8.2 文案。
- **媒体下载进度**：复用 brain 的进度文案（`hints`），受既有 `planProgressEmission` / 连发额度约束。
- 遵守 AGENTS.md §4.5：图片 / 文件 / 视频各占一条连发额度；额度到 `limit-2` 时按既有策略让位给最终答案。

---

## 12. 逃逸前缀扩展：`问大脑` / `大脑` / `brain`

### 12.1 关键词占用排查（结论）

| 关键词 | 现有占用 | 是否冲突 |
| --- | --- | --- |
| `问大脑` | 已是逃逸前缀（`parseBrainEscape`） | 无 |
| 裸 `大脑` 开头 | **无**任何指令以「大脑」开头（`切换大脑` / `任务大脑` / `ai 大脑` 都以 切换/任务/ai 开头） | 指令层无冲突；但「大脑」是极常见词首，**必须要求分隔符**否则误伤「大脑的工作原理…」 |
| 裸 `brain` | 未占用 | `/brain …`、`/ai brain …` 是 `切换大脑` 指令，**已占用**；故逃逸只用**不带斜杠**的 `brain`，且要求分隔符，避免与 `/brain` 混淆、也避免命中 `brainstorm` |
| `回到大脑`（新退出指令） | 与 `回到会话`（`session.resume`）不同串 | 无 |

### 12.2 规则（写进代码 + 文档）

```ts
// 冒号 / 空白分隔；`问大脑` 保留历史宽松写法（分隔符可选）
const BRAIN_ESCAPE = /^(?:问大脑\s*[:：]?\s*|(?:大脑|brain)\s*[:：]\s*|(?:大脑|brain)\s+)([\s\S]+)$/i;
```

- `问大脑 你好` / `问大脑：你好` / `问大脑你好`（历史宽松）→ 逃逸；
- `大脑：你好` / `大脑 你好` → 逃逸；`大脑你好` → **普通消息**（安全）；
- `brain: hi` / `brain hi` → 逃逸（大小写不敏感）；`brainstorm` → 普通消息；
- `/brain foo` → 仍是 `切换大脑` 指令（不逃逸）。

逃逸 = **一次性**：本条去前缀后给 brain，**不退出收件人**（下一条仍默认给任务）；这也兑现了进入回执里写的「只想问大脑一句发『问大脑：…』」。

> 该函数同时被 `isFastLane()` 与 `workerLoop` 使用，改一处两处生效。既有的「问大脑」用例（`index.test.ts`）保持通过。

---

## 13. 重启纪律

- 收件人 / 待投递队列**只存内存**，不写盘、不入 `tasks.json` / 账号数据目录。
- 进程重启后自然清空；用户之后的非文本消息按「未命中收件人」回大脑。**不主动提示**（用户确认）。
- 与 AGENTS.md §4.13 一致：任务表只用于「重启后续跑」，收件人是即时路由状态，不属于持久化范畴。

---

## 14. 改动清单（文件级）

### 新增

| 文件 | 内容 |
| --- | --- |
| `packages/wechat-daemon/src/daemon/media-route.ts` | 收件人 + 待投递队列状态机（可注入 `now` / 定时器 / `inject` 回调，便于单测） |
| `packages/wechat-daemon/src/daemon/media-route.test.ts` | 状态机单测（TTL 滑动 / 各清退通道 / 提交点） |
| `packages/wechat-daemon/src/daemon/messaging/inbound-media.ts` | `prepareInboundMedia()`（自 `index.ts` 抽出） |
| `packages/wechat-daemon/src/daemon/messaging/inbound-media.test.ts` | 与 brain 现行为等价的回归用例 |
| `packages/wechat-daemon/src/acp/prompt-media.ts` | `applyMediaToPrompt()`（brain / worker 共用） |
| `packages/wechat-daemon/src/acp/prompt-media.test.ts` | 图片能力开 / 关、降级文案用例 |

### 修改

| 文件 | 变更 |
| --- | --- |
| `packages/wechat-daemon/src/ipc/chat-command-specs.ts` | `TaskCommand` 加 `{ kind:"recipient"; id }`（裸 `#N` / `发给任务 N`）；`ChatCommand` 加 `{ kind:"toBrain" }`（`回到大脑`）；`TASK_COMMAND_SPECS` / `COMMAND_SPECS` 各加一条 spec |
| `packages/wechat-daemon/src/daemon/daemon-routing.ts` | `parseBrainEscape` 扩展到 §12.2（`问大脑` / `大脑` / `brain`） |
| `packages/wechat-daemon/src/acp/acp-brain.ts` | `runTurn` 改用 `applyMediaToPrompt`（等价重构） |
| `packages/wechat-daemon/src/tasks/worker-acp.ts` | `ask()` 支持 `images`，prompt 走 `applyMediaToPrompt` |
| `packages/wechat-daemon/src/tasks/task-manager.ts` | `dispatchTask` / `injectTask` / `resumeTask` 支持 `media`；`Task` 流转 `pendingMedia`；新增解析目标任务的辅助（供收件人 arm 复用） |
| `packages/wechat-daemon/src/index.ts` | 收件人 / 待投递 Map 与调度；poller 分拣（§6.2）；`handleFastItem` 新分支（§6.3）；媒体段改用 `prepareInboundMedia`；`kind:"toBrain"` / `kind:"recipient"` / flush 处理 |

### 测试

`daemon-routing.test.ts`（`parseBrainEscape` 新写法 + `isFastLane` 未命中收件人时行为不变）、`media-route.test.ts`（收件人/队列语义、`decideInboundRoute` 表驱动、`deliveryTarget`、`purgeForStopped`、`swapRecipient`/`buffer` 的过期与换人边界）、`inbound-media.test.ts`（按角色落盘）、`prompt-media.test.ts`（image 块与降级文案）、`task-manager.test.ts`（media 贯通）、`pool-spawn.test.ts`（首轮约定提示只带一次）、`chat-commands.test.ts`（裸 `#N` / `发给任务 N` / `task-focus` / `回到大脑`）。注：`index.test.ts` 仍只覆盖从 `index.ts` 导出的纯函数，`handleFastItem()` 的分支**没有**端到端用例（需要真实 daemon 状态），其投递目标判定已抽成 `deliveryTarget()` 单测覆盖。

---

## 15. 测试计划（要点）

- **状态机**：滑动 TTL 每次活动都重置；到期有积压→兜底提交、无积压→直接清；`回到大脑` / 任务结束 / TTL 三条清退通道。
- **路由**：非文本 + 收件人→入队且不入 `msgQueue`；非文本 + 无收件人→仍进 `msgQueue`（回归）；文本 + 收件人→`toRecipient`；`问大脑：…` 逃逸→brain 且不收件人变化。
- **提示词**：worker `images:true`→prompt 含 `{type:"image"}`；`images:false`→含降级文本且不含 image block；文件→prompt 含绝对路径。
- **任务侧**：一批附件 + 文本 = 一次 `conn.ask`（一个回合）；`好了` 立即提交；兜底指令格式。
- **额度 / 回执**：per-batch ack 只发一次；进入 / 退出 / 超时回执文案。
- **兼容回归**：`#1 号文件在哪`、`#1:30 开会`、`大脑的工作原理`、`brainstorm` 均为普通消息；`/brain foo` 仍是切换大脑。

---

## 16. 文档同步清单（AGENTS.md §4.15）

- `README.md` 命令一览（加 `回到大脑` / 裸 `#N` / `发给任务 N`）；§「收文本 / 图片 / …」段补 worker 侧媒体。
- `packages/wechat-daemon/README.md`（随包发布，必改）。
- `docs/ai/README.md`（事实状态表 / 任务地图）；本文件（设计与实现）加入 `docs/README.md` 与 `llms.txt`。
- `docs/repowiki/05-daemon.md`（路由图 + 「带附件一律给 brain」的口径要改成「未设收件人时给 brain」）、`docs/repowiki/07-远程任务-Worker.md`。
- `docs/使用指南/使用指南-远程任务（worker）.md`（新用法示例）。
- `docs/ai/已知坑.md` / `验收清单.md` / `代码地图.md`（新文件）按需。
- `AGENTS.md` §4.5（额度文案）、§4.19（入站媒体，worker 复用同目录口径）、§4（路由相关条目）。
- `docs/发布与变更记录/CHANGELOG.md` 记一条。
- `npm run verify` 全绿。

---

## 17. 边界、非目标与待实测

- **不做引用寻址**：媒体无法寻址，只能靠收件人；引用某条任务回复再发图，未来可基于「已发送消息 id ↔ 任务」映射实现。
- **不做「图文同条」**：微信协议限制，重组由待投递队列完成。
- **不做状态显示 / 硬上限**：用户明确不要。
- **待实测**：① 多张图片是一条消息带 N 个 attachment 还是 N 条消息（对本设计无影响，但影响回执措辞「N 张图片」）；② 非文本消息能否携带引用（`ref_msg`；本设计不用，但决定后续引用寻址可行性）。
- **多账号**：收件人 / 待投递按 `from` 隔离；每个 daemon 只管自己的账号（AGENTS.md §4.7），无需跨账号。

---

## 18. 设计不变量（改代码前先读）

1. **未设收件人时，行为与今天逐字节一致**：带附件一律给 brain、`isFastLane` / `shouldResumeInBrainQueue` 的既有闸门不动。
2. **收件人只影响「无前缀纯文本」与「非文本」两类**：所有显式指令（控制 / 任务 / 逃逸）语义不变。
3. **逃逸是一次性的**，不清收件人。
4. **待投递队列必须最终有归宿**：文本 / `好了` / TTL 兜底三条路径至少一条触发；任务结束时明确回执并丢弃，绝不静默丢文件。
5. **收件人 / 待投递不落盘**，重启即失效是**预期行为**，不是 bug。
6. **媒体下载 / prompt 降级逻辑只有一份**（`inbound-media.ts` / `prompt-media.ts`），brain 与 worker 共用。
7. **回执占额度**，遵守 §4.5 的连发上限与让位规则。

## 19. 追加（同分支，2026-11-16）：worker 出站媒体

收非文本做通后，用户要求在同一个分支补上反方向：worker 的任务结果也能发图片/文件/视频。

- **共用出站管线**：把 brain 回合里「从回复文本抽媒体 → 逐条发出」的代码原样抽成模块级 `sendReplyMedia(to, answer, sends, ctxToken)`（`index.ts`），返回 `{ text, mediaCount }`。brain 的 `handleMessage` 与 worker 的 `setTaskPush` 都调它，因此预算记账（`canSendMedia()` + `budgetOf(to).count += 1`）、敏感文件拦截（`sensitiveAllowActive()` / `rememberPendingSensitive()`）、失败说明（`imageFailureNote()` / `attachmentFailureNote()`）只有一套口径。
- **顺序**：brain 与 worker 都是「先媒体、后正文」。任务推送额外按用户串行（`taskReplyChains`，`Map<userId, Promise>`），因为媒体要先下载/读盘，并发解析会让后到的短回复抢先发出。
- **只发媒体、没有正文**时不补一条空消息；两者都没有才发「（没有内容）」。
- **可发现性**：worker 每个会话首轮追加一次约定提示（`hintedSessions`，键 `<agent>:<sessionId>`），措辞只讲「怎么写就能发」与「占连发额度、别刷屏」，不改 agent 自身能力。
- **不与「附件一律给大脑」冲突**：这条限制只作用于入站路由；出站是任务结果的一部分，本来就属于 worker。
- **提示文案**：任务推送末尾从「不带前缀的消息会交给大脑」改为「不带前缀的消息默认交给大脑（发「#N」可设为收件人）」——收件人模式下前者不准确，且这行是用户学习寻址的主要入口。

## 20. 独立审查后的修复（2026-11-16）

第一版实现经独立审查发现若干真实缺陷，均已修复并补了回归用例。这一节记录**结论与不变量**，避免以后改回去。

### 20.1 批次归属是投递的唯一依据

- 待投递队列的每一批都记 `taskId`（「这一批是给谁攒的」）。提交时用 `deliveryTarget(batch, fallback)`：**有附件就以 `batch.taskId` 为准**，指针只负责「没有附件时的纯文字提交」与提示。
- `swapRecipient()` 判断「有没有旧账」时读**原始表项**（允许已过期），不只信 `recipient()`；过期指针也照样把旧批次交回原任务，不会留给下一条任务认领。
- `buffer()` 发现队列里是另一条任务的附件时不覆盖归属，而是整批交还调用方（`displaced`），poller 先把它交给原任务再入新队。
- 清扫（TTL 到期）同样用 `batch.taskId ?? recipient.taskId`。

### 20.2 失败清理按归属限定

`deliverPending()` 发现目标任务已不存在时，只在「指针仍指着它」时清指针、只在「批次归属还是它」时清队列——不能把用户刚设置的 #2 连同新附件一起清掉。

### 20.3 结束任务的两条入口都要清

微信 `结束任务` 与本地 `wemind task-stop` 走的是不同代码路径（`handleFastItem` vs `task-inbox-runner`），两者都调用 `purgeForStopped(userId, id, isAlive)`：命中指针或命中批次归属即清理，并返回丢弃条数用于回执。`isAlive` 兜住「指针已过期、任务已被别处停掉」的情形。

### 20.4 managed 下按角色落盘

`prepareInboundMedia(attachments, { messageId, onHint, role })` 把 `role` 传给 `saveInboundMedia(..., mediaInboxDir(role))`：worker 侧写 `worker-home/media/inbound`，与 `docs/repowiki/08-数据存储与多账号.md` 的口径一致；启动清理对 brain / worker 两个目录各清一次。

### 20.5 图片通道与附件同一套安全闸

`resolveImageBytes()` 的本地路径此前只查扩展名与大小，等于给外发凭证开了后门（worker 结果里的 `![](路径)` 也会走它）。现在与附件一致：`assertLocalPath()`（拒 UNC / `file://host` / NTFS 数据流）→ `realpath` → 图片扩展名 → `isSensitiveFilePath()` → 大小上限。

### 20.6 任务推送用最新 token

`sendTaskReply()` 改成每次发送现取 `state.contextTokens[...]`（`tok()`），不再在下载媒体**之前**固定捕获——大文件下载期间用户新消息刷新 token 后，媒体不会再用旧 token 发。

### 20.7 分派改成 switch + never 兜底

`handleFastItem()` 的任务指令分派改成 `switch (tcmd.kind)`，`default` 里 `const unhandled: never = tcmd`。审查期间出现过「删掉一个分支而测试仍全绿」的事故（`index.ts` 的这些分支没有端到端用例），加这层兜底后，新增 `TaskCommand` kind 却忘了处理会当场 typecheck 失败。`handleFastItem()` 本身仍无集成测试，投递目标等纯逻辑已下沉到 `media-route.ts` 单测覆盖。

### 20.8 有意保留：超时回执不看连发额度（P2-5）

`sweepMediaRecipients()` 的 `⌛ 超时取消` 回执直接 `sends.sendNotice()`，不像快车道的 `notice()` 那样在「本回合额度见底」时让位（`deferTaskPush()`）。理论上存在一条窄路径：用户给收件人发到 8–9 条 → 清扫回执占掉保留给最终答案的最后一条 → 大脑答案被 `ret=-2` 挂起，等用户下一条消息才补发。

**决定（2026-11-16，用户确认）：保持现状**。理由：触发需要「收件人到期 + 用户恰在此刻发消息 + 大脑回合在跑且已发 ≥8 条」四件事同时发生；后果只是顺序与延迟，不丢文件、不错投、不改路由；且与进入回执、`结束任务` 回执等其他 `sendNotice()` 用法一致。真要修只需在清扫里加一次 `activeTurn` + `budget.count >= limit - 1` 判断后改走 `deferTaskPush()`。

---

## 21. 后续调整（2026-11-17）

### 21.1 默认 TTL：1 分钟 → 3 分钟

`index.ts` 的 `MEDIA_RECIPIENT_TTL_MS` 默认值改为 `180_000`（`WEMIND_MEDIA_RECIPIENT_TTL_MS` 仍可覆盖），滑动续期不变。理由：一组图每张都是一条消息、再加一句说明，真机上很容易超过 1 分钟；太短会在用户还没说完时切回大脑，反而增加困惑。

### 21.2 超时回执加自我标识

`sweepMediaRecipients()` 的回执改为：

```text
⌛ 提醒：收件人 #N 已超时自动取消，之后的文字和附件交给大脑。（已把之前收到的附件交给它。）
（这是定时器单独发的提醒，不是对你上一条消息的回复。）
```

它是 15s 清扫定时器发的，真机上被误读成「对刚发那句 `任务：…` 的回复」（用户发完任务立刻收到一条 #N 的过期提醒，以为 `任务：` 被当成了追加）。加一行自我标识即可。

### 21.3 `任务：` 一律新建（跨模块的行为变更）

`任务：正文` / `>正文` 不再「有活跃任务就追加」，见 [远程任务：human-in-the-loop 设计与实现](远程任务-human-in-the-loop设计与实现.md) 的 2026-11-17 补充与 [repowiki/07](../repowiki/07-远程任务-Worker.md)。它仍会把新任务设为收件人（`dispatchTask` 的 `onTaskId` → `armAndFlush()`），所以附件链路不变；并行时回执多一句 `parallelTaskHint()` 教学。
