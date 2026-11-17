#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  createLogger,
  describeError,
  getUpdates,
  sendMessage,
  sendTyping,
  getConfig,
  notifyStart,
  generateId,
  SESSION_EXPIRED_ERRCODE,
  isSessionPaused,
  pauseSession,
  getRemainingPauseMs,
  loadAccount,
  loadState,
  saveState,
  DATA_DIR,
  MessageItemType,
  MessageState,
  MessageType,
  sendImage,
  sendFile,
  sendItem as sendMessageItem,
  ILinkError,
  classifyTransportError,
  isAllowed,
  addAllowFrom,
  readAllowFrom,
  compareMessageIds,
  maxMessageId,
  rememberMessageId,
} from "@wemind/wechat-ilink-core";
import type { AccountData, ServerState, SendMessageReq } from "@wemind/wechat-ilink-core";
import { askBrain, supportsImages, heartbeatMs } from "./acp/acp-brain.js";
import { agentProblem, BRAIN_CONFIG_EXIT_CODE } from "./agents/brain-agents.js";
import {
  brokenAgentDefinitionMessage,
  findAgentDefinitionSource,
  getAgentRegistry,
} from "./agents/agent-registry.js";
import { preloadAgentAdapters } from "./agents/agent-adapter-loader.js";
import { switchInFlightTarget } from "./acp/brain-switch.js";
import { loadBrainConfig } from "./agents/brain-config.js";
import { getAgent, seedSlots } from "./agents/agent-slot.js";
import { writeBrainState } from "./agents/brain-state.js";
import { CLI_PID_MARKERS, findOtherOurProcess } from "./shared/process/proc-identity.js";
import { DAEMON_ALREADY_RUNNING_EXIT_CODE } from "./cli/watchdog-runner.js";
import { isOwnerOnly } from "./ipc/chat-commands.js";
import { ensureBrainHome } from "./agents/managed/mcp-brain.js";
import {
  clearReloadPending,
  readHomeMode,
  readReloadMarker,
  type HomeMode,
} from "./agents/config/home-mode.js";
import { ensureParityAccountDirs } from "./agents/config/account-bootstrap.js";
import { migrateLegacyHomes } from "./agents/config/migrate-legacy.js";
import { readWechatSettings, replyStyleHint } from "./agents/config/wechat-settings.js";
import { syncFromPointerMap } from "./sessions/session-registry.js";
import { clearControlDirs, markBridgeReady } from "./ipc/control-bridge.js";
import { ControlInboxRunner } from "./daemon/control-inbox-runner.js";
import { clearHandoff, handoffPrefix, loadHandoff, takeHandoffFor } from "./sessions/handoff.js";
import {
  canSendMedia,
  extractImages,
  imageFailureNote,
  planImageTurn,
  resolveImageBytes,
  type ImageFailure,
} from "./daemon/messaging/image-reply.js";
import {
  attachmentFailureNote,
  extractAttachments,
  isSensitiveFileError,
  resolveAttachment,
  type AttachmentFailure,
} from "./daemon/messaging/attachments.js";
import {
  rememberPendingSensitive,
  sensitiveAllowActive,
  takePendingSensitive,
  type PendingSensitiveAttachment,
} from "./daemon/messaging/sensitive-allow.js";
import { mediaInboxDir, pruneInboundMediaIfDue } from "./daemon/messaging/media-store.js";
import {
  composeAgentText,
  isFlushWord,
  mediaInstructionFallback,
  prepareInboundMedia,
} from "./daemon/messaging/inbound-media.js";
import {
  decideInboundRoute,
  deliveryTarget,
  MediaRoute,
  waitForSettledAttachments,
  type PendingBatch,
} from "./daemon/media-route.js";
import { LONG_REPLY_THRESHOLD, buildMdReply } from "./daemon/messaging/md-reply.js";
import { isAuthorizedSender } from "./daemon/access.js";
import { handleControl, handleControlRequest } from "./daemon/daemon-control.js";
import { shouldDeferTaskPush } from "./daemon/messaging/pending-push.js";
import { SendPipeline } from "./daemon/messaging/send-pipeline.js";
import { finishPollBatch } from "./daemon/messaging/poller-batch.js";
import {
  dispatchTask,
  injectTask,
  stopTask,
  findRecipientTask,
  hasActiveTask,
  liveTasks,
  awaitingTasks,
  interruptedTasks,
  shouldResumeTask,
  renderTaskList,
  taskKeyOf,
  initTasks,
  setTaskPush,
  setTaskTyping,
  setTaskStateSink,
  setTaskAckSink,
  type TaskStateSnapshot,
} from "./tasks/task-manager.js";
import { clearTaskDirs, writeTaskAck } from "./tasks/task-inbox.js";
import { scanTaskInbox } from "./daemon/task-inbox-runner.js";
import { killAll as killWorkerPool, sweep as sweepWorkerPool } from "./tasks/worker-pool.js";
import { ensureWorkerHome } from "./agents/managed/mcp-worker.js";
import { bindLogger } from "./shared/io/leveled-log.js";
import { createRepeatLog } from "./shared/io/repeat-log.js";
import { CLI_VERSION } from "./shared/version.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

import {
  brainErrorMessage,
  brainFailurePlan,
  contentlessNotice,
  extractInbound,
  formatQuote,
  isFastLane,
  passMcpToggleToBrain,
  parseBrainEscape,
  parseControl,
  parseTaskControl,
  PROGRESS_ACK_DELAY_MS,
  PROGRESS_SECOND_NOTICE_MS,
  secondNoticeText,
  shouldResumeInBrainQueue,
  shouldShowAck,
  shouldShowSecondNotice,
  toolIcon,
  toolSummary,
  type InboundAttachment,
  type QuoteContext,
  type TaskFacts,
} from "./daemon/daemon-routing.js";
const log = createLogger("wechat-daemon");
const leveledLog = bindLogger(log);

export {
  brainErrorMessage,
  brainFailurePlan,
  isFastLane,
  parseBrainEscape,
  parseControl,
  parseTaskControl,
  shouldResumeInBrainQueue,
} from "./daemon/daemon-routing.js";
export type { TaskFacts } from "./daemon/daemon-routing.js";

async function setTyping(
  account: AccountData,
  to: string,
  ctx: string | undefined,
  status: 1 | 2,
): Promise<void> {
  if (!ctx) return;
  try {
    const cfg = await getConfig({
      baseUrl: account.baseUrl,
      token: account.botToken,
      ilinkUserId: to,
      contextToken: ctx,
    });
    await sendTyping({
      baseUrl: account.baseUrl,
      token: account.botToken,
      body: { ilink_user_id: to, typing_ticket: cfg.typing_ticket, status },
    });
  } catch (e) {
    // typing 是体验增强（best-effort 不阻断），但失败要留痕：区分「偶发网络失败」与「ticket 拿不到」
    log.warn(`setTyping(${status}) failed:`, String(e));
  }
}

async function reply(
  account: AccountData,
  to: string,
  ctx: string | undefined,
  text: string,
  state: number = MessageState.FINISH,
  fallbackToken?: string,
  runId?: string,
): Promise<void> {
  const send = (token: string | undefined) => {
    const req: SendMessageReq = {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: generateId("wemind/wechat-daemon"),
        message_type: MessageType.BOT,
        message_state: state,
        item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
        context_token: token,
        // 同一回合的所有外发消息共用 run_id，客户端据此把进度/工具 item 归到当前回复（官方 2.4.10 行为）。
        run_id: runId,
      },
    };
    return sendMessage({ baseUrl: account.baseUrl, token: account.botToken, body: req });
  };
  try {
    await send(ctx);
  } catch (e) {
    // ret=-2 既可能是「限流」(rapid sends)也可能是「context_token 失效/不匹配」(参数错误)。
    // 两者都靠：退避 ~1.5s 后重试一次——限流靠等待恢复，失效 token 则换用该用户最新缓存 token。
    if (e instanceof ILinkError && e.kind === "param_error") {
      log.warn("send -2(限流或token失效) → 退避 1.5s 后重试");
      await new Promise((r) => setTimeout(r, 1500));
      await send(fallbackToken && fallbackToken !== ctx ? fallbackToken : ctx);
      return;
    }
    // 传输层错误（网络抖动 fetch failed/ECONNRESET/超时等）：可重试类退避 1.5s 后重试一次
    if (!(e instanceof ILinkError)) {
      const t = classifyTransportError(e);
      if (t.retryable) {
        log.warn(`send 传输错误(${t.kind}) → 退避 1.5s 后重试`);
        await new Promise((r) => setTimeout(r, 1500));
        await send(ctx);
        return;
      }
    }
    throw e;
  }
}

/** 统一的发送错误处理：按错误类型分类记录；会话过期则暂停账号。 */
function handleSendError(e: unknown, account: AccountData): void {
  if (e instanceof ILinkError) {
    log.warn("send error:", e.message);
    if (e.kind === "session_expired") {
      pauseSession(account.botId);
      log.warn("会话过期(-14) on send → 该账号暂停 1h，待重新登录");
    }
  } else {
    const t = classifyTransportError(e);
    log.warn(`send error(传输/${t.kind}${t.retryable ? ",可重试" : ""}):`, t.message);
  }
}

// iLink 在用户回复前能连续发送的消息数上限（实测约 10，可调）。
const CONSEC_SEND_LIMIT = Number(process.env.WECHAT_CONSEC_SEND_LIMIT) || 10;
// 工具进度默认发文本「步骤 N」。结构化 item（11/12）**默认关闭**：官方 2.4.10 虽然定义了它，但真机微信客户端
// 不渲染（服务端 200、空响应、不分配 message_id；2026-08 第三方 SDK 与 2026-10 galley 均复现），发了只会白占带宽/打断 typing。
// 设 WECHAT_TOOL_PROGRESS_ITEMS=1 可提前启用（协议已对齐 FINISH + run_id，等微信端开放即可用）。
const TOOL_PROGRESS_ITEMS = process.env.WECHAT_TOOL_PROGRESS_ITEMS === "1";
// 工具完成提示（✅ 步骤 N）只在工具耗时达到该值时发：短工具只留开始时的一条，避免每条命令都刷出两条消息。
const TOOL_END_NOTICE_MIN_MS = 10_000;

/** 工具从开始到结束的耗时是否值得再发一条完成提示。导出仅供单测。 */
export function shouldSendToolEnd(startedAt: number, endedAt: number): boolean {
  return endedAt - startedAt >= TOOL_END_NOTICE_MIN_MS;
}

/** 进度发送的额度/可见性决策（纯函数，导出仅供单测）；副作用留给 emitProgress 执行。 */
export type ProgressEmissionPlan =
  | { kind: "send"; countsBudget: boolean }
  | { kind: "pause" }
  | { kind: "skip" };

export function planProgressEmission(
  budget: { count: number; awaiting: boolean },
  limit: number,
  opts: { countBudget?: boolean; visible?: boolean } = {},
): ProgressEmissionPlan {
  if (budget.awaiting) return { kind: "skip" };
  const countsBudget = opts.countBudget !== false;
  const visible = opts.visible !== false;
  if (budget.count >= limit - 2) {
    // 可见进度到线：发「接近上限」提示并进入等待；不可见的结构化 item 到线直接跳过——它失败时会回退成一条可见文本，不能挤掉留给最终答案的额度，也不该触发可见的暂停提示。
    return visible && countsBudget ? { kind: "pause" } : { kind: "skip" };
  }
  return { kind: "send", countsBudget };
}

/**
 * `任务：…` 派发成功后的追加说明：派发时若还有别的任务活着（running/waiting），补一句「并行 + 怎么接着它说话」。
 *
 * 2026-11-17 起 `任务：` 一律新建任务，不再「有活跃任务就追加」，所以并行会真实发生；
 * 这里只是教学入口（用户靠它学 `#N 正文` 与收件人写法），不阻止也不改变派发结果。没有并行时返回空串。
 */
export function parallelTaskHint(others: Array<{ id: number }>): string {
  if (others.length === 0) return "";
  const ids = others.map((t) => `#${t.id}`).join("、");
  return `\n（${ids} 还在跑，两条并行；要接着它说就发「#N 正文」，或先发「#N」把它设为收件人。）`;
}

// 静默期心跳默认 15s（配置可放宽，如 DSH 的 60s）；间隔在每回合开头算，见 handleMessage 的 heartbeatMsValue。
const HEARTBEAT_DEFAULT_MS = 15_000;

/** -2（param_error）：既可能是限流、也可能是 token 还是旧的——两者都值得「等该用户下一条消息再试」。 */
const isParamError = (e: unknown): boolean => e instanceof ILinkError && e.kind === "param_error";

/**
 * 外发管线（串行链、最小间隔、连发预算、旧 token 挂起/补发、任务推送让位）都在 `send-pipeline.ts`，
 * 这里只把它接到本账号的真实发送函数上。拆出去是为了让这些编排可以单测（见 `send-pipeline.test.ts`）。
 */
function createSendPipeline(account: AccountData): SendPipeline {
  return new SendPipeline({
    sendText: (to, ctx, text, state, fallbackToken) =>
      reply(account, to, ctx, text, state, fallbackToken, activeTurn?.runId),
    sendImage: (to, ctx, image) =>
      sendImage({
        baseUrl: account.baseUrl,
        token: account.botToken,
        to,
        image,
        contextToken: ctx,
      }),
    sendFile: (to, ctx, data, fileName, kind) =>
      sendFile({
        baseUrl: account.baseUrl,
        token: account.botToken,
        to,
        data,
        fileName,
        kind,
        contextToken: ctx,
      }),
    sendItem: async (to, ctx, item, state) => {
      await sendMessageItem({
        baseUrl: account.baseUrl,
        token: account.botToken,
        to,
        item,
        contextToken: ctx,
        state,
        runId: activeTurn?.runId,
      });
    },
    sendFileMd: async (to, ctx, text) => {
      const { fileName, data } = buildMdReply(text);
      await sendFile({
        baseUrl: account.baseUrl,
        token: account.botToken,
        to,
        data,
        fileName,
        kind: "file",
        contextToken: ctx,
      });
      log.info(`final as md file: ${fileName} (${text.length} chars)`);
    },
    onSendError: (e) => handleSendError(e, account),
    isParamError,
    log: leveledLog,
    minGapMs: Number(process.env.WECHAT_MIN_SEND_GAP_MS) || 1500,
    consecLimit: CONSEC_SEND_LIMIT,
  });
}

// 当前进行中回合（worker 串行，只有一个）：记录发往用户与所用 token（token 可被「继续」更新）。
let activeTurn: { from: string; token: string | undefined; runId: string } | null = null;

// 微信设置的坏文件告警去重：每轮都会读一次设置，坏一次不能每轮刷一行日志。
let warnedWechatSettingsProblem = "";
// homeMode 在启动时定一次：运行期改 runtime.json 不该让同一批消息一半按 direct、一半按 managed 处理。
// `wemind config home-mode` 的回执明确要求重启 daemon，运行期覆盖不属于受支持的用法。
let homeModeAtBoot: HomeMode = "direct";

/**
 * 处理一条发给大脑的消息。返回**是否真的答成了**（`brainErrorMessage` 兜底算没答成）——
 * 交接摘要的清除就靠这个返回值：只有答成了才把摘要删掉（失败留着，下次还能用）。
 */
async function handleMessage(
  account: AccountData,
  sends: SendPipeline,
  ctx: string | undefined,
  to: string,
  text: string,
  attachments: InboundAttachment[],
  messageId: string,
  createTimeMs?: number,
  latestToken?: () => string | undefined,
): Promise<boolean> {
  const msgAge = () => (createTimeMs ? `${Math.round((Date.now() - createTimeMs) / 1000)}s` : "?"); // 这条消息已存在多久（诊断用）
  // activeTurn 只存当前回合的 from/token；连续发送计数用按用户、跨回合的 budgetOf(to)（不在回合开始清零）。
  activeTurn = { from: to, token: ctx, runId: randomUUID() };
  const cx = () => activeTurn?.token ?? ctx;
  await setTyping(account, to, cx(), 1);
  // 处理期间每 5s 续发"正在输入"（sendtyping 不计入连续消息上限），避免长任务时指示消失、用户以为卡了。
  // 客户端自动过期约 5–8s；发消息本身会顶掉 typing，送达后由 sendWithTyping 立刻补一次，这条瞬时闪烁靠补发缓解。
  const keepAlive = setInterval(() => {
    void setTyping(account, to, cx(), 1).catch(() => {});
  }, 5000);

  const t0 = Date.now();
  let lastProgressAt = t0; // 心跳基线：任意帧（含思考/工具活动）都会刷新
  let lastNonAckProgressAt = t0; // 上一条除 5s 确认以外的可见进度
  let visibleProgressSent = false;
  let finalStarted = false;
  let answerStarted = false;
  let secondNoticeSent = false;
  // 三档进度：<5s 只发最终答案；5–15s 第 5s 发确认；≥15s 第 15s 再发第二条。
  // 固定提示让位于已有进度（工具/心跳/图片/重试），避免叠加；「正在输入」由 keepAlive 每 5s 续发。
  let ackTimer: NodeJS.Timeout | undefined;
  let secondTimer: NodeJS.Timeout | undefined;
  const cancelAck = () => {
    if (ackTimer) {
      clearTimeout(ackTimer);
      ackTimer = undefined;
    }
  };
  const cancelSecond = () => {
    if (secondTimer) {
      clearTimeout(secondTimer);
      secondTimer = undefined;
    }
  };
  // 心跳间隔**每回合**取一次：热切换大脑后新 agent 的心跳覆盖要立刻生效（改造前是 import 期定死的常量，
  // 切到 DSH（heartbeatMs=60s）却还按旧大脑的 15s 发心跳，白占微信连发额度）。
  const heartbeatMsValue =
    Number(process.env.WECHAT_BRAIN_HEARTBEAT_MS) || heartbeatMs() || HEARTBEAT_DEFAULT_MS;
  // iLink 限制 bot 在用户回复前连续发送的消息数（实测约 10，超出被 ret=-2 拒）。计数按用户跨回合维护(budgetOf)。
  // 当已发到「上限-2」(默认第8条)后，下一条进度改为「即将达上限」提示并进入等待，把最后一条额度留给最终答案；用户回复「继续」(或发任何消息)会重置计数恢复发送（见 poller）。
  /**
   * 发任意进度：统一处理待发确认、额度、接近上限的暂停提示与 typing 续命。
   * `countBudget: false` + `visible: false` 用于结构化工具 item：它们不占「用户可见消息」的连发额度（真机客户端不渲染时尤其不能白占），也不该顶替 5s 确认/15s 第二条；item 发送失败回退成文本时，由 `accountForFallback` 在文本确实发出后按可见进度补记账。
   */
  const emitProgress = (
    send: () => Promise<unknown>,
    opts?: { ackOnly?: boolean; countBudget?: boolean; visible?: boolean },
  ): boolean => {
    const visible = opts?.visible !== false;
    if (visible) cancelAck(); // 可见进度顶替待发的即时确认；不可见 item 不能取消它
    lastProgressAt = Date.now(); // 任意帧（含不渲染的 item）都刷新心跳基线
    const b = sends.budgetOf(to);
    const plan = planProgressEmission(b, CONSEC_SEND_LIMIT, opts);
    if (plan.kind === "skip") return false; // 等待「继续」期间、或 item 额度吃紧：不发任何进度
    if (visible) {
      visibleProgressSent = true;
      if (!opts?.ackOnly) lastNonAckProgressAt = Date.now(); // 5s 确认不能挡住 15s 的第二条
    }
    // 发出一条进度会把客户端刚显示的「正在输入」顶掉 → 消息送达后立刻补发一次 typing，否则接下来的等待窗口看不到指示。
    const sendWithTyping = (run: () => Promise<unknown>) => {
      void run()
        .then(() => setTyping(account, to, cx(), 1))
        .catch(() => {});
    };
    if (plan.kind === "pause") {
      b.count += 1;
      b.awaiting = true;
      sendWithTyping(() =>
        sends.sendOrdered(
          to,
          cx(),
          "⚠️ 接近微信连续消息上限，我先暂停进度提示、继续在后台处理；完成后会把结果直接发给你。想立刻恢复进度可回复「继续」。",
          MessageState.GENERATING,
        ),
      );
      return false;
    }
    if (plan.countsBudget) b.count += 1;
    sendWithTyping(send);
    return true;
  };
  /** 结构化 item 失败回退成可见文本后补记账：占一条额度，并顶替 5s 确认/15s 第二条。 */
  const accountForFallback = () => {
    cancelAck();
    visibleProgressSent = true;
    lastNonAckProgressAt = Date.now();
    sends.budgetOf(to).count += 1;
  };
  const sendProgress = (msg: string, opts?: { ackOnly?: boolean }) =>
    emitProgress(() => sends.sendOrdered(to, cx(), msg, MessageState.GENERATING), opts);
  // 第 5s 的即时确认：只在之前没有任何可见进度时发（工具/心跳/图片/附件提示都会顶替它）。
  if (attachments.length === 0) {
    const t = cx();
    log.info(`turn start to=${to} msgAge=${msgAge()} usingCtx=…${t ? t.slice(-12) : "NONE"}`);
    ackTimer = setTimeout(() => {
      ackTimer = undefined;
      if (finalStarted || !shouldShowAck(visibleProgressSent)) return;
      sendProgress("🤖 收到，正在处理…", { ackOnly: true });
    }, PROGRESS_ACK_DELAY_MS);
    ackTimer.unref?.();
  }
  // 第 15s 的第二条：正文已开始→「整理回复」，否则→「还在处理中」；距上一条非确认进度不足 5s 就跳过（工具/心跳刚提示过）。
  secondTimer = setTimeout(() => {
    secondTimer = undefined;
    const now = Date.now();
    if (secondNoticeSent || finalStarted) return;
    if (!shouldShowSecondNotice(now - t0, finalStarted, now - lastNonAckProgressAt)) {
      return;
    }
    secondNoticeSent = true;
    sendProgress(secondNoticeText(answerStarted));
  }, PROGRESS_SECOND_NOTICE_MS);
  secondTimer.unref?.();
  // 心跳：仅当 brain 真正静默(无任何帧)超过心跳间隔才提示——首条用友好措辞，后续才带计时
  let hbCount = 0;
  const heartbeat = setInterval(() => {
    if (Date.now() - lastProgressAt >= heartbeatMsValue) {
      hbCount += 1;
      sendProgress(
        hbCount === 1
          ? "🤔 还在思考/检索中…"
          : `⏳ 仍在处理中…（已 ${Math.round((Date.now() - t0) / 1000)} 秒）`,
      );
    }
  }, heartbeatMsValue);

  // 下载入站媒体：图片走 ACP image block；文件/视频/无转写语音落盘，把绝对路径交给大脑。brain 与 worker 共用同一实现。
  const prepared = await prepareInboundMedia(attachments, {
    messageId,
    onHint: (t) => sendProgress(t),
  });
  const images = prepared.images;
  const incomingNotes = prepared.notes;
  const incomingFailures = prepared.failures;

  const rejectWith = async (msg: string, logMsg: string): Promise<boolean> => {
    clearInterval(keepAlive);
    clearInterval(heartbeat);
    finalStarted = true;
    cancelAck();
    cancelSecond();
    await setTyping(account, to, cx(), 2);
    sends.budgetOf(to).count += 1;
    let sendFailed = false;
    try {
      await sends.sendOrdered(to, cx(), msg, MessageState.FINISH, undefined, (e) => {
        sendFailed = true;
        sends.holdUndelivered(to, msg, e);
      });
      log.info(logMsg);
    } finally {
      sends.flushDeferredTaskPushes(to, latestToken ? latestToken() : cx(), sendFailed);
      activeTurn = null;
    }
    return false; // 没有答成：交接摘要不能被清除
  };

  // 收图后怎么走：全部下载失败/大脑不支持时，有文字（或其它附件）就只按文字答，没内容就直接拒绝。
  const hasTextOrOther = !!text.trim() || incomingNotes.length > 0;
  const plan = planImageTurn(prepared.imageCount, images.length, supportsImages(), hasTextOrOther);
  if (plan.kind === "reject")
    return rejectWith(plan.text, "image unusable and no text; rejected gracefully");
  const imageNote = plan.kind === "text-only" ? plan.note : "";
  if (imageNote)
    log.warn(`image ignored (${images.length}/${prepared.imageCount} usable): ${imageNote}`);
  if (!hasTextOrOther && images.length === 0) {
    const reason = incomingFailures.length
      ? `📎 附件没能下载下来（${incomingFailures.join("、")}），请重新发一次。`
      : "这条消息里没有可处理的内容，请换一种形式再发一次。";
    return rejectWith(reason, "attachments unusable and no text; rejected gracefully");
  }

  // 一次尝试：带进度（步骤编号每次尝试重置）。进度消息节流：避免一回合刷十几条触发 iLink 发送限流（疑似 ret=-2 主因）
  const attempt = (promptText: string, imgs: typeof images): Promise<string> => {
    answerStarted = false; // 每次重试重新判断本轮正文是否开始，避免上一轮失败尝试的残留
    let step = 0;
    let lastToolStartAt = 0;
    const toolSteps = new Map<string, { step: number; startedAt: number }>();
    const toolName = (ev: { title?: string; kind?: string }) =>
      ev.title?.trim() || ev.kind?.trim() || "tool";
    const toolStatus = (status?: string) =>
      status === "completed" || status === "failed" || status === "blocked" ? status : "unknown";
    return askBrain(
      to,
      promptText,
      (ev) => {
        if (ev.type === "tool") {
          lastProgressAt = Date.now(); // 工具活动刷新心跳基线
          const isEnd = ev.phase === "end";
          const key = ev.toolCallId ?? ev.title ?? "tool";
          if (isEnd) {
            // 只给「已发过 start」的工具发结果：start 被节流时不能空降一个编号不对的 ✅。
            const entry = toolSteps.get(key);
            if (entry === undefined) return;
            toolSteps.delete(key);
            // 短工具只留开始那一条；只有 ≥10s 的工具才值得再发完成提示，避免刷屏与占用连发额度。
            if (!shouldSendToolEnd(entry.startedAt, Date.now())) return;
            const desc = toolSummary(ev.kind, ev.title, ev.purpose, ev.detail);
            const text = `✅ 步骤 ${entry.step} 完成：${desc}`;
            if (TOOL_PROGRESS_ITEMS) {
              emitProgress(
                () =>
                  sends.sendItemOrdered(
                    to,
                    cx(),
                    {
                      type: MessageItemType.TOOL_CALL_RESULT,
                      create_time_ms: Date.now(),
                      is_completed: true,
                      tool_call_result_item: {
                        tool_name: toolName(ev),
                        tool_call_id: ev.toolCallId,
                        status: toolStatus(ev.status),
                      },
                    },
                    text,
                    accountForFallback,
                  ),
                { countBudget: false, visible: false },
              );
            } else {
              sendProgress(text);
            }
            return;
          }
          // start 每 15s 最多一条防刷屏；end 不参与这个间隔（它与自己的 start 成对）。
          if (Date.now() - lastToolStartAt < 15000) return;
          const toolStartedAt = Date.now();
          const nextStep = step + 1;
          const desc = toolSummary(ev.kind, ev.title, ev.purpose, ev.detail);
          const text = `${toolIcon(ev.kind)} 步骤 ${nextStep} 开始：${desc}`;
          const emitted = TOOL_PROGRESS_ITEMS
            ? emitProgress(
                () =>
                  sends.sendItemOrdered(
                    to,
                    cx(),
                    {
                      type: MessageItemType.TOOL_CALL_START,
                      create_time_ms: Date.now(),
                      is_completed: false,
                      tool_call_start_item: {
                        tool_name: toolName(ev),
                        tool_call_id: ev.toolCallId,
                      },
                    },
                    text,
                    accountForFallback,
                  ),
                { countBudget: false, visible: false },
              )
            : sendProgress(text);
          // 额度用尽/等待「继续」时 emitProgress 没真正发出：不占步骤号，也不记 start，
          // 否则用户恢复后 end 会补一个从未出现过的编号。
          if (!emitted) return;
          lastToolStartAt = Date.now();
          step = nextStep; // 只在真正发出时递增，保证步骤号连续（不因节流跳号）
          toolSteps.set(key, { step: nextStep, startedAt: toolStartedAt });
        } else if (ev.type === "thinking") {
          lastProgressAt = Date.now();
        } else if (ev.type === "answer") {
          answerStarted = true; // 只用于第 15s 第二条选词；不再额外补发「整理回复」
        } else {
          // activity：brain 产出任意帧 → 静默刷新心跳基线，避免流式输出期间误报"仍在处理"
          lastProgressAt = Date.now();
        }
      },
      imgs,
    );
  };

  // 带分类的重试：provider 侧永久错误只试 1 次；backend(模型后端瞬时错误 -32603 等)最多 3 次；timeout/other 最多 2 次
  const runWithRetry = async (promptText: string, imgs: typeof images): Promise<string> => {
    let n = 0;
    while (true) {
      n++;
      try {
        return await attempt(promptText, imgs);
      } catch (e) {
        const plan = brainFailurePlan(e);
        log.warn(`brain error (try ${n}, ${plan.category}): ${String(e)}`);
        if (n < plan.attemptLimit) {
          sendProgress(
            plan.category === "backend"
              ? "⚠️ 模型后端临时出错，正在重试…"
              : "⏳ 响应中断了，正在自动重试…",
          );
          continue;
        }
        throw e;
      }
    }
  };

  const imagesForBrain = plan.kind === "text-only" ? [] : images; // 大脑不支持看图时别再塞图片（会 -32602）
  // 微信侧回复风格：每轮现读一次 `<账号>/wechat-settings.json`，改完下一条消息即生效（不需要 reload / 新会话）。
  const wxSettings = readWechatSettings(DATA_DIR);
  if (wxSettings.problem) {
    if (wxSettings.problem !== warnedWechatSettingsProblem) {
      warnedWechatSettingsProblem = wxSettings.problem;
      log.warn(`wechat-settings: ${wxSettings.problem}`);
    }
  } else {
    // 坏→好时清掉去重串：之后再坏成同一种问题要重新告警，不能被上一次的去重吞掉。
    warnedWechatSettingsProblem = "";
  }
  const promptText = [
    text.trim(),
    incomingNotes.join("\n"),
    replyStyleHint(wxSettings.settings.replyStyle),
  ]
    .filter(Boolean)
    .join("\n\n");
  let answer: string;
  let ok = true;
  try {
    answer = await runWithRetry(promptText, imagesForBrain);
  } catch (e2) {
    ok = false; // 重试也失败 → 只是把错误提示当回复发出去，不算「答成」（交接摘要据此决定留不留）
    answer = brainErrorMessage(e2, getAgent("brain").name);
  } finally {
    clearInterval(keepAlive);
    clearInterval(heartbeat);
    finalStarted = true;
    cancelAck();
    cancelSecond();
  }
  await setTyping(account, to, cx(), 2);
  // 发图 / 发文件：先各自作为独立消息发出，余下正文再发（与 worker 任务推送共用同一套口子）
  const { text: cleanedText, mediaCount } = await sendReplyMedia(to, answer || "", sends, cx);
  let finalText = cleanedText;
  if (imageNote) finalText = finalText ? `${imageNote}\n${finalText}` : imageNote;
  const inboundNote = incomingFailures.length
    ? `（有 ${incomingFailures.length} 个入站附件没能下载：${incomingFailures.join("、")}）`
    : "";
  if (inboundNote) finalText = [finalText, inboundNote].filter(Boolean).join("\n\n");
  if (!finalText && mediaCount === 0) finalText = "（没有内容）";
  let finalSendFailed = false;
  if (finalText) {
    sends.budgetOf(to).count += 1; // 最终答案占一条额度（等待段预留的最后一条）
    log.info(
      `final send: msgAge=${msgAge()} sent=${sends.budgetOf(to).count} len=${finalText.length}`,
    );
    const ft = latestToken ? latestToken() : undefined;
    const onError = (e: unknown) => {
      finalSendFailed = true;
      sends.holdUndelivered(to, finalText, e);
    };
    if (finalText.length > LONG_REPLY_THRESHOLD) {
      await sends.sendMdOrdered(to, cx(), finalText, ft, onError); // 长回复 → .md 文件（一条消息）
    } else {
      await sends.sendOrdered(to, cx(), finalText, MessageState.FINISH, ft, onError);
    }
  }
  log.info(`replied to ${to} (msgAge=${msgAge()}): ${(answer || "").slice(0, 60)}`);
  sends.flushDeferredTaskPushes(to, latestToken ? latestToken() : cx(), finalSendFailed);
  activeTurn = null; // 回合结束（计数 budgetOf 不清零，留待用户下条消息重置）
  return ok;
}

// ===== 解耦：拉取器(poller) 与 处理器(worker) 通过队列协作 =====
// 大脑(ACP session)严格串行，但「拉取消息/抓 token」无需串行。把两者解耦：
// poller 持续 getUpdates、实时更新 token、把消息入队，永不被大脑阻塞；worker 串行从队列取消息喂大脑（尊重 kiro-cli 串行约束），发送时取最新 token，规避 ret=-2。
type QueuedMsg = {
  from: string;
  text: string;
  attachments: InboundAttachment[];
  quote?: QuoteContext;
  unsupportedTypes: number[];
  messageId: string;
  createTimeMs?: number;
  contextToken?: string;
  /** 收件人模式下，这条纯文本消息要交给的任务编号（与待投递队列一起提交）。 */
  toRecipientTaskId?: number;
};
const msgQueue: QueuedMsg[] = [];
let wakeWorker: (() => void) | null = null;
function notifyWorker(): void {
  const w = wakeWorker;
  wakeWorker = null;
  if (w) w();
}
/**
 * 快车道：控制指令与任务指令不进大脑队列。大脑一条回合可能跑十几分钟，若共用队列，
 * 「结束任务」「任务列表」「#n 继续」会一直排在那条回合后面——任务侧明明独立于大脑。
 * 快车道自己串行（命令之间保序），只与大脑并发。
 */
const fastQueue: QueuedMsg[] = [];
let wakeFast: (() => void) | null = null;
function notifyFast(): void {
  const w = wakeFast;
  wakeFast = null;
  if (w) w();
}

// ===== 收件人模式：让 worker 也能收到图片/文件这类没有文字可寻址的消息 =====
// 微信一条消息塞不下「文字 + 图片」，图片/文件单独到达、正文为空，路由只能靠上文状态。
// 收件人指向某条任务；在它到期前，非文本消息进「待投递队列」，纯文本（非命令）标记为一起提交；
// 提交点（文本到达 / 「好了」 / 空闲到期）把附件与文字合成一个多模态回合交给任务。内存态、不落盘。
// 默认 3 分钟：发一组图（每张是一条消息）+ 补一句说明常常超过 1 分钟，太短会在中途切回大脑。
const MEDIA_RECIPIENT_TTL_MS = Number(process.env.WEMIND_MEDIA_RECIPIENT_TTL_MS) || 180_000;
const mediaRoute = new MediaRoute(MEDIA_RECIPIENT_TTL_MS);
// 提交前等「后到的图」并批的静默窗口。微信里一张图一条消息，连发几张再立刻发文字时，最后几张往往还在路上；
// 等到队列安静 `MEDIA_FLUSH_DEBOUNCE_MS` 才提交（用户一直发图时最多等到 `MEDIA_FLUSH_DEBOUNCE_MAX_MS`）。0 = 关闭。
const MEDIA_FLUSH_DEBOUNCE_MS = (() => {
  const v = Number(process.env.WEMIND_MEDIA_FLUSH_DEBOUNCE_MS ?? 700);
  return Number.isFinite(v) && v >= 0 ? v : 700;
})();
const MEDIA_FLUSH_DEBOUNCE_MAX_MS = 3_000;

/**
 * 任务被结束时清掉与它相关的收件人状态（微信 `结束任务` 与本地 `wemind task-stop` 共用）。
 * 指针可能已过期（15s 清扫还没轮到），所以「是不是它」同时看指针与批次归属；只清自己，不误伤后来设置的收件人。
 * 返回被丢弃的暂存附件数（调用方据此在回执里交代清楚）。
 */
function purgeMediaRouteForStopped(from: string, id?: number | "all"): number {
  const dropped = mediaRoute.purgeForStopped(
    from,
    id,
    (taskId) => !!findRecipientTask(from, taskId),
  );
  if (dropped > 0)
    log.info(
      `media-route: stop #${id ?? "?"} dropped ${dropped} buffered attachment(s)（${from}）`,
    );
  return dropped;
}

/**
 * 把一批暂存附件（可带正文）作为一个**多模态回合**投递给任务。
 * 返回需要回给用户的说明（成功且无异常时为空串）。
 */
async function deliverPending(params: {
  from: string;
  taskId: number;
  batch: PendingBatch;
  head: string;
  messageId: string;
  onHint?: (text: string) => void;
  /** 是否真的交到任务手里（调用方据此决定回执措辞：交出去了 vs 没交出去）。 */
  onOutcome?: (ok: boolean) => void;
}): Promise<string> {
  const { from, taskId, batch, head, messageId, onHint, onOutcome } = params;
  const prepared = await prepareInboundMedia(batch.items, { messageId, onHint, role: "worker" });
  const body = composeAgentText(head, prepared.notes);
  const failNote = prepared.failures.length
    ? `（有 ${prepared.failures.length} 个附件没能下载：${prepared.failures.join("、")}。请重新发一次。）`
    : "";
  // 全部附件都下载失败、又没有正文时，不要再说「用户发来图片」——那会让 agent 以为图在。
  const fallback = !prepared.failures.length && !body ? mediaInstructionFallback(prepared) : "";
  const text = [body || fallback, failNote].filter(Boolean).join("\n\n");
  // 这条路径覆盖「换收件人 / 回到大脑 / 超时清扫 / 收件人提交」四个入口，日志必须留下痕迹，否则真机只能靠猜。
  log.info(
    `media-route: deliver to #${taskId} attachments=${batch.items.length} images=${prepared.images.length} failures=${prepared.failures.length}`,
  );
  let delivered = true;
  const note = injectTask(from, text, taskId, undefined, {
    images: prepared.images.length ? prepared.images : undefined,
    // 返回值里既有错误也有「正在续跑」这类人话回执，不能拿「非空」当失败判据。
    onOutcome: (ok) => {
      delivered = ok;
      onOutcome?.(ok);
    },
  });
  if (!delivered) {
    log.warn(`media-route: deliver to #${taskId} failed:`, note.replace(/\n/g, " | "));
    // 任务不在了：只清**属于这条任务**的指针/队列，如实交代（绝不静默丢附件）。
    // 不能无条件 clear：调用方可能在旧批次投递期间已经设了 #2，清掉就把新收件人和新附件一起毁了。
    if (!findRecipientTask(from, taskId)) {
      if (mediaRoute.recipient(from)?.taskId === taskId) mediaRoute.clear(from);
      if (mediaRoute.pendingOwner(from) === taskId) mediaRoute.clearPending(from);
    }
    return note;
  }
  mediaRoute.touch(from);
  // 续跑这类回执要告诉用户，但它不是失败。
  if (note) log.info(`media-route: deliver to #${taskId} note:`, note.replace(/\n/g, " | "));
  return [failNote ? `⚠️ ${failNote}` : "", note].filter(Boolean).join("\n");
}

/** 设置收件人；若还有指向旧任务的暂存附件，先提交给旧任务再切换（绝不静默错投/丢弃）。 */
function armAndFlush(
  from: string,
  taskId: number,
  notify: (text: string) => void | Promise<void>,
): void {
  const displaced = mediaRoute.swapRecipient(from, taskId, taskKeyOf(taskId, from));
  if (!displaced) return;
  const { oldTaskId, batch } = displaced;
  log.info(
    `media-route: swap recipient -> #${taskId}，先把 ${batch.items.length} 个暂存附件交给 #${oldTaskId}（${from}）`,
  );
  void deliverPending({
    from,
    taskId: oldTaskId,
    batch,
    head: "",
    messageId: batch.messageIds.at(-1) ?? "",
  })
    .then((note) => {
      const msg = note
        ? `📎 切换收件人前先把暂存的附件交给 #${oldTaskId}：${note}`
        : `📎 已先把 ${batch.items.length} 个暂存附件提交给 #${oldTaskId}，现在 #${taskId} 是收件人。`;
      try {
        void notify(msg);
      } catch (e) {
        log.warn("media-route: switch notice failed:", describeError(e, import.meta.url));
      }
    })
    .catch((e) =>
      log.warn("media-route: flush on switch failed:", describeError(e, import.meta.url)),
    );
}

async function pollerLoop(
  account: AccountData,
  owner: string,
  state: ServerState,
  sends: SendPipeline,
): Promise<void> {
  // 网络断开时 getUpdates 每 2s 失败一次；不节流会把同一行刷满 10MB 日志，把之前的线索顶进轮转文件。
  const pollErrors = createRepeatLog((line, kind) =>
    kind === "recovery" ? log.info(line) : log.error("getUpdates error:", line),
  );
  while (true) {
    if (isSessionPaused(account.botId)) {
      await sleep(Math.min(getRemainingPauseMs(account.botId), 60_000) || 60_000);
      continue;
    }
    let resp;
    try {
      resp = await getUpdates({
        baseUrl: account.baseUrl,
        token: account.botToken,
        updatesBuf: state.updatesBuf,
        timeoutMs: 25_000,
      });
    } catch (e) {
      pollErrors.error(String(e));
      await sleep(2000);
      continue;
    }
    try {
      if (resp.errcode === SESSION_EXPIRED_ERRCODE) {
        log.info(
          "session expired (-14); pausing 1h. Send a WeChat message to revive after re-login.",
        );
        pauseSession(account.botId);
        continue;
      }
      if (resp.errcode) {
        pollErrors.error(`server error: ${resp.errcode} ${resp.errmsg ?? ""}`);
        await sleep(2000);
        continue;
      }
      pollErrors.success();
      if (resp.get_updates_buf) state.updatesBuf = resp.get_updates_buf;

      const news = (resp.msgs ?? []).filter(
        (m) =>
          m.message_type === MessageType.USER &&
          m.message_id &&
          compareMessageIds(m.message_id, state.lastMessageId) > 0,
      );
      const seenBefore = new Set(state.seenMessageIds ?? []);
      // 先登记本批所有最新 token（worker 发送时取最新）
      for (const m of news) {
        const f = m.from_user_id ?? "";
        if (isAuthorizedSender(f, owner, isAllowed))
          log.info(
            `recv msg id=${m.message_id} ctx=…${m.context_token ? m.context_token.slice(-12) : "NONE"} age=${m.create_time_ms ? Math.round((Date.now() - m.create_time_ms) / 1000) + "s" : "?"}`,
          );
        if (m.context_token) {
          state.contextTokens[`${account.botId}:${f}`] = m.context_token;
          sends.markFresh(f); // 本进程拿到的 token——此后该用户的 -2 不再当「旧 token」挂起
        }
      }
      let enq = false;
      for (const msg of news) {
        const messageId = msg.message_id ?? "0";
        state.lastMessageId = maxMessageId(state.lastMessageId, messageId);
        // 本批/本进程已处理过的 ID 直接跳过。服务端游标 updatesBuf 才是防重放的主防线；
        // 旧版 number 游标刚迁移时 seenMessageIds 可能是空的，不能依赖它补历史。
        if (seenBefore.has(messageId)) {
          log.info(`skip duplicate message id=${messageId}`);
          continue;
        }
        seenBefore.add(messageId);
        state.seenMessageIds = rememberMessageId(state.seenMessageIds ?? [], messageId);
        const from = msg.from_user_id ?? "";
        if (!isAuthorizedSender(from, owner, isAllowed)) {
          log.info("ignore unauthorized sender:", from);
          continue;
        }
        const parts = extractInbound(msg);
        const text = parts.text;
        const voiceItem = (msg.item_list ?? []).find(
          (it) => it.type === MessageItemType.VOICE,
        )?.voice_item;
        if (voiceItem)
          log.info(
            `recv voice: text=${voiceItem.text ? `"${voiceItem.text.slice(0, 30)}"` : "(空,无微信转写)"} playtime=${voiceItem.playtime ?? "?"}`,
          );
        // 只引用、不输入正文的消息也要入队（由 workerLoop 明确提示），不能静默丢。
        if (
          !text &&
          parts.attachments.length === 0 &&
          parts.unsupportedTypes.length === 0 &&
          !parts.quote
        ) {
          log.info("skip empty/unsupported message");
          continue;
        }
        if (parts.unsupportedTypes.length)
          log.info(`recv unsupported item types: [${parts.unsupportedTypes.join(",")}]`);
        // 服务端按「距用户上一条消息」计连续发送数 → 任何来自 owner 的消息都重置该用户计数 + 退出等待段。但已经进了 replyChain、会在本条消息之后才上线路的发送（补发、上一回合没发完的）仍占新窗口的额度，所以不能直接清零，而是把它们算进来。
        const b = sends.budgetOf(from);
        const wasAwaiting = b.awaiting;
        b.count = sends.inflightCount(from);
        b.awaiting = false;
        // 「继续」且当前回合正处于「等待继续」段：换用本消息新 token 恢复，且仅作恢复信号、不入队
        if (text.trim() === "继续" && activeTurn && activeTurn.from === from && wasAwaiting) {
          activeTurn.token = msg.context_token ?? activeTurn.token;
          log.info("收到「继续」(等待中) → 恢复进度、重置计数、换新 token");
          continue;
        }
        const queued: QueuedMsg = {
          from,
          text,
          attachments: parts.attachments,
          quote: parts.quote,
          unsupportedTypes: parts.unsupportedTypes,
          messageId,
          createTimeMs: msg.create_time_ms,
          contextToken: msg.context_token,
        };
        const facts: TaskFacts = {
          awaiting: awaitingTasks(from).length,
          active: hasActiveTask(from),
          interrupted: interruptedTasks(from).length,
        };
        // 收件人模式：非文本消息进待投递队列；无前缀文字标记为交给收件人，与已攒附件一起提交。
        // 命令优先——带附件的命令仍走原路径，不悄悄吞掉指令（见 decideInboundRoute）。
        const ctrl = parseControl(text);
        const tctrl = parseTaskControl(text);
        const brainEscape = text ? parseBrainEscape(text) : null;
        const recipient = mediaRoute.recipient(from);
        const route = decideInboundRoute({
          recipientTaskId: recipient?.taskId ?? null,
          attachmentCount: parts.attachments.length,
          hasText: !!text.trim(),
          hasCommand: !!(ctrl || tctrl || brainEscape),
          fastLane: isFastLane(text, facts, parts.attachments.length),
          mcpToBrain: passMcpToggleToBrain(ctrl, homeModeAtBoot === "direct"),
        });
        if (route.kind === "buffer") {
          const { first, count, displaced } = mediaRoute.buffer(
            from,
            parts.attachments,
            messageId,
            route.recipientTaskId,
          );
          // 队列里原来攒的是另一条任务的附件（指针换过人）：先交回原任务，绝不改归属。
          if (displaced)
            void deliverPending({
              from,
              taskId: displaced.taskId,
              batch: displaced.batch,
              head: "",
              messageId,
            })
              .then((note) => {
                const text = note
                  ? `📎 先把你之前给 #${displaced.taskId} 的附件交回去了：${note}`
                  : `📎 你之前给 #${displaced.taskId} 的 ${displaced.batch.items.length} 个附件已先提交给它。`;
                return sends
                  .sendNotice(
                    from,
                    msg.context_token,
                    text,
                    state.contextTokens[`${account.botId}:${from}`],
                  )
                  .catch(() => {});
              })
              .catch((e) =>
                log.warn("media-route: displaced flush failed:", describeError(e, import.meta.url)),
              );
          if (first)
            void sends
              .sendNotice(
                from,
                msg.context_token,
                `📎 已把收到的附件交给 #${route.recipientTaskId}（再发文字、「好了」就一起提交）。`,
                state.contextTokens[`${account.botId}:${from}`],
              )
              .catch(() => {});
          log.info(
            `media-route: buffered ${parts.attachments.length} attachment(s) for #${route.recipientTaskId} (total ${count})`,
          );
          // 极端情况下同一条消息既有附件又有说明文字：文字入快车道，出队时与这批附件合并提交。
          // 附件已归待投递队列，`queued` 里的副本必须清掉，否则队列先到期补交时会重复提交。
          if (text.trim()) {
            queued.attachments = [];
            queued.toRecipientTaskId = route.recipientTaskId;
            fastQueue.push(queued);
            enq = true;
          }
          continue;
        }
        if (route.kind === "recipient") {
          queued.toRecipientTaskId = route.recipientTaskId;
          fastQueue.push(queued);
          enq = true;
          continue;
        }
        // 带附件的消息不走快车道：控制/任务指令不处理附件，进快车道会静默丢文件。
        if (route.kind === "fast") fastQueue.push(queued);
        else msgQueue.push(queued);
        enq = true;
      }
      // 新 token 已到 → 补发旧 token 期间挂起的推送。等本批所有消息的计数重置都做完再补发（否则同一批里后一条消息的 reset 会把补发的计数抹掉）；每个发件人一次，用 state 里该用户最新的 token。补发先进 replyChain，排在本批消息触发的进度/答案之前（该循环全程同步，worker 来不及插进来）。
      const flushTo = new Set<string>();
      for (const msg of news) {
        const from = msg.from_user_id ?? "";
        if (!msg.context_token || flushTo.has(from) || !isAuthorizedSender(from, owner, isAllowed))
          continue;
        flushTo.add(from);
        const fresh = state.contextTokens[`${account.botId}:${from}`];
        if (fresh) sends.flushHeldPushes(from, fresh);
      }
      const saveErr = finishPollBatch(
        enq,
        () => saveState(state),
        () => {
          notifyWorker();
          notifyFast();
        },
      );
      if (saveErr) log.error("save state failed:", describeError(saveErr, import.meta.url));
    } catch (e) {
      log.error("poller error:", describeError(e, import.meta.url));
    }
  }
}

/**
 * 「允许敏感文件」的补发：把之前被敏感名单拦下的附件重新校验并逐个发出。
 * 路径来自内存队列（30 分钟 TTL），补发时仍走 resolveAttachment 的完整校验（UNC/数据流/大小）。
 */
async function releasePendingSensitive(
  sends: SendPipeline,
  to: string,
  ctx: string | undefined,
): Promise<{ sent: number; failed: number }> {
  const items = takePendingSensitive(to);
  let sent = 0;
  let failed = 0;
  for (const item of items) {
    let resolved;
    try {
      resolved = resolveAttachment({ src: item.src, kind: item.kind }, undefined, {
        allowSensitive: true,
      });
    } catch (e) {
      log.warn("pending attachment rejected:", item.src, String(e));
      failed += 1;
      continue;
    }
    if (!canSendMedia(sends.budgetOf(to).count, CONSEC_SEND_LIMIT)) {
      log.warn("pending attachment skipped (连发额度):", item.src);
      failed += 1;
      continue;
    }
    sends.budgetOf(to).count += 1; // 与普通附件一样占一条连发额度
    if (await sends.sendFileOrdered(to, ctx, resolved.data, resolved.fileName, resolved.kind)) {
      sent += 1;
      log.info(
        `sent pending attachment (${resolved.kind}${resolved.sensitiveBypassed ? "，敏感文件已临时放行" : ""}): ${resolved.fileName} ${resolved.data.length}B <- ${item.src.slice(0, 80)}`,
      );
    } else {
      failed += 1;
      log.warn("send pending attachment failed:", item.src);
    }
  }
  return { sent, failed };
}

/** 快车道的单条处理：控制指令 + 任务指令。它们不经过大脑，因此不必排在长回合后面。 */
async function handleFastItem(
  account: AccountData,
  sends: SendPipeline,
  state: ServerState,
  owner: string,
  item: QueuedMsg,
): Promise<void> {
  const from = item.from;
  const token = item.contextToken;
  const latestToken = () => state.contextTokens[`${account.botId}:${from}`];
  /**
   * 快车道答复：正常立刻发；但若本用户的大脑回合正在跑、连发额度已到「接近上限」线，
   * 就先让位——否则会把留给最终答案的最后一条挤掉（答案的 -2 在本进程已收到过消息时按限流处理、不挂起，等于静默丢）。
   * 让位的答复在回合结束（flushDeferredTaskPushes）后发；仍没额度就转挂起队列。
   */
  const notice = (
    text: string,
    ctx: string | undefined = token,
    fallback: string | undefined = latestToken(),
  ): Promise<void> => {
    if (activeTurn?.from === from && sends.budgetOf(from).count >= CONSEC_SEND_LIMIT - 2) {
      const n = sends.deferTaskPush(from, text);
      log.info(`快车道答复让位给本回合最终答案 → 回合结束后发（累计 ${n} 条，${from}）`);
      return Promise.resolve();
    }
    return sends.sendNotice(from, ctx, text, fallback);
  };
  const facts: TaskFacts = {
    awaiting: awaitingTasks(from).length,
    active: hasActiveTask(from),
    interrupted: interruptedTasks(from).length,
  };

  // ── 收件人模式：无前缀文字与已攒附件一起提交给收件人 ──
  if (item.toRecipientTaskId !== undefined) {
    const taskId = item.toRecipientTaskId;
    // 「连发几张图 + 立刻发文字」时最后几张还在路上：先等队列安静一小会儿再取，
    // 免得晚到的那张被挤到下一个回合（下一个回合往往就是「用户早就问完的问题」）。
    if (MEDIA_FLUSH_DEBOUNCE_MS > 0 && mediaRoute.pendingCount(from) > 0) {
      const waited = await waitForSettledAttachments({
        now: Date.now,
        sleep: async (ms) => {
          await sleep(ms);
        },
        lastBufferedAt: () => mediaRoute.lastBufferedAt(from),
        quietMs: MEDIA_FLUSH_DEBOUNCE_MS,
        maxMs: MEDIA_FLUSH_DEBOUNCE_MAX_MS,
      });
      if (waited > 0) log.info(`media-route: 等后到的附件 ${waited}ms（#${taskId}）`);
    }
    const batch = mediaRoute.takePending(from);
    // 队列可能是在**另一条任务**当收件人时攒的（指针过期后重新设过收件人）：按批次归属投递。
    const targetId = deliveryTarget(batch, taskId);
    const flushOnly = batch.items.length > 0 && isFlushWord(item.text);
    // 「好了」但队列已被清扫搬走：别把「好了」当成普通正文再发一个空回合。
    if (!batch.items.length && isFlushWord(item.text)) {
      log.info(`task: flush-word without pending(#${taskId})`);
      await notice("现在没有待提交的附件。");
      return;
    }
    const head = flushOnly
      ? ""
      : [formatQuote(item.quote), item.text.trim()].filter(Boolean).join("\n");
    let r: string;
    if (batch.items.length) {
      r = await deliverPending({
        from,
        taskId: targetId,
        batch,
        head,
        messageId: item.messageId,
        // 大文件/视频下载耗时：给用户进度，别让「好了」之后一片安静。
        onHint: (t) => void notice(t),
      });
    } else {
      r = injectTask(from, head || item.text.trim(), targetId, undefined, {});
      if (r && !findRecipientTask(from, targetId)) {
        if (mediaRoute.recipient(from)?.taskId === targetId) mediaRoute.clear(from);
        if (mediaRoute.pendingOwner(from) === targetId) mediaRoute.clearPending(from);
      } else {
        mediaRoute.touch(from);
      }
    }
    log.info(
      `task: submit-to-recipient(#${targetId}):`,
      (head || (batch.items.length ? "(附件)" : "")).slice(0, 40),
      "->",
      r.replace(/\n/g, " | "),
    );
    if (r) await notice(r);
    return;
  }

  // 控制指令：单独处理
  const ctrl = item.text ? parseControl(item.text) : null;
  // direct 下「加载/卸载 MCP」不在 daemon 侧处理：原样交给 Agent，由它决定怎么改自己的配置。
  if (passMcpToggleToBrain(ctrl, homeModeAtBoot === "direct")) {
    log.info("control: mcp toggle passed through to agent (direct)", JSON.stringify(ctrl));
  } else if (ctrl) {
    // owner-only（切脑/交接）：非本人 → 短提示拒绝，**不**转发给大脑（否则大脑可能替用户执行越权动作）
    if (isOwnerOnly(ctrl) && from !== owner) {
      const r = "这条指令仅登录者可用。发送「帮助」看你自己的指令。";
      log.info("control: denied(not owner)", JSON.stringify(ctrl));
      await notice(r);
      return;
    }
    // 退出收件人模式：把待投递队列里已攒的附件尽力交给原收件人后，之后的文字/附件回到大脑。
    if (ctrl.kind === "toBrain") {
      const had = mediaRoute.recipient(from);
      mediaRoute.clear(from);
      const batch = mediaRoute.takePending(from);
      let r = "🏠 好，之后的文字和附件交给大脑。";
      if (batch.items.length) {
        // 指针可能已过期（队列却还没被 15s 清扫搬走）：归属以批次自己的 taskId 为准，仍交回去，绝不静默丢。
        const targetId = had?.taskId ?? batch.taskId;
        if (targetId !== undefined) {
          const extra = await deliverPending({
            from,
            taskId: targetId,
            batch,
            head: "",
            messageId: item.messageId,
          });
          if (extra) r = `${r}\n${extra}`;
        } else {
          r = `${r}\n（另有 ${batch.items.length} 个暂存的附件已超时，没能交出去，需要的话重新发一次。）`;
        }
      }
      log.info("control: toBrain ->", r.replace(/\n/g, " | "));
      await notice(r);
      return;
    }
    // 补发用**最新**token（切换可能几十秒，期间用户又发过消息；旧 token 可能已失效）
    const notify = (text: string) => notice(text, latestToken() ?? token, latestToken());
    const notifyFile = (text: string) => {
      // 接近上限且本用户回合在跑：不再发文件占额度，退化为文本答复并参与「让位」判定（回合结束再发）。
      if (activeTurn?.from === from && sends.budgetOf(from).count >= CONSEC_SEND_LIMIT - 2)
        return notice(text);
      sends.budgetOf(from).count += 1; // .md 也是一条消息，占同一份额度
      return sends.sendMdOrdered(from, latestToken() ?? token, text, latestToken(), (e) =>
        sends.holdUndelivered(from, text, e),
      );
    };
    let r: string;
    try {
      r = await handleControl(ctrl, from, {
        owner,
        notify,
        notifyFile,
        // 先拦截、后放行：开窗后把队列里的附件立即补发（补发失败只计数，不阻断答复）。
        releaseSensitive: () => releasePendingSensitive(sends, from, latestToken() ?? token),
      });
    } catch (e) {
      r = "处理指令出错：" + String(e);
    }
    log.info("control:", JSON.stringify(ctrl), "->", r.replace(/\n/g, " | "));
    await notice(r);
    return;
  }

  // ── 任务路由 ──
  const tcmd = item.text ? parseTaskControl(item.text) : null;
  if (tcmd) {
    // 用 switch + `never` 兜底：新增任务指令 kind 却忘了在这里处理，typecheck 会当场失败。
    switch (tcmd.kind) {
      case "stop": {
        let r = stopTask(from, tcmd.id);
        const dropped = purgeMediaRouteForStopped(from, tcmd.id);
        if (dropped > 0) r += "\n（还有 " + dropped + " 个暂存的附件没有提交，已一并丢弃。）";
        log.info("task: stop ->", r.replace(/\n/g, " | "));
        await notice(r);
        return;
      }
      case "tasks": {
        await notice(renderTaskList(from));
        return;
      }
      case "recipient": {
        // 裸 `#N` 或 `发给任务 N`：只设指针，不产生文本
        const t = findRecipientTask(from, tcmd.id);
        if (!t) {
          await notice(`没有 #${tcmd.id} 号任务。发「任务列表」看现有编号。`);
          return;
        }
        armAndFlush(from, t.id, notice);
        const secs = Math.round(MEDIA_RECIPIENT_TTL_MS / 1000);
        log.info(`task: recipient(#${t.id}) armed`);
        await notice(
          `✅ 已把 #${t.id} 设为收件人：接下来 ${secs} 秒内你发的文字、图片、文件都交给它。\n` +
            "想回大脑发「回到大脑」，只想问大脑一句发「问大脑：…」。",
        );
        return;
      }
      case "reply": {
        const r = injectTask(from, tcmd.text, tcmd.id, undefined, {
          onTaskId: (id) => armAndFlush(from, id, notice),
        });
        log.info(`task: inject(#${tcmd.id}):`, tcmd.text.slice(0, 40));
        if (r) await notice(r);
        return;
      }
      case "toWorker": {
        // 带 agent 名 = 指定 agent 起一条**新任务**（多任务并行）；不带 = 沿用「有任务就发给它，没有就派发」。
        if (tcmd.agentToken) {
          // 指定的 agent **只对这条任务生效**，不改默认任务大脑：那是账号级状态（`切换任务大脑` 是 owner-only），顺手改会让「派一条任务」变成一次隐形的全局设置变更，也破坏微信与 CLI（`--agent` 只影响那一条任务）两边的对称。
          const r = dispatchTask(from, tcmd.text, {
            agentKey: tcmd.agentToken,
            onTaskId: (id) => armAndFlush(from, id, notice),
          });
          log.info(`task: dispatch(agent=${tcmd.agentToken}):`, r.replace(/\n/g, " | "));
          await notice(r);
          return;
        }
        // 明确发给 worker：**一律派发新任务**（2026-11-17 改）。
        // 此前是「有活跃任务就发给它/追加」，但活跃与否是用户看不见的状态（`waiting` 也算活跃）：同一句「任务：…」时而新建、时而被旧任务吞掉，是隐藏状态的心智负担。
        // 接着某条任务说话有两条显式通道：`#N 正文`、收件人模式下的无前缀文字（`任务：` 派发后会自动把新任务设为收件人），所以这里不需要兼任追加。
        // 不「续跑」已中断的：那是「继续」/`#n 继续` 的事，明确派发就该是新的活。
        const running = liveTasks(from);
        const r = dispatchTask(from, tcmd.text, {
          ...(tcmd.agentToken ? { agentKey: tcmd.agentToken } : {}),
          onTaskId: (id) => armAndFlush(from, id, notice),
        });
        log.info(
          tcmd.agentToken ? `task: dispatch(agent=${tcmd.agentToken}):` : "task: dispatch:",
          r.replace(/\n/g, " | "),
        );
        await notice(r + parallelTaskHint(running));
        return;
      }
      default: {
        // 新增 kind 时这里会报「类型不可赋值给 never」，提醒补 case。
        const unhandled: never = tcmd;
        void unhandled;
      }
    }
  }

  // poller 按**入队时**的任务状态把「继续」类短句送进快车道；出队时状态可能已变（任务刚出完结果），
  // 这时交回大脑队列，保持「到出队才最终判定」的旧语义。
  if (shouldResumeTask(item.text, facts)) {
    const r = injectTask(from, item.text, undefined, undefined, {
      onTaskId: (id) => armAndFlush(from, id, notice),
    });
    log.info("task: resume(unnumbered):", item.text.slice(0, 40), "->", r.replace(/\n/g, " | "));
    if (r) await notice(r);
    return;
  }
  msgQueue.push(item);
  notifyWorker();
}

/** 快车道循环：与大脑回合并发，命令之间保持入队顺序。 */
async function fastWorkerLoop(
  account: AccountData,
  sends: SendPipeline,
  state: ServerState,
  owner: string,
): Promise<void> {
  while (true) {
    if (isSessionPaused(account.botId)) {
      await sleep(Math.min(getRemainingPauseMs(account.botId), 30_000) || 30_000);
      continue;
    }
    if (fastQueue.length === 0) {
      await new Promise<void>((r) => {
        wakeFast = r;
        if (fastQueue.length > 0) {
          wakeFast = null;
          r();
        }
      });
      continue;
    }
    const item = fastQueue.shift() as QueuedMsg;
    try {
      await handleFastItem(account, sends, state, owner, item);
    } catch (e) {
      log.error("fast command error:", describeError(e, import.meta.url));
      await sends
        .sendNotice(
          item.from,
          item.contextToken,
          "处理这条指令时出错了，请再发一次试试。",
          state.contextTokens[`${account.botId}:${item.from}`],
        )
        .catch(() => {});
    }
  }
}

async function workerLoop(
  account: AccountData,
  sends: SendPipeline,
  state: ServerState,
): Promise<void> {
  while (true) {
    if (isSessionPaused(account.botId)) {
      await sleep(Math.min(getRemainingPauseMs(account.botId), 30_000) || 30_000);
      continue;
    }
    if (msgQueue.length === 0) {
      await new Promise<void>((r) => {
        wakeWorker = r;
        if (msgQueue.length > 0) {
          wakeWorker = null;
          r();
        }
      });
      continue;
    }
    const item = msgQueue.shift() as QueuedMsg;
    const from = item.from;
    const token = item.contextToken; // 用这条消息自己带的 context_token 回复（每条消息各有各的 token）
    const latestToken = () => state.contextTokens[`${account.botId}:${from}`]; // 该用户最新缓存 token（仅作 -2 参数错误时的兜底）

    // 快车道消息（控制/任务指令）不会进这个队列；这里只剩大脑消息。
    // 1) 明确「问大脑」逃逸前缀 → 去前缀后强制走 brain（即使 worker 在等你）
    const brainEscape = item.text ? parseBrainEscape(item.text) : null;
    // 2) 无前缀消息**默认给大脑**；只有「继续」类短句 + 有可续跑任务（waiting 任意；interrupted 需没有活跃任务）才交给任务（多条时 injectTask 回编号清单）。
    //    2026-11-02 前是「只要有一条 waiting 就接管任意无编号消息」——任务出完结果还躺在 waiting，会把用户找大脑的日常消息吞掉（真机踩到两次：#26、#28）。
    //    任务侧的追问走显式寻址：`#<编号> 正文` / `> 正文` / `任务 …`（解析层已分流，不会到这里）。
    if (
      !brainEscape &&
      shouldResumeInBrainQueue(item.text, item.attachments.length, {
        awaiting: awaitingTasks(from).length,
        active: hasActiveTask(from),
        interrupted: interruptedTasks(from).length,
      })
    ) {
      const r = injectTask(from, item.text, undefined, undefined, {
        onTaskId: (id) =>
          armAndFlush(from, id, (text) => sends.sendNotice(from, token, text, latestToken())),
      });
      log.info("task: resume(unnumbered):", item.text.slice(0, 40), "->", r.replace(/\n/g, " | "));
      if (r) await sends.sendNotice(from, token, r, latestToken());
      continue;
    }

    const brainText = [formatQuote(item.quote), brainEscape ?? item.text]
      .filter(Boolean)
      .join("\n");
    // 没有正文、没有媒体时（只引用，或只有不认识的 item 类型）：直接回一条明确提示，别静默丢，也别拿空 prompt /「用户发来一张图片」的兜底去问大脑。
    const emptyNotice = contentlessNotice({
      text: brainEscape ?? item.text,
      mediaCount: item.attachments.length,
      unsupportedTypes: item.unsupportedTypes,
      quote: item.quote,
    });
    if (emptyNotice) {
      log.info(
        `message without usable content (quote=${!!item.quote}, types=${item.unsupportedTypes.join(",")}); rejected gracefully`,
      );
      await sends.sendNotice(from, token, emptyNotice, latestToken());
      continue;
    }
    // 交接注入：切换大脑后，发给**新**大脑的第一条消息带上前一个大脑留下的摘要（切回来源大脑、别人、
    // 过期都不带上，规则见 handoff.ts）。作为前缀带上 = 不额外占一个回合、不多一次模型调用。
    // 切换进行中时按**目标**大脑判断（这条消息会在门口等新大脑就绪，实际答话的是它）。
    const pending = loadHandoff(DATA_DIR);
    const goal = switchInFlightTarget() ?? getAgent("brain").name;
    const htext = takeHandoffFor(pending, goal, from);
    const withHandoff =
      pending && htext ? handoffPrefix(pending.fromAgent, htext) + brainText : brainText;
    if (htext)
      log.info(`handoff injected from=${pending?.fromAgent} to=${goal} chars=${htext.length}`);
    try {
      const answered = await handleMessage(
        account,
        sends,
        token,
        from,
        withHandoff,
        item.attachments,
        item.messageId,
        item.createTimeMs,
        latestToken,
      );
      // 答成才清除：失败/被图片挡下就留着，下次还能用。
      // 切回来答话（回滚到来源大脑，或切换目标就是它）也不清除——那是它自己写的摘要，留着下次切走时用。
      const answeredBy = getAgent("brain").name;
      if (htext && answered && answeredBy !== pending?.fromAgent && clearHandoff(DATA_DIR))
        log.info(`handoff consumed by ${answeredBy}`);
    } catch (e) {
      log.error("handleMessage error:", describeError(e, import.meta.url));
      await sends.sendNotice(from, token, "处理这条消息时出错了，请再发一次试试。", latestToken());
    }
  }
}

// ===== 本地命令入口（文件桥）：CLI 写 task-inbox/*.json，daemon 扫描分发到 task-manager，结果写回 task-out/*.json =====
const TASK_STATE_FILE = path.join(DATA_DIR, "task-state.json");
const TASK_SCAN_MS = Number(process.env.WEMIND_TASK_SCAN_MS) || 1000;

/** 读裸 pid 文件（daemon.pid / wrapper.pid）；不存在/坏内容 → null。 */
function readPidFile(file: string): number | null {
  try {
    const n = Number.parseInt(fs.readFileSync(file, "utf-8").trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * 出站媒体：从回复文本里抽出图片 / 文件 / 视频，逐条发出，返回剩余正文。
 * brain 回合与 worker 任务推送共用（预算记账、敏感文件拦截、失败说明口径一致）。
 */
async function sendReplyMedia(
  to: string,
  answer: string,
  sends: SendPipeline,
  ctxToken: () => string | undefined,
): Promise<{ text: string; mediaCount: number }> {
  // 发图：markdown ![](url/路径) 或裸图片 URL，逐个作为图片消息发出，再发剩余文本
  const { images: replyImages, text: cleaned } = extractImages(answer || "");
  const failedImgs: ImageFailure[] = [];
  let mediaCount = 0;
  for (const im of replyImages) {
    let buf: Buffer;
    try {
      buf = await resolveImageBytes(im.src);
    } catch (e) {
      log.warn("image download failed:", im.src, String(e));
      failedImgs.push({ src: im.src, reason: "download" });
      continue;
    }
    if (!canSendMedia(sends.budgetOf(to).count, CONSEC_SEND_LIMIT)) {
      log.warn("image skipped (连发额度留给最终文字):", im.src);
      failedImgs.push({ src: im.src, reason: "budget" });
      continue;
    }
    sends.budgetOf(to).count += 1; // 图片也占一条连发额度
    if (await sends.sendImageOrdered(to, ctxToken(), buf)) {
      mediaCount += 1;
      log.info(`sent image: ${im.src.slice(0, 80)}`);
    } else {
      log.warn("send image failed:", im.src);
      failedImgs.push({ src: im.src, reason: "send" });
    }
  }

  // 发文件/视频：显式 [附件]/[文件]/[视频](绝对路径)，逐个作为独立媒体消息发出
  const { attachments: replyAttachments, text: cleanedText } = extractAttachments(cleaned);
  const failedAttachments: AttachmentFailure[] = [];
  const blockedSensitive: PendingSensitiveAttachment[] = [];
  for (const attachment of replyAttachments) {
    let resolved;
    try {
      // 「允许敏感文件」窗口内跳过凭证/状态名单；其余闸门（绝对路径/UNC/数据流/大小）照旧。
      resolved = resolveAttachment(attachment, undefined, {
        allowSensitive: sensitiveAllowActive(),
      });
    } catch (e) {
      log.warn("attachment rejected:", attachment.src, String(e));
      if (isSensitiveFileError(e)) {
        // 先拦截、后放行：记进待补发队列，用户回「允许敏感文件」时直接补发，不用让 agent 重发一遍。
        blockedSensitive.push({ src: attachment.src, kind: attachment.kind });
        failedAttachments.push({ src: attachment.src, reason: "sensitive" });
      } else {
        failedAttachments.push({ src: attachment.src, reason: "read" });
      }
      continue;
    }
    if (!canSendMedia(sends.budgetOf(to).count, CONSEC_SEND_LIMIT)) {
      log.warn("attachment skipped (连发额度留给最终文字):", attachment.src);
      failedAttachments.push({ src: attachment.src, reason: "budget" });
      continue;
    }
    sends.budgetOf(to).count += 1; // 文件/视频也占一条连发额度
    if (
      await sends.sendFileOrdered(to, ctxToken(), resolved.data, resolved.fileName, resolved.kind)
    ) {
      mediaCount += 1;
      log.info(
        `sent attachment (${resolved.kind}${resolved.sensitiveBypassed ? "，敏感文件已临时放行" : ""}): ${resolved.fileName} ${resolved.data.length}B <- ${attachment.src.slice(0, 80)}`,
      );
    } else {
      log.warn("send attachment failed:", attachment.src);
      failedAttachments.push({ src: attachment.src, reason: "send" });
    }
  }
  if (blockedSensitive.length > 0) {
    const n = rememberPendingSensitive(to, blockedSensitive);
    log.info(
      `blocked sensitive attachments: ${blockedSensitive.length}（待补发 ${n} 条，回复「允许敏感文件」）`,
    );
  }

  const note = [imageFailureNote(failedImgs), attachmentFailureNote(failedAttachments)]
    .filter(Boolean)
    .join("\n\n");
  const text = note ? [cleanedText, note].filter(Boolean).join("\n\n") : cleanedText;
  return { text, mediaCount };
}

/**
 * 收件人到期清扫：到期即取消并回执（绝不静默切换归属），队列里已攒的附件尽力补交给原任务。
 * 由 runDaemon 里的定时器周期调用（滑动空闲 TTL，默认 1 分钟）。
 */
async function sweepMediaRecipients(
  account: AccountData,
  sends: SendPipeline,
  state: ServerState,
): Promise<void> {
  for (const { userId, recipient } of mediaRoute.dueExpired()) {
    const batch = mediaRoute.takePending(userId);
    const token = state.contextTokens[`${account.botId}:${userId}`];
    let extra = "";
    if (batch.items.length) {
      const targetId = batch.taskId ?? recipient.taskId;
      const count = batch.items.length;
      let delivered = true;
      const note = await deliverPending({
        from: userId,
        taskId: targetId,
        batch,
        head: "",
        messageId: batch.messageIds[batch.messageIds.length - 1] ?? "0",
        onOutcome: (ok) => {
          delivered = ok;
        },
      });
      // 先说清「这几个附件去哪了」，再原样附上任务的回话（续跑提示之类）；不再用「把…交回去时」这种从句。
      const headline = delivered
        ? `\n📎 超时前收到的 ${count} 个附件已交给 #${targetId}。`
        : `\n📎 超时前收到的 ${count} 个附件没能交给 #${targetId}。`;
      extra = note ? `${headline}\n${note}` : headline;
    }
    log.info(`media-route: recipient #${recipient.taskId} expired for ${userId}`);
    await sends
      .sendNotice(
        userId,
        token,
        `⌛ 提醒：收件人 #${recipient.taskId} 已超时自动取消，之后的文字和附件交给大脑。${extra}\n（这是定时器单独发的提醒，不是对你上一条消息的回复。）`,
        token,
      )
      .catch(() => {});
  }
}

export async function runDaemon(): Promise<void> {
  // 单实例：同账号只允许一个 daemon 占用同一个 bot token。
  // `wimind start` 有 wrapper.pid 守卫；这里挡住直接 `wimind daemon` / `npm run daemon`，以及两套 runner 并存。
  const pidFile = path.join(DATA_DIR, "daemon.pid");
  const recordedPid = readPidFile(pidFile);
  const existing = findOtherOurProcess(recordedPid, process.pid, CLI_PID_MARKERS);
  if (existing.pid) {
    log.info(`another daemon is already running for this account (pid=${existing.pid}); exit.`);
    process.exit(DAEMON_ALREADY_RUNNING_EXIT_CODE);
  }
  if (existing.unknown) {
    // 查询失败不能当成「没有别的实例」：两个 daemon 抢同一个 bot token 会互相吞消息。
    log.error(
      `无法确认 pid=${recordedPid} 是否另一个 wemind daemon（${existing.error ?? "进程命令行查询失败"}）；为避免双开抢同一 bot token，本次不启动。确认该 pid 不是 wemind 后删除 ${pidFile} 再试。`,
    );
    process.exit(DAEMON_ALREADY_RUNNING_EXIT_CODE);
  }
  // ESM adapter 的预加载必须在单实例守卫之后：重复 daemon 不应先执行第三方插件顶层代码。
  log.info("preloading agent adapters…");
  const preloaded = await preloadAgentAdapters();
  for (const problem of preloaded.problems) log.warn(problem);
  // 启动即校验大脑：早失败、说人话——避免「进程看着正常、直到第一条消息才炸」（历史上表现为反复「⏳ 响应中断了，正在自动重试…」，实为默认大脑的二进制没装）。
  // 先种槽位再校验：此后运行期一律从槽位取 agent（热切换会更新它，见 agent-slot.ts），启动期与运行期同一个来源。
  const registry = getAgentRegistry();
  if (registry.dirError) log.warn(registry.dirError);
  for (const broken of Object.values(registry.broken))
    log.warn(`本机 agent 定义不可用（不会被选上）：${brokenAgentDefinitionMessage(broken)}`);
  seedSlots(loadBrainConfig());
  const agent = getAgent("brain");
  const brainProblem = agentProblem(agent);
  if (brainProblem) {
    log.error(`FATAL 大脑不可用：${brainProblem}`);
    process.exit(BRAIN_CONFIG_EXIT_CODE); // 后台守护进程据此停止自动重启（配置错误重拉无益）
  }
  log.info(
    `brain=${agent.name} bin=${agent.bin} args=[${agent.args.join(" ")}] shell=${agent.shell} (source: ${agent.source})`,
  );
  const brainSource = findAgentDefinitionSource(agent.name);
  if (brainSource?.kind === "local")
    log.warn(`agent 定义来自本机（整条覆盖同名内置）：${agent.name} ← ${brainSource.file}`);
  // 运行时身份：list 在 daemon 活着时据此显示「实际生效的大脑」（brain.pid 要等 ACP 懒启动才有）
  writeBrainState(DATA_DIR, agent);
  const wagent = getAgent("worker");
  if (wagent.name !== agent.name)
    log.info(
      `worker=${wagent.name} bin=${wagent.bin} args=[${wagent.args.join(" ")}] (source: ${wagent.source})`,
    );
  // 任务大脑不可用只警告、不退出：只聊天的用户不受影响，但派发任务会失败——早说清楚比任务静默失败好。
  const workerProblem = agentProblem(wagent);
  if (workerProblem) log.warn(`任务大脑不可用（派发任务会失败）：${workerProblem}`);
  const account = loadAccount();
  if (!account?.botToken) {
    log.info("not logged in; run the MCP login_qrcode flow first.");
    process.exit(1);
  }
  const owner = process.env.WECHAT_OWNER_ID?.trim() || account.userId; // 登录者：始终授权（兜底校验）
  if (owner) addAllowFrom(owner, DATA_DIR); // 种入登录者白名单(自动迁移老账号)；新登录在 finalize 已配对
  // 写 PID 文件，供管理命令（logout/delete）精确定位并停止本账号的 daemon
  try {
    fs.writeFileSync(pidFile, String(process.pid), "utf-8");
  } catch {
    /* best-effort */
  }
  const cleanupPid = () => {
    try {
      fs.unlinkSync(pidFile);
    } catch {
      /* ignore */
    }
  };
  // 退出时连带收掉池里的全部 worker：Windows 上子进程不会随父进程退出，漏掉就是一堆孤儿 agent 进程。
  // （任务表不在这里改状态：下次启动统一标「已中断」——那才是它真实的处境。）
  const cleanupAll = () => {
    cleanupPid();
    killWorkerPool();
  };
  process.on("exit", cleanupAll);
  process.on("SIGINT", () => {
    cleanupAll();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanupAll();
    process.exit(0);
  });
  // 防御：任何未捕获的 promise 拒绝/异常（多为瞬时网络 fetch failed 或回合内 send 被拒）只记录、不退出，避免 daemon 崩溃丢掉在途回合、用户卡在心跳。此前的 code=1 崩溃即源于此类未捕获拒绝。
  process.on("unhandledRejection", (reason) => {
    log.error("unhandledRejection:", describeError(reason, import.meta.url));
  });
  process.on("uncaughtException", (err) => {
    log.error("uncaughtException:", describeError(err, import.meta.url));
  });
  try {
    homeModeAtBoot = readHomeMode(DATA_DIR);
    // 排队重载在旧进程里随 daemon 退出消失：新进程本来就是按当前配置 spawn 的，记一行并清掉标记，
    // 免得下次启动又误报「上次还有没生效的重载」。
    const pendingMarker = readReloadMarker();
    if (pendingMarker) {
      log.warn(
        `上次退出前排队的 ${pendingMarker.reason} 未及生效；新进程已按当前配置启动，标记已清。`,
      );
      clearReloadPending();
    }
    ensureParityAccountDirs();
    migrateLegacyHomes();
    ensureBrainHome(); // 准备 brain 配置：direct 直接用真实配置，managed 才建账号副本
    ensureWorkerHome(); // 准备 worker 配置：direct 直接用真实配置，managed 才建账号副本
  } catch (e) {
    // 工作区或 Agent 配置不可用属于“启动前就能发现”的配置错误：明确报错，不带着半份配置跑。
    log.error("agent config/workspace unavailable:", describeError(e, import.meta.url));
    throw e;
  }
  // 启动时清一次过期/超额入站附件（并把节流时钟起好）：managed 下 brain / worker 各有一份目录。
  const pruned = pruneInboundMediaIfDue();
  for (const role of ["worker"] as const) pruneInboundMediaIfDue(undefined, mediaInboxDir(role));
  if (pruned?.removed)
    log.info(`pruned inbound media: ${pruned.removed} files, ${pruned.bytes}B left`);
  log.info(
    `up. v${CLI_VERSION} bot=${account.botId} owner=${owner} allowFrom=${readAllowFrom(DATA_DIR).length} media-route: ttl=${MEDIA_RECIPIENT_TTL_MS}ms debounce=${MEDIA_FLUSH_DEBOUNCE_MS}ms(max ${MEDIA_FLUSH_DEBOUNCE_MAX_MS}ms)`,
  );
  await notifyStart({ baseUrl: account.baseUrl, token: account.botToken }).catch(() => {});

  const state: ServerState = loadState();
  const sends = createSendPipeline(account);
  // worker 任务推送：先按与 brain 相同的口子解析出站图片/文件/视频，再发正文；
  // 按用户串行（媒体要下载/读盘，若并发解析，后到的短回复可能抢先发出）。
  const taskReplyChains = new Map<string, Promise<void>>();
  const sendTaskReply = async (to: string, rawText: string): Promise<void> => {
    // 每次发送时现取 token：大文件下载可能耗时几十秒，期间用户又发过消息，旧 token 可能已失效。
    const tok = (): string | undefined => state.contextTokens[`${account.botId}:${to}`];
    const { text, mediaCount } = await sendReplyMedia(to, rawText, sends, tok);
    // 只有媒体、没有正文时不必再发一条空消息；两者都没有才说明「没有内容」
    const finalText = text || (mediaCount === 0 ? "（没有内容）" : "");
    if (!finalText) return;
    // task 推送也占用连续发送额度（与 brain 回合共用 budgetOf）：task 在后台运行，可能与 brain 回合并发，若不计数，本地 budget 会低估服务端真实连续发送数 → brain 的 sendProgress 误判「还能发」→ 撞 ret=-2 限流、结果丢失。
    // 注：task 推送是「本轮结果」（必须送达），故只累加计数、不被 awaiting 暂停（暂停只作用于可丢弃的 brain 进度提示）。
    const b = sends.budgetOf(to);
    // 但大脑回合已接近上限时，最后一条额度要留给最终答案：先延后，回合结束后再发（见 flushDeferredTaskPushes）。
    if (shouldDeferTaskPush(activeTurn?.from, to, b.count, CONSEC_SEND_LIMIT)) {
      const n = sends.deferTaskPush(to, finalText);
      log.info(`任务推送遇大脑回合额度将满 → 延后到回合结束（累计 ${n} 条，${to}）`);
      return;
    }
    b.count += 1;
    void sends.sendOrdered(to, tok(), finalText, MessageState.FINISH, tok(), (e) =>
      sends.holdUndelivered(to, finalText, e),
    );
  };
  setTaskPush((to, text) => {
    const prev = taskReplyChains.get(to) ?? Promise.resolve();
    const next = prev.then(
      () => sendTaskReply(to, text),
      () => sendTaskReply(to, text),
    );
    taskReplyChains.set(to, next);
    const cleanup = (): void => {
      if (taskReplyChains.get(to) === next) taskReplyChains.delete(to);
    };
    next.then(cleanup, cleanup);
  });
  // worker 跑一轮期间持续「正在输入中」（typing 不占连续发送上限），避免长任务静默让用户以为卡了
  setTaskTyping((to) => {
    void setTyping(account, to, state.contextTokens[`${account.botId}:${to}`], 1);
  });
  // 任务状态写入磁盘：worker 状态记录原子写 task-state.json，供本地 `manage.js task-status` 读
  setTaskStateSink((snap: TaskStateSnapshot) => {
    try {
      const tmp = `${TASK_STATE_FILE}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(snap, null, 2), "utf-8");
      fs.renameSync(tmp, TASK_STATE_FILE);
    } catch {
      /* best-effort */
    }
  });
  setTaskAckSink((id, text) => writeTaskAck(DATA_DIR, id, text)); // 本地命令的回结果通道（`wemind task` 等着的「到底派上了没有」）
  // 本地命令入口：启动清空收件箱与答复目录（作废重启前残留命令、防重放），再起独立定时器扫描分发（不挂 poller，避免被 25s 长轮询阻塞）
  clearTaskDirs(DATA_DIR);
  const taskInboxOps = {
    dispatch: dispatchTask,
    inject: injectTask,
    stop: (to: string, id?: number | "all", ackId?: string) => {
      const r = stopTask(to, id, ackId);
      purgeMediaRouteForStopped(to, id); // 本地 task-stop 绕过了微信分支：收件人指针/暂存附件同样要清
      return r;
    },
    writeAck: (ackId: string | undefined, text: string) => writeTaskAck(DATA_DIR, ackId, text),
    log: leveledLog,
  };
  setInterval(() => {
    try {
      scanTaskInbox(DATA_DIR, owner, taskInboxOps);
    } catch (e) {
      log.error("task inbox scan failed:", describeError(e, import.meta.url));
    }
  }, TASK_SCAN_MS);
  // 控制桥：同样「启动清空 + 独立定时器扫描」（作废重启前的残留命令，防重放）
  clearControlDirs(DATA_DIR);
  markBridgeReady(DATA_DIR, process.pid); // 凭据：CLI 据此判断「在跑的这个 daemon 认不认识控制桥」
  const controlInbox = new ControlInboxRunner(DATA_DIR, {
    handle: handleControlRequest,
    log: leveledLog,
  });
  setInterval(
    () =>
      void controlInbox
        .scan(owner)
        .catch((e) => log.error("control inbox scan failed:", describeError(e, import.meta.url))),
    TASK_SCAN_MS,
  );
  // 任务表：读回上次的（未完成的标「已中断」，不自动恢复）；编号接着排
  const restored = initTasks(DATA_DIR);
  if (restored.interrupted.length)
    log.info(`restored tasks: interrupted=[${restored.interrupted.join(",")}]（回「继续」可续跑）`);
  // 会话登记表：把当前会话表里有、登记表里还没有的旧会话补进去（功能上线前的老账号，一次性、幂等）
  const backfilled = syncFromPointerMap(DATA_DIR);
  if (backfilled) log.info(`session registry backfilled: ${backfilled} 条（来自当前会话表）`);
  // 进程池清扫：空闲超时的 worker 回收（默认 5 分钟）
  const poolSweep = setInterval(() => sweepWorkerPool(), 30_000);
  poolSweep.unref?.();
  // 收件人到期清扫：滑动空闲 TTL（默认 1 分钟）到点即取消并回执，绝不静默切换归属。
  const recipientSweep = setInterval(() => {
    void sweepMediaRecipients(account, sends, state).catch((e) =>
      log.warn("media-route sweep failed:", String(e)),
    );
  }, 15_000);
  recipientSweep.unref?.();
  // 解耦运行：拉取器持续抓消息(永不被大脑阻塞)，大脑与快车道各一个处理器并发
  // 两个常驻循环若在自身 try 之外意外退出，进程还活着却不再收消息（list 显示运行中、pid 文件还在）——必须显式叫停，交给 watchdog 5s 重拉。
  const fatalLoop = (name: string) => (e: unknown) => {
    log.error(`${name} loop exited:`, describeError(e, import.meta.url));
    process.exit(1);
  };
  void pollerLoop(account, owner, state, sends).catch(fatalLoop("poller"));
  void fastWorkerLoop(account, sends, state, owner).catch(fatalLoop("fast worker"));
  await workerLoop(account, sends, state);
}

// daemon 本体由 cli.ts 的 `wemind daemon` 调用 runDaemon() 启动，此处不再顶层自启。
