#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
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
  downloadImage,
  sendImage,
  sendFile,
  ILinkError,
  classifyTransportError,
  isAllowed,
  addAllowFrom,
  readAllowFrom,
} from "@wemind/wechat-ilink-core";
import type {
  AccountData,
  ServerState,
  SendMessageReq,
  ImageItem,
} from "@wemind/wechat-ilink-core";
import { askBrain, supportsImages, heartbeatMs } from "./acp-brain.js";
import { agentProblem, BRAIN_CONFIG_EXIT_CODE } from "./brain-agents.js";
import { switchInFlightTarget } from "./brain-switch.js";
import { loadBrainConfig } from "./brain-config.js";
import { getAgent, seedSlots } from "./agent-slot.js";
import { writeBrainState } from "./brain-state.js";
import { CLI_PID_MARKERS, otherOurProcessPid } from "./shared/process/proc-identity.js";
import { DAEMON_ALREADY_RUNNING_EXIT_CODE } from "./watchdog-runner.js";
import { isOwnerOnly } from "./chat-commands.js";
import { ensureBrainHome } from "./mcp-sandbox.js";
import { syncFromPointerMap } from "./session-registry.js";
import { clearControlDirs, markBridgeReady } from "./control-bridge.js";
import { ControlInboxRunner } from "./control-inbox-runner.js";
import { clearHandoff, handoffPrefix, loadHandoff, takeHandoffFor } from "./handoff.js";
import {
  canSendImage,
  extractImages,
  imageFailureNote,
  planImageTurn,
  resolveImageBytes,
  type ImageFailure,
} from "./image-reply.js";
import { LONG_REPLY_THRESHOLD, buildMdReply } from "./md-reply.js";
import { isAuthorizedSender } from "./access.js";
import { handleControl, handleControlRequest } from "./daemon-control.js";
import { shouldDeferTaskPush } from "./pending-push.js";
import { SendPipeline } from "./send-pipeline.js";
import { finishPollBatch } from "./poller-batch.js";
import {
  dispatchTask,
  injectTask,
  stopTask,
  hasActiveTask,
  awaitingTasks,
  interruptedTasks,
  shouldResumeTask,
  renderTaskList,
  initTasks,
  setTaskPush,
  setTaskTyping,
  setTaskStateSink,
  setTaskAckSink,
  type TaskStateSnapshot,
} from "./task-manager.js";
import { clearTaskDirs, writeTaskAck } from "./task-inbox.js";
import { scanTaskInbox } from "./task-inbox-runner.js";
import { killAll as killWorkerPool, sweep as sweepWorkerPool } from "./worker-pool.js";
import { ensureWorkerHome } from "./worker-sandbox.js";

const log = (...a: unknown[]) => console.error("[wemind/wechat-daemon]", ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

import {
  brainErrorMessage,
  brainFailurePlan,
  extractText,
  isFastLane,
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
  type TaskFacts,
} from "./daemon-routing.js";

export {
  brainErrorMessage,
  brainFailurePlan,
  isFastLane,
  parseBrainEscape,
  parseControl,
  parseTaskControl,
  shouldResumeInBrainQueue,
} from "./daemon-routing.js";
export type { TaskFacts } from "./daemon-routing.js";

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
    log(`setTyping(${status}) failed:`, String(e));
  }
}

async function reply(
  account: AccountData,
  to: string,
  ctx: string | undefined,
  text: string,
  state: number = MessageState.FINISH,
  fallbackToken?: string,
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
      log("send -2(限流或token失效) → 退避 1.5s 后重试");
      await new Promise((r) => setTimeout(r, 1500));
      await send(fallbackToken && fallbackToken !== ctx ? fallbackToken : ctx);
      return;
    }
    // 传输层错误（网络抖动 fetch failed/ECONNRESET/超时等）：可重试类退避 1.5s 后重试一次
    if (!(e instanceof ILinkError)) {
      const t = classifyTransportError(e);
      if (t.retryable) {
        log(`send 传输错误(${t.kind}) → 退避 1.5s 后重试`);
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
    log("send error:", e.message);
    if (e.kind === "session_expired") {
      pauseSession(account.botId);
      log("会话过期(-14) on send → 该账号暂停 1h，待重新登录");
    }
  } else {
    const t = classifyTransportError(e);
    log(`send error(传输/${t.kind}${t.retryable ? ",可重试" : ""}):`, t.message);
  }
}

// iLink 在用户回复前能连续发送的消息数上限（实测约 10，可调）。
const CONSEC_SEND_LIMIT = Number(process.env.WECHAT_CONSEC_SEND_LIMIT) || 10;
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
      reply(account, to, ctx, text, state, fallbackToken),
    sendImage: (to, ctx, image) =>
      sendImage({
        baseUrl: account.baseUrl,
        token: account.botToken,
        to,
        image,
        contextToken: ctx,
      }),
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
      log(`final as md file: ${fileName} (${text.length} chars)`);
    },
    onSendError: (e) => handleSendError(e, account),
    isParamError,
    log,
    minGapMs: Number(process.env.WECHAT_MIN_SEND_GAP_MS) || 1500,
    consecLimit: CONSEC_SEND_LIMIT,
  });
}

// 当前进行中回合（worker 串行，只有一个）：记录发往用户与所用 token（token 可被「继续」更新）。
let activeTurn: { from: string; token: string | undefined } | null = null;

/** 从解密后的字节嗅探图片 MIME。 */
function sniffMime(b: Buffer): string {
  const h = b.subarray(0, 4).toString("hex");
  if (h.startsWith("89504e47")) return "image/png";
  if (h.startsWith("47494638")) return "image/gif";
  if (h.startsWith("52494646")) return "image/webp";
  return "image/jpeg";
}

/**
 * 处理一条发给大脑的消息。返回**是否真的答成了**（`brainErrorMessage` 兜底算没答成）——
 * 交接摘要的消费就靠这个返回值：只有答成了才把摘要删掉（失败留着，下次还能用）。
 */
async function handleMessage(
  account: AccountData,
  sends: SendPipeline,
  ctx: string | undefined,
  to: string,
  text: string,
  imageItems: ImageItem[],
  createTimeMs?: number,
  latestToken?: () => string | undefined,
): Promise<boolean> {
  const msgAge = () => (createTimeMs ? `${Math.round((Date.now() - createTimeMs) / 1000)}s` : "?"); // 这条消息已存在多久（诊断用）
  // activeTurn 只存当前回合的 from/token；连续发送计数用按用户、跨回合的 budgetOf(to)（不在回合开始清零）。
  activeTurn = { from: to, token: ctx };
  const cx = () => activeTurn?.token ?? ctx;
  await setTyping(account, to, cx(), 1);
  // 处理期间每 5s 续发"正在输入"（sendtyping 不计入连续消息上限），避免长任务时指示消失、用户以为卡了。
  // 间隔需小于客户端对 typing 的自动过期（约 5–8s），否则中间会出现指示闪烁的空洞。
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
  const sendProgress = (msg: string, opts?: { ackOnly?: boolean }) => {
    cancelAck(); // 任何进度都顶替待发的即时确认
    lastProgressAt = Date.now();
    const b = sends.budgetOf(to);
    if (b.awaiting) return; // 等待「继续」期间不发任何进度
    const now = Date.now();
    visibleProgressSent = true;
    if (!opts?.ackOnly) lastNonAckProgressAt = now; // 5s 确认不能挡住 15s 的第二条
    // 发出一条文本会把客户端刚显示的「正在输入」顶掉 → 消息送达后立刻补发一次 typing，否则接下来的等待窗口看不到指示。
    const sendWithTyping = (text: string) => {
      void sends
        .sendOrdered(to, cx(), text, MessageState.GENERATING)
        .then(() => setTyping(account, to, cx(), 1))
        .catch(() => {});
    };
    if (b.count >= CONSEC_SEND_LIMIT - 2) {
      b.count += 1;
      b.awaiting = true;
      sendWithTyping(
        "⚠️ 接近微信连续消息上限，我先暂停进度提示、继续在后台处理；完成后会把结果直接发给你。想立刻恢复进度可回复「继续」。",
      );
      return;
    }
    b.count += 1;
    sendWithTyping(msg);
  };
  // 第 5s 的即时确认：只在之前没有任何可见进度时发（工具/心跳/图片提示都会顶替它）。有图片时图片提示即确认，不再重复发。
  if (imageItems.length === 0) {
    const t = cx();
    log(`turn start to=${to} msgAge=${msgAge()} usingCtx=…${t ? t.slice(-12) : "NONE"}`);
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

  // 收图：下载并解密（失败的跳过）
  const images: Array<{ data: string; mimeType: string }> = [];
  if (imageItems.length > 0) {
    sendProgress(`🖼️ 收到 ${imageItems.length} 张图片，下载识别中…`);
    for (const im of imageItems) {
      try {
        const buf = await downloadImage(im);
        images.push({ data: buf.toString("base64"), mimeType: sniffMime(buf) });
      } catch (e) {
        log("image download failed:", String(e));
      }
    }
  }

  // 收图后怎么走：全部下载失败/大脑不支持时，有文字就只按文字答，没文字就直接拒绝（别拿空 prompt 浪费一回合）
  const plan = planImageTurn(imageItems.length, images.length, supportsImages(), !!text.trim());
  if (plan.kind === "reject") {
    clearInterval(keepAlive);
    clearInterval(heartbeat);
    finalStarted = true;
    cancelAck();
    cancelSecond();
    await setTyping(account, to, cx(), 2);
    sends.budgetOf(to).count += 1;
    let sendFailed = false;
    try {
      await sends.sendOrdered(to, cx(), plan.text, MessageState.FINISH, undefined, (e) => {
        sendFailed = true;
        sends.holdUndelivered(to, plan.text, e);
      });
      log("image unusable and no text; rejected gracefully");
    } finally {
      sends.flushDeferredTaskPushes(to, latestToken ? latestToken() : cx(), sendFailed);
      activeTurn = null;
    }
    return false; // 没有答成：交接摘要不能被消费掉
  }
  const imageNote = plan.kind === "text-only" ? plan.note : "";
  if (imageNote) log(`image ignored (${images.length}/${imageItems.length} usable): ${imageNote}`);

  // 一次尝试：带进度（步骤编号每次尝试重置）。进度消息节流：避免一回合刷十几条触发 iLink 发送限流（疑似 ret=-2 主因）
  const attempt = (promptText: string, imgs: typeof images): Promise<string> => {
    answerStarted = false; // 每次重试重新判断本轮正文是否开始，避免上一轮失败尝试的残留
    let step = 0;
    let lastToolProgressAt = 0;
    return askBrain(
      to,
      promptText,
      (ev) => {
        if (ev.type === "tool") {
          lastProgressAt = Date.now(); // 工具活动刷新心跳基线
          // 首条立即发（让你知道开始干活了），之后每 15s 最多一条，避免刷屏 + 触发限流
          if (Date.now() - lastToolProgressAt >= 15000) {
            lastToolProgressAt = Date.now();
            step += 1; // 只在真正发出时递增，保证步骤号连续（不因节流跳号）
            const desc = toolSummary(ev.kind, ev.title, ev.purpose, ev.detail);
            sendProgress(`${toolIcon(ev.kind)} 步骤 ${step}：${desc}`);
          }
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
        log(`brain error (try ${n}, ${plan.category}): ${String(e)}`);
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
  let answer: string;
  let ok = true;
  try {
    answer = await runWithRetry(text, imagesForBrain);
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
  // 发图：从回复里提取图片引用（markdown ![](url/路径) 或裸图片 URL），逐个作为图片消息发出，再发剩余文本
  const { images: replyImages, text: cleaned } = extractImages(answer || "");
  const failedImgs: ImageFailure[] = [];
  for (const im of replyImages) {
    let buf: Buffer;
    try {
      buf = await resolveImageBytes(im.src);
    } catch (e) {
      log("image download failed:", im.src, String(e));
      failedImgs.push({ src: im.src, reason: "download" });
      continue;
    }
    if (!canSendImage(sends.budgetOf(to).count, CONSEC_SEND_LIMIT)) {
      log("image skipped (连发额度留给最终文字):", im.src);
      failedImgs.push({ src: im.src, reason: "budget" });
      continue;
    }
    sends.budgetOf(to).count += 1; // 图片也占一条连发额度
    if (await sends.sendImageOrdered(to, cx(), buf)) {
      log(`sent image: ${im.src.slice(0, 80)}`);
    } else {
      log("send image failed:", im.src);
      failedImgs.push({ src: im.src, reason: "send" });
    }
  }
  let finalText = cleaned;
  if (imageNote) finalText = finalText ? `${imageNote}\n${finalText}` : imageNote;
  const note = imageFailureNote(failedImgs);
  if (note) finalText = finalText ? `${finalText}\n\n${note}` : note;
  if (!finalText && !replyImages.length) finalText = "（没有内容）";
  let finalSendFailed = false;
  if (finalText) {
    sends.budgetOf(to).count += 1; // 最终答案占一条额度（等待段预留的最后一条）
    log(`final send: msgAge=${msgAge()} sent=${sends.budgetOf(to).count} len=${finalText.length}`);
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
  log(`replied to ${to} (msgAge=${msgAge()}): ${(answer || "").slice(0, 60)}`);
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
  imageItems: ImageItem[];
  createTimeMs?: number;
  contextToken?: string;
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

async function pollerLoop(
  account: AccountData,
  owner: string,
  state: ServerState,
  sends: SendPipeline,
): Promise<void> {
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
      log("getUpdates error:", String(e));
      await sleep(2000);
      continue;
    }
    try {
      if (resp.errcode === SESSION_EXPIRED_ERRCODE) {
        log("session expired (-14); pausing 1h. Send a WeChat message to revive after re-login.");
        pauseSession(account.botId);
        continue;
      }
      if (resp.errcode) {
        log("server error:", resp.errcode, resp.errmsg);
        await sleep(2000);
        continue;
      }
      if (resp.get_updates_buf) state.updatesBuf = resp.get_updates_buf;

      const news = (resp.msgs ?? []).filter(
        (m) =>
          m.message_type === MessageType.USER && m.message_id && m.message_id > state.lastMessageId,
      );
      // 先登记本批所有最新 token（worker 发送时取最新）
      for (const m of news) {
        const f = m.from_user_id ?? "";
        if (isAuthorizedSender(f, owner, isAllowed))
          log(
            `recv msg id=${m.message_id} ctx=…${m.context_token ? m.context_token.slice(-12) : "NONE"} age=${m.create_time_ms ? Math.round((Date.now() - m.create_time_ms) / 1000) + "s" : "?"}`,
          );
        if (m.context_token) {
          state.contextTokens[`${account.botId}:${f}`] = m.context_token;
          sends.markFresh(f); // 本进程拿到的 token——此后该用户的 -2 不再当「旧 token」挂起
        }
      }
      let enq = false;
      for (const msg of news) {
        state.lastMessageId = Math.max(state.lastMessageId, msg.message_id ?? 0);
        const from = msg.from_user_id ?? "";
        if (!isAuthorizedSender(from, owner, isAllowed)) {
          log("ignore unauthorized sender:", from);
          continue;
        }
        const text = extractText(msg);
        const voiceItem = (msg.item_list ?? []).find(
          (it) => it.type === MessageItemType.VOICE,
        )?.voice_item;
        if (voiceItem)
          log(
            `recv voice: text=${voiceItem.text ? `"${voiceItem.text.slice(0, 30)}"` : "(空,无微信转写)"} playtime=${voiceItem.playtime ?? "?"}`,
          );
        const imageItems = (msg.item_list ?? [])
          .filter((it) => it.type === MessageItemType.IMAGE && it.image_item)
          .map((it) => it.image_item as ImageItem);
        if (!text && imageItems.length === 0) {
          log("skip empty/unsupported message");
          continue;
        }
        // 服务端按「距用户上一条消息」计连续发送数 → 任何来自 owner 的消息都重置该用户计数 + 退出等待段。但已经进了 replyChain、会在本条消息之后才上线路的发送（补发、上一回合没发完的）仍占新窗口的额度，所以不能直接清零，而是把它们算进来。
        const b = sends.budgetOf(from);
        const wasAwaiting = b.awaiting;
        b.count = sends.inflightCount(from);
        b.awaiting = false;
        // 「继续」且当前回合正处于「等待继续」段：换用本消息新 token 恢复，且仅作恢复信号、不入队
        if (text.trim() === "继续" && activeTurn && activeTurn.from === from && wasAwaiting) {
          activeTurn.token = msg.context_token ?? activeTurn.token;
          log("收到「继续」(等待中) → 恢复进度、重置计数、换新 token");
          continue;
        }
        const queued: QueuedMsg = {
          from,
          text,
          imageItems,
          createTimeMs: msg.create_time_ms,
          contextToken: msg.context_token,
        };
        const facts: TaskFacts = {
          awaiting: awaitingTasks(from).length,
          active: hasActiveTask(from),
          interrupted: interruptedTasks(from).length,
        };
        if (isFastLane(text, facts)) fastQueue.push(queued);
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
      if (saveErr)
        log(
          "save state failed:",
          saveErr instanceof Error ? saveErr.stack || saveErr.message : String(saveErr),
        );
    } catch (e) {
      log("poller error:", e instanceof Error ? e.stack || e.message : String(e));
    }
  }
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
      log(`快车道答复让位给本回合最终答案 → 回合结束后发（累计 ${n} 条，${from}）`);
      return Promise.resolve();
    }
    return sends.sendNotice(from, ctx, text, fallback);
  };
  const facts: TaskFacts = {
    awaiting: awaitingTasks(from).length,
    active: hasActiveTask(from),
    interrupted: interruptedTasks(from).length,
  };

  // 控制指令：单独处理
  const ctrl = item.text ? parseControl(item.text) : null;
  if (ctrl) {
    // owner-only（切脑/交接）：非本人 → 短提示拒绝，**不**转发给大脑（否则大脑可能替用户执行越权动作）
    if (isOwnerOnly(ctrl) && from !== owner) {
      const r = "这条指令仅登录者可用。发送「帮助」看你自己的指令。";
      log("control: denied(not owner)", JSON.stringify(ctrl));
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
      r = await handleControl(ctrl, from, { owner, notify, notifyFile });
    } catch (e) {
      r = "处理指令出错：" + String(e);
    }
    log("control:", JSON.stringify(ctrl), "->", r.replace(/\n/g, " | "));
    await notice(r);
    return;
  }

  // ── 任务路由 ──
  // 1) 结束任务（可带编号/全部）
  const tcmd = item.text ? parseTaskControl(item.text) : null;
  if (tcmd?.kind === "stop") {
    const r = stopTask(from, tcmd.id);
    log("task: stop ->", r.replace(/\n/g, " | "));
    await notice(r);
    return;
  }
  // 2) 任务列表
  if (tcmd?.kind === "tasks") {
    await notice(renderTaskList(from));
    return;
  }
  // 3) 给指定编号的任务回话
  if (tcmd?.kind === "reply") {
    const r = injectTask(from, tcmd.text, tcmd.id);
    log(`task: inject(#${tcmd.id}):`, tcmd.text.slice(0, 40));
    if (r) await notice(r);
    return;
  }
  // 4) 派发：带 agent 名 = 指定 agent 起一条**新任务**（多任务并行）；不带 = 沿用「有任务就发给它，没有就派发」
  if (tcmd?.kind === "toWorker" && tcmd.agentToken) {
    // 指定的 agent **只对这条任务生效**，不改默认任务大脑：那是账号级状态（`切换任务大脑` 是 owner-only），顺手改会让「派一条任务」变成一次隐形的全局设置变更，也破坏微信与 CLI（`--agent` 只影响那一条任务）两边的对称。
    const r = dispatchTask(from, tcmd.text, { agentKey: tcmd.agentToken });
    log(`task: dispatch(agent=${tcmd.agentToken}):`, r.replace(/\n/g, " | "));
    await notice(r);
    return;
  }
  if (tcmd?.kind === "toWorker") {
    // 明确发给 worker：有活跃任务 → 发给它/追加（唯一一条喂下一轮、running 暂存、多条则回编号提示）；
    // 没有活跃任务 → 派发新任务（不「续跑」已中断的：那是「继续」/`#n 继续` 的事，明确派发就该是新的活）。
    if (hasActiveTask(from)) {
      const r = injectTask(from, tcmd.text);
      log("task: inject(explicit):", tcmd.text.slice(0, 40), "->", r.replace(/\n/g, " | "));
      if (r) await notice(r);
    } else {
      const r = dispatchTask(from, tcmd.text);
      log("task: dispatch:", r.replace(/\n/g, " | "));
      await notice(r);
    }
    return;
  }

  // poller 按**入队时**的任务状态把「继续」类短句送进快车道；出队时状态可能已变（任务刚出完结果），
  // 这时交回大脑队列，保持「到出队才最终判定」的旧语义。
  if (shouldResumeTask(item.text, facts)) {
    const r = injectTask(from, item.text);
    log("task: resume(unnumbered):", item.text.slice(0, 40), "->", r.replace(/\n/g, " | "));
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
      log("fast command error:", e instanceof Error ? e.stack || e.message : String(e));
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
      shouldResumeInBrainQueue(item.text, item.imageItems.length, {
        awaiting: awaitingTasks(from).length,
        active: hasActiveTask(from),
        interrupted: interruptedTasks(from).length,
      })
    ) {
      const r = injectTask(from, item.text);
      log("task: resume(unnumbered):", item.text.slice(0, 40), "->", r.replace(/\n/g, " | "));
      if (r) await sends.sendNotice(from, token, r, latestToken());
      continue;
    }

    const brainText = brainEscape ?? item.text;
    // 交接注入：切换大脑后，发给**新**大脑的第一条消息带上前一个大脑留下的摘要（切回来源大脑、别人、
    // 过期都不带上，规则见 handoff.ts）。作为前缀带上 = 不额外占一个回合、不多一次模型调用。
    // 切换进行中时按**目标**大脑判断（这条消息会在门口等新大脑就绪，实际答话的是它）。
    const pending = loadHandoff(DATA_DIR);
    const goal = switchInFlightTarget() ?? getAgent("brain").name;
    const htext = takeHandoffFor(pending, goal, from);
    const withHandoff =
      pending && htext ? handoffPrefix(pending.fromAgent, htext) + brainText : brainText;
    if (htext) log(`handoff injected from=${pending?.fromAgent} to=${goal} chars=${htext.length}`);
    try {
      const answered = await handleMessage(
        account,
        sends,
        token,
        from,
        withHandoff,
        item.imageItems,
        item.createTimeMs,
        latestToken,
      );
      // 答成才消费：失败/被图片挡下就留着，下次还能用。
      // 切回来答话（回滚到来源大脑，或切换目标就是它）也不消费——那是它自己写的摘要，留着下次切走时用。
      const answeredBy = getAgent("brain").name;
      if (htext && answered && answeredBy !== pending?.fromAgent && clearHandoff(DATA_DIR))
        log(`handoff consumed by ${answeredBy}`);
    } catch (e) {
      log("handleMessage error:", e instanceof Error ? e.stack || e.message : String(e));
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

export async function runDaemon(): Promise<void> {
  // 单实例：同账号只允许一个 daemon 消费同一个 bot token。
  // `wimind start` 有 wrapper.pid 守卫；这里挡住直接 `wimind daemon` / `npm run daemon`，以及两套 runner 并存。
  const pidFile = path.join(DATA_DIR, "daemon.pid");
  const existing = otherOurProcessPid(readPidFile(pidFile), process.pid, CLI_PID_MARKERS);
  if (existing) {
    log(`another daemon is already running for this account (pid=${existing}); exit.`);
    process.exit(DAEMON_ALREADY_RUNNING_EXIT_CODE);
  }
  // 启动即校验大脑：早失败、说人话——避免「进程看着正常、直到第一条消息才炸」（历史上表现为反复「⏳ 响应中断了，正在自动重试…」，实为默认大脑的二进制没装）。
  // 先种槽位再校验：此后运行期一律从槽位取 agent（热切换会更新它，见 agent-slot.ts），启动期与运行期同一个来源。
  seedSlots(loadBrainConfig());
  const agent = getAgent("brain");
  const brainProblem = agentProblem(agent);
  if (brainProblem) {
    log(`FATAL 大脑不可用：${brainProblem}`);
    process.exit(BRAIN_CONFIG_EXIT_CODE); // 后台守护进程据此停止自动重启（配置错误重拉无益）
  }
  log(
    `brain=${agent.name} bin=${agent.bin} args=[${agent.args.join(" ")}] shell=${agent.shell} (source: ${agent.source})`,
  );
  // 运行时身份：list 在 daemon 活着时据此显示「实际生效的大脑」（brain.pid 要等 ACP 懒启动才有）
  writeBrainState(DATA_DIR, agent);
  const wagent = getAgent("worker");
  if (wagent.name !== agent.name)
    log(
      `worker=${wagent.name} bin=${wagent.bin} args=[${wagent.args.join(" ")}] (source: ${wagent.source})`,
    );
  // 任务大脑不可用只警告、不退出：只聊天的用户不受影响，但派发任务会失败——早说清楚比任务静默失败好。
  const workerProblem = agentProblem(wagent);
  if (workerProblem) log(`WARN 任务大脑不可用（派发任务会失败）：${workerProblem}`);
  const account = loadAccount();
  if (!account?.botToken) {
    log("not logged in; run the MCP login_qrcode flow first.");
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
    log(
      "unhandledRejection:",
      reason instanceof Error ? reason.stack || reason.message : String(reason),
    );
  });
  process.on("uncaughtException", (err) => {
    log("uncaughtException:", err?.stack || String(err));
  });
  ensureBrainHome(); // 准备 brain 沙箱（默认空 MCP）
  ensureWorkerHome(); // 准备 worker 沙箱（继承全量 MCP 除 wechat + 记忆/技能/settings）
  log(`up. bot=${account.botId} owner=${owner} allowFrom=${readAllowFrom(DATA_DIR).length}`);
  await notifyStart({ baseUrl: account.baseUrl, token: account.botToken }).catch(() => {});

  const state: ServerState = loadState();
  const sends = createSendPipeline(account);
  // worker 任务推送：用该用户最新 token 经串行发送层发出（与 brain 共用 sendOrdered，保证不乱序）
  setTaskPush((to, text) => {
    const tok = state.contextTokens[`${account.botId}:${to}`];
    // task 推送也占用连续发送额度（与 brain 回合共用 budgetOf）：task 在后台运行，可能与 brain 回合并发，若不计数，本地 budget 会低估服务端真实连续发送数 → brain 的 sendProgress 误判「还能发」→ 撞 ret=-2 限流、结果丢失。
    // 注：task 推送是「本轮结果」（必须送达），故只累加计数、不被 awaiting 暂停（暂停只作用于可丢弃的 brain 进度提示）。
    const b = sends.budgetOf(to);
    // 但大脑回合已接近上限时，最后一条额度要留给最终答案：先延后，回合结束后再发（见 flushDeferredTaskPushes）。
    if (shouldDeferTaskPush(activeTurn?.from, to, b.count, CONSEC_SEND_LIMIT)) {
      const n = sends.deferTaskPush(to, text);
      log(`任务推送遇大脑回合额度将满 → 延后到回合结束（累计 ${n} 条，${to}）`);
      return;
    }
    b.count += 1;
    void sends.sendOrdered(to, tok, text, MessageState.FINISH, tok, (e) =>
      sends.holdUndelivered(to, text, e),
    );
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
    stop: stopTask,
    writeAck: (ackId: string | undefined, text: string) => writeTaskAck(DATA_DIR, ackId, text),
    log,
  };
  setInterval(() => scanTaskInbox(DATA_DIR, owner, taskInboxOps), TASK_SCAN_MS);
  // 控制桥：同样「启动清空 + 独立定时器扫描」（作废重启前的残留命令，防重放）
  clearControlDirs(DATA_DIR);
  markBridgeReady(DATA_DIR, process.pid); // 凭据：CLI 据此判断「在跑的这个 daemon 认不认识控制桥」
  const controlInbox = new ControlInboxRunner(DATA_DIR, {
    handle: handleControlRequest,
    log,
  });
  setInterval(() => void controlInbox.scan(owner), TASK_SCAN_MS);
  // 任务表：读回上次的（未完成的标「已中断」，不自动恢复）；编号接着排
  const restored = initTasks(DATA_DIR);
  if (restored.interrupted.length)
    log(`restored tasks: interrupted=[${restored.interrupted.join(",")}]（回「继续」可续跑）`);
  // 会话登记表：把当前会话表里有、登记表里还没有的旧会话补进去（功能上线前的老账号，一次性、幂等）
  const backfilled = syncFromPointerMap(DATA_DIR);
  if (backfilled) log(`session registry backfilled: ${backfilled} 条（来自当前会话表）`);
  // 进程池清扫：空闲超时的 worker 回收（默认 5 分钟）
  const poolSweep = setInterval(() => sweepWorkerPool(), 30_000);
  poolSweep.unref?.();
  // 解耦运行：拉取器持续抓消息(永不被大脑阻塞)，大脑与快车道各一个处理器并发
  void pollerLoop(account, owner, state, sends);
  void fastWorkerLoop(account, sends, state, owner);
  await workerLoop(account, sends, state);
}

// daemon 本体由 cli.ts 的 `wemind daemon` 调用 runDaemon() 启动，此处不再顶层自启。
