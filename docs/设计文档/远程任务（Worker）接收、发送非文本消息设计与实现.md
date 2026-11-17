# 远程任务（Worker）接收、发送非文本消息（图片 / 文件 / 视频 / 语音）设计与实现

> **状态**：已实现（接收与发送均为 2026-11-16 同一分支；含评审修复与 2026-11-17 的 TTL / `任务：` 调整）｜ **基线**：`origin/main` @ `1b6b703`，已合并进 `main`
>
> 本文覆盖 worker 与微信之间的**两个方向**：① 用户把**图片 / 文件 / 视频 / 语音**发给任务（§1–§18）；② 任务结果把**图片 / 文件 / 视频**发回微信（§19）。两个方向都复用 brain 已有的媒体管线，落地时与代码、测试、其余文档同提交（见 §14–§16）。
>
> 阅读路线：只关心「怎么给任务发图」→ §3–§8；只关心「任务怎么把图发回来」→ §19；动代码前先读 §18 的不变量。

---

## 1. 目标与非目标

### 1.1 接收目标（用户 → 任务）

- 用户能对**正在等的任务**（或新派发的任务）发**图片 / 文件 / 视频 / 无转写语音**，worker 能收到并处理。
- 保持与现有行为**完全兼容**：不带任何前缀的普通消息、控制指令、任务指令的语义不变；brain 的媒体处理不变。

### 1.2 发送目标（任务 → 用户）

- worker 的任务结果里显式写出的**图片 / 文件 / 视频**能作为**独立媒体消息**发到微信，而不是把链接当正文丢给用户。
- 与 brain 出站共用同一套解析、额度记账、敏感文件拦截与失败说明，不出现第二套口径。

### 1.3 非目标

- 不实现「一条消息同时带文本 + 媒体」（微信协议不允许，见 §3）的合并发送——由「待投递队列」重组。
- 不做引用寻址（引用某条任务回复再发媒体）——留作后续（§17）。
- **不给出站加专用工具**：出站靠回复文本里的约定语法（§19.2），不要求 agent 会调微信 API，也不改 agent 自己的能力位（`images` 只管入站看图）。
- 不支持语音气泡（音频按文件发），不发出站 http 附件（只认本地绝对路径）。
- 不落盘收件人 / 待投递队列状态（重启即失效，安全默认回大脑，§13）。

---

## 2. 现状与差距（代码锚点，实施前快照）

> 本节记录 2026-11-16 动工前的状态，用于说明**为什么改**；现状以实现与 §20 的评审修复为准。

### 2.1 brain 路径（已支持媒体）

`packages/wechat-daemon/src/index.ts` 的 `handleMessage()`：

- `packages/wechat-daemon/src/daemon/daemon-routing.ts` 的 `extractInbound(msg)` 把一条入站消息拆成 `InboundParts = { text, attachments, quote?, unsupportedTypes }`；`InboundAttachment = {kind:"image",item} | {kind:"voice",item} | {kind:"file",item} | {kind:"video",item}`。
- `index.ts` 的媒体段（约 `:512–590`）：图片 → `downloadImage()` → base64（`{data,mimeType}`）；文件 / 视频 / 无转写语音 → `downloadMediaBuffer()` + `saveInboundMedia()` 落盘 `<账号>/media/inbound`（`managed` 见 §4.19 口径），把**绝对路径**写进 `incomingNotes`。
- `askBrain(userId, message, onProgress?, images?, opts?)`（`packages/wechat-daemon/src/acp/acp-brain.ts`）的 `runTurn()` 组装 prompt：图片按 `ag.images` 能力决定注入 ACP `{type:"image",…}` 还是降级文本提示；`incomingNotes` 已拼进 `message`。
- 能力位 `ResolvedAgent.images: boolean`（`packages/wechat-daemon/src/agents/brain-agents.ts`，来源 `packages/wechat-daemon/src/agents/definitions/<agent>.json` 的 `images` 字段，经 `agents/agent-registry.ts` 加载；本机同名定义见 `~/.wemind/.agents/<name>.json`）。

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

- **提交前等「后到的图」并批（2026-11-17 加，`waitForSettledAttachments()`）**：微信里一张图一条消息，用户「连发几张 + 立刻发文字」时最后几张往往还在路上。触发提交（文字 / `好了`）且队列非空时，先等到队列**安静 `WEMIND_MEDIA_FLUSH_DEBOUNCE_MS`（默认 700ms，0 = 关闭）**再 `takePending()`，让晚到的附件并入同一批；总等待上限 3s（`MEDIA_FLUSH_DEBOUNCE_MAX_MS`），免得用户一直发图时已发出的文字永远等下去。只对「用户触发的提交」生效——TTL 到期、换收件人、`回到大脑`、`结束任务` 一律立即处理，不拖。
- **不做「延迟整条消息」的防抖**：早先考虑过给整个收件人模式加短防抖，被否决——那会在图刚发完就抢先提交，随后到达的说明文字跟不上，白白多一个回合。上面这个窗口只等**附件队列**，文字已经在手、不会被推迟到下一个回合。

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
| `packages/wechat-daemon/src/tasks/worker-acp.ts` | `ask()` 支持 `images`，prompt 走 `applyMediaToPrompt`；每会话首轮加一次出站约定提示（§19.8） |
| `packages/wechat-daemon/src/daemon/messaging/attachments.ts` | `assertLocalPath()` 改为 `export`（图片通道复用同一套闸，§19.6） |
| `packages/wechat-daemon/src/daemon/messaging/image-reply.ts` | `resolveImageBytes()` 的本地分支补 realpath / 扩展名 / `isSensitiveFilePath()`（§19.6） |
| `packages/wechat-daemon/src/tasks/task-manager.ts` | `dispatchTask` / `injectTask` / `resumeTask` 支持 `media`；`Task` 流转 `pendingMedia`；新增解析目标任务的辅助（供收件人 arm 复用） |
| `packages/wechat-daemon/src/index.ts` | 收件人 / 待投递 Map 与调度；poller 分拣（§6.2）；`handleFastItem` 新分支（§6.3）；媒体段改用 `prepareInboundMedia`；`kind:"toBrain"` / `kind:"recipient"` / flush 处理；出站抽成 `sendReplyMedia()`（brain + worker 共用），`sendTaskReply()` 按用户串行 + token 现取 + 额度让位（§19.3–§19.5） |

### 测试

`daemon-routing.test.ts`（`parseBrainEscape` 新写法 + `isFastLane` 未命中收件人时行为不变）、`media-route.test.ts`（收件人/队列语义、`decideInboundRoute` 表驱动、`deliveryTarget`、`purgeForStopped`、`swapRecipient`/`buffer` 的过期与换人边界）、`inbound-media.test.ts`（按角色落盘）、`prompt-media.test.ts`（image 块与降级文案）、`task-manager.test.ts`（media 贯通）、`pool-spawn.test.ts`（首轮约定提示只带一次）、`chat-commands.test.ts`（裸 `#N` / `发给任务 N` / `task-focus` / `回到大脑`）。注：`index.test.ts` 仍只覆盖从 `index.ts` 导出的纯函数，`handleFastItem()` 的分支**没有**端到端用例（需要真实 daemon 状态），其投递目标判定已抽成 `deliveryTarget()` 单测覆盖。

---

## 15. 测试计划（要点）

- **状态机**：滑动 TTL 每次活动都重置；到期有积压→兜底提交、无积压→直接清；`回到大脑` / 任务结束 / TTL 三条清退通道。
- **路由**：非文本 + 收件人→入队且不入 `msgQueue`；非文本 + 无收件人→仍进 `msgQueue`（回归）；文本 + 收件人→`toRecipient`；`问大脑：…` 逃逸→brain 且不收件人变化。
- **提示词**：worker `images:true`→prompt 含 `{type:"image"}`；`images:false`→含降级文本且不含 image block；文件→prompt 含绝对路径。
- **任务侧**：一批附件 + 文本 = 一次 `conn.ask`（一个回合）；`好了` 立即提交；兜底指令格式。
- **额度 / 回执**：per-batch ack 只发一次；进入 / 退出 / 超时回执文案。
- **出站（§19）**：`extractImages()` 抽 markdown / 裸 URL 且不改无媒体正文；`[附件]` 尖括号与普通形式的边界（含 `)` 的路径）；本地图片过 realpath / 扩展名 / 敏感名单 / UNC；http 图片逐跳校验与重定向上限；额度到 `limit - 1` 时媒体被跳过并有失败说明；每会话只提示一次。
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
8. **出站只走一套管线**：`sendReplyMedia()` 是唯一出口，brain 与 worker 都不得自己拼「发图/发文件」逻辑（否则额度、敏感名单、失败说明必然漂移）。
9. **出站两个通道同一套闸**：图片与附件都要过 UNC / 数据流 / realpath / 敏感名单 / 大小；图片通道不是后门。
10. **出站不静默失败**：失败要进失败说明，并给原链接/路径；额度不足也算失败原因之一。
11. **出站与入站状态互不影响**：任务结果永远回 `task.userId`，worker 发媒体不重置收件人 TTL。

## 19. 发送（任务 → 微信）：worker 结果里的媒体

> 本节是反方向：worker 跑完一轮后，结果里的图片 / 文件 / 视频怎么发到微信。入站的收件人模式（§4–§8）解决「用户怎么把媒体交给任务」，本节解决「任务怎么把媒体交回用户」——两者对称，但**不共用状态**：出站不看收件人指针，入站也不受出站影响。

### 19.1 为什么用「回复文本里的约定语法」

三个候选：① 给 worker 挂一个「发送媒体」MCP 工具；② daemon 扫工作区产物自动发；③ 约定语法（Markdown 图片 + `[附件](file:///…)`）。选 ③：

- **不改造 agent**（AGENTS.md §4.14）：MCP 工具要按 agent 复制配置、还要进 `managed` 激活集，成本远大于收益；约定语法对任何能写 Markdown 的 agent 都成立。
- **可审阅**：发什么由 agent 自己的回复决定，日志里能追（`sent image: …` / `sent attachment (file…): …`）。
- **不做「扫目录自动发」**：工作区里的中间产物不该默认外发（可能是草稿、凭证、超大文件）。

代价是 agent 得知道能这么写——由 §19.8 的一次性提示补上。

### 19.2 语法（worker 结果里认什么）

| 写法 | 结果 | 备注 |
| --- | --- | --- |
| `![alt](路径)` / `![alt](https://…)` | 图片 | 可带 `"title"`；同一 `src` 去重 |
| 裸图片 URL（`https://…/x.png`） | 图片 | 只认 `png` / `jpe?g` / `gif` / `webp` / `bmp` |
| `[附件](<路径>)` | 文件或视频 | 带尖括号才能在路径里写 `)` |
| `[文件](file:///…)` | 文件 | `file://` 只接受空 host（`file:///…`） |
| `[视频](file:///…)` | 视频 | 微信侧按视频消息发 |
| `[附件](路径)` | 文件或视频 | 类型由扩展名判（`classifyMediaByName()`） |

实现约束：

- **只认本地绝对路径**：`[附件](https://…)` 保留在正文里，不会把网页当文件下载。图片是唯一接受 http 的通道。
- **普通形式排除 `(` 与 `<`**：`report (1).pdf` 必须写成 `[附件](<…/report (1).pdf>)`，否则整段保留为正文——宁可发不出去，也不把路径截成 `report (1` 发错文件。
- **没有媒体语法时正文原样返回**（不 trim、不压空行），避免改写 Markdown 代码块与缩进；只有确实移除了链接才清理多余空行。
- **代码围栏 / 行内代码里的写法只是示例**（`maskCodeRegions()`，`daemon/messaging/markdown-code.ts`）：agent 教用户「视频写 `[视频](file:///…)`」时不会真去读盘。2026-11-17 真机撞到过——worker 只是一句「图片直接写 `![](路径)` 就行」，daemon 就尝试发送字面量「路径」并在答复后追加一条失败说明。
- **不发出站语音**：微信没有「发语音气泡」的接口，音频请按 `[文件]` 发。

### 19.3 共用出站管线

`index.ts:1544` 的 `sendReplyMedia(to, answer, sends, ctxToken): Promise<{ text; mediaCount }>`：

1. `extractImages()` → 逐张 `resolveImageBytes()` → `canSendMedia()` 检查 → `budgetOf(to).count += 1` → `sendImageOrdered()`；
2. `extractAttachments(cleaned)` → `resolveAttachment(…, { allowSensitive: sensitiveAllowActive() })` → 同额度检查 → `sendFileOrdered()`；
3. `imageFailureNote()` + `attachmentFailureNote()` 拼到正文尾部。

两个调用点：brain 的 `handleMessage()`（`index.ts:726`）与 worker 的 `sendTaskReply()`（`index.ts:1794`）。抽出来的动机是**口径唯一**：额度记账、敏感文件拦截、失败说明三件事原本只存在于 brain 路径，worker 另写一份迟早漂移（评审时就抓到过「worker 路径丢掉 failures」那类漂移）。

### 19.4 顺序、串行与 token

- **先媒体、后正文**：图片/文件各自作为独立消息先发，再发剩余文本；`mediaCount` 只数成功的媒体。
- **只有媒体、没有正文**时不补一条空消息；两者都没有才发「（没有内容）」。
- **按用户串行**：`taskReplyChains: Map<userId, Promise>`（`index.ts:1793`）。媒体要先下载/读盘，并发解析会让后到的短回复抢先发出，用户看到的顺序就和任务完成顺序相反。
- **token 现取**：`sendTaskReply()` 用 `tok()`（`index.ts:1796`）每次发送时读 `state.contextTokens[botId:userId]`，不在下载前捕获——大文件下载几十秒，期间用户又发过消息，旧 token 会 `ret=-2`。
- 出站媒体与正文都走 `MessageState.FINISH`；`sendFileOrdered()` 按 `file` / `video` 分派。

### 19.5 预算与让位

- `canSendMedia(sentCount, limit)`（`image-reply.ts:37`）= `sentCount < limit - 1`：**永远给最终文字留最后一条**。额度按用户、跨回合累计；到线时媒体被跳过，并在失败说明里注明「因接近微信连续发送上限没发」——不静默丢。
- 每张图片、每个文件/视频各占一条（`count += 1`）。媒体不可见为「进度」，不顶替 5s 确认。
- 任务推送是**本轮结果、必须送达**：只累加计数，不被 `awaiting` 暂停（暂停只作用于可丢弃的 brain 进度提示）。但大脑回合已接近上限时最后一条要留给最终答案 → `shouldDeferTaskPush(activeTurn?.from, to, count, CONSEC_SEND_LIMIT)` 为真则 `sends.deferTaskPush()` 排队，回合结束由 `flushDeferredTaskPushes()` 发出（日志「任务推送遇大脑回合额度将满 → 延后到回合结束」）。
- 发送失败（`sendImageOrdered()` / `sendFileOrdered()` 返回 false）只记 WARN + 失败说明，不重试：重试会再占一条额度。

### 19.6 安全闸（与入站附件同一套）

图片通道与附件通道必须过同一组闸，否则「图片通道」会成为绕过敏感名单的后门（`![](C:\…\account.json.png)` 之类）。

- **本地路径**：`assertLocalPath()` 拒 UNC（`\\server\share`、`file://host/…`）与 NTFS 数据流（`account.json::$DATA`）→ `realpath`（扩展名与敏感名单按解析后的真实路径判）→ 图片扩展名（`IMG_EXT`）→ `isSensitiveFilePath()` → 大小上限（图片 10MB）。附件通道更严：软链目标先 `assertLocalPath()`，`realpath` 后再判一次。
- **http 图片**：`assertPublicHttpUrl()` **逐跳**校验（手动跟重定向，最多 3 跳，防 302 到 `127.0.0.1`）→ 15s 超时 → `content-type` 或扩展名 → 10MB。
- **附件**：`resolveAttachment()` 另加「必须是绝对路径」「软链目标先判」「25MB 上限」（`DEFAULT_MAX_BYTES`）。
- **敏感文件**：命中 `isSensitiveFilePath()` 抛 `SensitiveFileError`，不发送，改为记进待补发队列（`rememberPendingSensitive()`）；用户回「允许敏感文件 [分钟]」（默认 2 分钟、上限 30）后补发，`sendReplyMedia()` 里用 `sensitiveAllowActive()` 放行，日志标「敏感文件已临时放行」。窗口只跳过名单，UNC / 数据流 / 大小上限照旧。
- **已知边界**：本机代理把公网域名解析成 `198.18.x` fake-IP 时，`assertPublicHttpUrl()` 会判成内网并拒绝（2026-11-17 真机撞到 `拒绝访问本机/内网地址: img1.kuwo.cn（198.18.0.85）`）。这是既有闸，brain 路径行为相同；本地图片不受影响。

### 19.7 失败说明

失败不静默：按原因归类后拼在正文尾部，保留原始链接/路径，用户可以直接重发。

| 通道 | 原因 | 文案 |
| --- | --- | --- |
| 图片 | `download` | 「有 N 张图片没能下载下来，附原链接」 |
| 图片 | `send` | 「有 N 张图片没能发出去」 |
| 图片 | `budget` | 「有 N 张图片因接近微信连续发送上限没发」 |
| 附件 | `read` | 「有 N 个附件没能读取/校验通过」 |
| 附件 | `send` | 「有 N 个附件没能发出去」 |
| 附件 | `budget` | 「有 N 个附件因接近微信连续发送上限没发」 |
| 附件 | `sensitive` | 「有 N 个附件被敏感文件名单拦下（回复「允许敏感文件」可补发）」 |

### 19.8 可发现性：每会话一次的约定提示

worker agent 默认不知道「写 Markdown 图片就会发出去」。（brain 侧早有另一段同作用的提示：`acp-brain.ts:78` 的 `BRAIN_SYSTEM_HINT`，由 `runTurn` 在每会话首轮推一次，内容更细——建议用 `raw.githubusercontent.com` 这类直链、避开被墙与带热链保护的图床、并说明它自己不会文生图。）`worker-acp.ts` 在**每个会话首轮**追加一次系统提示（`hintedSessions`，键 `<agent>:<sessionId>`，`worker-acp.ts:98` / `:264`），内容为「怎么写就能发」+「占连发额度、别刷屏」+「不支持语音，音频按文件发」，末尾注明「此提示只出现一次，无需理会本句」。

设计取舍：

- **只讲用法，不改能力**：不提内部预算数字，也不替 agent 发明工具（AGENTS.md §4.14）。
- **提示在前、指令在后**：`prompt` 最后一块必须是本轮指令（模型看的是最后那句）；提示只加一次，长任务不会每轮都占 token。
- **按 session 去重**：同一 session 续跑（`session/load`）不重复；换 session（重启、换 agent、新任务）才再来一次。进程重启后 `hintedSessions` 是空的，会再提示一次——多次提示无害，只是多几行 token。
- 任务推送末尾另有一行寻址提示（`task-manager.ts:292` 的 `replyFooter()`）：`↩ 回这条任务用「#N 正文」；不带前缀的消息默认交给大脑（发「#N」可设为收件人）。`——用户学习「回任务」与「设收件人」的主要入口。

### 19.9 与入站路由的关系

- 出站**不看**收件人指针：任务结果永远回给 `task.userId`，不会被「当前收件人是别的任务」影响。
- 入站**不受**出站影响：worker 发图不会重置 TTL、也不改指针（只有「给任务投递内容」才算活动，见 §8.1）。
- 两个方向共享同一份**连发额度**（按用户），所以同一时间窗口里「入站回执 + 进度 + 出站媒体 + 最终文字」是加在一起算的——§19.5 的让位规则就是为此存在。

### 19.10 测试

- `daemon/messaging/image-reply.test.ts`：`extractImages()`（markdown / 裸 URL / 去重 / 正文清理）、`resolveImageBytes()` 的本地安全闸（普通 png / 非图片扩展名 / `id_rsa.png` 敏感名 / UNC）、失败说明文案。
- `daemon/messaging/image-url.test.ts`：`assertPublicHttpUrl()` 与重定向逐跳校验（SSRF）。
- `daemon/messaging/attachments.test.ts`：`extractAttachments()` 的尖括号/普通形式、`resolveAttachment()` 的 UNC / 数据流 / 大小 / 敏感名单 / 允许窗口。
- `daemon/messaging/sensitive-allow.test.ts`：开窗、过期、补发队列。
- `tasks/pool-spawn.test.ts:155`：「首轮多带一次『可发图/发文件』约定提示，之后同一会话不再重复」。
- 未覆盖：`sendReplyMedia()` 本身的端到端（需要真实发送管线）；真机靠日志 `sent image: …` / `sent attachment (file…)` 核对。

### 19.11 真机结果（2026-11-17）

- ✅ worker 结果里的本地图片：`sent image: C:\Users\imwan\.wemind\5699d5d92ea9\workspace\worker\chart.png`。
- ⚠️ http 图片被 fake-IP 判成内网（§19.6 已知边界）。
- 未测：视频、`[文件]` 大文件、敏感文件窗口补发（当时的敏感文件用例写成了全角 `］`，`extractAttachments()` 没匹配到）。


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
⌛ 提醒：收件人 #N 已超时自动取消，之后的文字和附件交给大脑。
📎 超时前收到的 2 个附件已交给 #N。
（这是定时器单独发的提醒，不是对你上一条消息的回复。）
```

附件那一行分三种：交出去了（`已交给 #N。`）、没交出去（`没能交给 #N。`，后面跟失败原因）、以及交出后任务自己回了话（续跑提示之类）——后者原样另起一行附在下面。判据是 `deliverPending()` 的 `onOutcome`，不再靠「返回值非空」。

它是 15s 清扫定时器发的，真机上被误读成「对刚发那句 `任务：…` 的回复」（用户发完任务立刻收到一条 #N 的过期提醒，以为 `任务：` 被当成了追加）。加一行自我标识即可。

### 21.3 `任务：` 一律新建（跨模块的行为变更）

`任务：正文` / `>正文` 不再「有活跃任务就追加」，见 [远程任务（Worker）human-in-the-loop 设计与实现](<远程任务（Worker）human-in-the-loop 设计与实现.md>) 的 2026-11-17 补充与 [repowiki/07](../repowiki/07-远程任务-Worker.md)。它仍会把新任务设为收件人（`dispatchTask` 的 `onTaskId` → `armAndFlush()`），所以附件链路不变；并行时回执多一句 `parallelTaskHint()` 教学。
