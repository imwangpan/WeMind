import type {
  FileItem,
  ImageItem,
  MessageItem,
  RefMessage,
  VideoItem,
  VoiceItem,
  WeixinMessage,
} from "@wemind/wechat-ilink-core";
import { MessageItemType } from "@wemind/wechat-ilink-core";
import { authHint } from "../agents/brain-agents.js";
import {
  parseChatCommand,
  parseTaskCommand,
  type ChatCommand,
  type TaskCommand,
} from "../ipc/chat-commands.js";
import { providerIssue, shouldResumeTask } from "../tasks/task-manager.js";

/**
 * 三档进度（按最终答案到达时间）：
 * - <5s：只发最终答案；
 * - 5–15s：第 5s 发「收到」；
 * - ≥15s：第 5s 发「收到」，第 15s 再发第二条（正文已开始→「整理回复」，否则→「还在处理中」）。
 * 固定提示让位于已有进度：5s 时已发过工具/心跳/图片/重试提示就不再发确认；15s 的第二条要求距上一条非确认进度 ≥5s。
 */
export const PROGRESS_ACK_DELAY_MS = 5_000;
export const PROGRESS_SECOND_NOTICE_MS = 15_000;
export const PROGRESS_NOTICE_GAP_MS = 5_000;

/** 第 5s 的即时确认：只在还没有任何可见进度时发（有进度就顶替它）。 */
export function shouldShowAck(progressSent: boolean): boolean {
  return !progressSent;
}

/** 第 15s 的第二条：最终答案未发出，且距上一条非确认进度至少 5s（确认本身不算，否则它会挡住第二条）。 */
export function shouldShowSecondNotice(
  elapsedMs: number,
  finalStarted: boolean,
  sinceNonAckProgressMs: number,
): boolean {
  return (
    !finalStarted &&
    elapsedMs >= PROGRESS_SECOND_NOTICE_MS &&
    sinceNonAckProgressMs >= PROGRESS_NOTICE_GAP_MS
  );
}

/** 第 15s 第二条的措辞：正文已开始 → 整理回复；还在思考/跑工具 → 还在处理中。 */
export function secondNoticeText(answerStarted: boolean): string {
  return answerStarted ? "✍️ 正在整理回复…" : "⏳ 还在处理中…";
}

/** 分类大脑错误：backend=模型后端瞬时错误(可多重试)；timeout=超时/卡死；other=其它。 */
function classifyBrainError(e: unknown): "timeout" | "backend" | "other" {
  const s = String(e instanceof Error ? e.message : e);
  if (
    /-32603|internal error|please try again|response stream|overloaded|rate.?limit|\b(429|503)\b/i.test(
      s,
    )
  )
    return "backend";
  if (/idle timeout|no-first-frame|cap timeout|timeout/i.test(s)) return "timeout";
  return "other";
}
/**
 * 一次大脑失败该怎么处置：provider 侧（余额/额度、密钥鉴权、计费、模型不存在）是**永久**错误——
 * 重试只是又白失败一轮，何况每次重试都要先冷启动一个 agent 进程；这类只试 1 次，直接把原因告诉用户。
 * 其余沿用老规矩：backend（`-32603`/限流等瞬时错误）3 次，timeout/其它 2 次。
 */
export function brainFailurePlan(e: unknown): { attemptLimit: number; category: string } {
  const prov = providerIssue(e);
  if (prov) return { attemptLimit: 1, category: `provider：${prov}` };
  const cat = classifyBrainError(e);
  return { attemptLimit: cat === "backend" ? 3 : 2, category: cat };
}
/** 按错误类型给用户的失败提示。`agentName` 用于给特定 agent 补专属建议（如 Cline 的自定义 provider 要设环境变量）。 */
export function brainErrorMessage(e: unknown, agentName?: string): string {
  const prov = providerIssue(e);
  if (prov) {
    // 余额/计费在 provider 侧处理完，重发消息即可（daemon 不用重启）；
    // 密钥/模型类常常是刚在本机改过登录态或 brain.json——运行中的 daemon 不重读配置、也不重新同步凭据（槽位启动时种入），
    // 必须重启一次才生效，所以这句提示要说全，否则用户会陷入「改了、重发、还是错」。
    // Cline 是例外：自定义 provider 只认启动环境里的 CLINE_PROVIDER/CLINE_API_KEY，重启不带变量照样失败——
    // 用 agent 专属提示顶掉通用那句（`authHint`）。
    const auth = agentName ? authHint(agentName, String(e instanceof Error ? e.message : e)) : "";
    const hint = auth
      ? ` ${auth}`
      : prov === "密钥/鉴权有问题" || prov === "模型不可用"
        ? "若刚在本机改过登录态或模型配置，还要重启一次 daemon（wemind stop && wemind start）才会读到。"
        : "";
    return `（这次没答上来：${prov}。这类问题重试不会好——把账号/模型处理好后把消息再发一次就行。${hint}）`;
  }
  switch (classifyBrainError(e)) {
    case "backend":
      return "（模型后端临时出错了，自动重试多次仍失败，请稍后把消息再发一次）";
    case "timeout":
      return "（这次处理超时/卡住被中断了，重试也没成功——可把任务拆小一点再发）";
    default:
      return "（处理出错了，请把消息再发一次试试）";
  }
}

/** 一条入站消息里可交给大脑的附件（图片/语音/文件/视频）。 */
export type InboundAttachment =
  | { kind: "image"; item: ImageItem }
  | { kind: "voice"; item: VoiceItem }
  | { kind: "file"; item: FileItem }
  | { kind: "video"; item: VideoItem };

/** 引用消息的轻量上下文（当前只取服务端下发的内联内容，不查本地缓存；引用缓存尚未实现）。 */
export type QuoteContext = {
  /** 被引用消息的正文摘要（text/voice 转写/文件名/媒体占位）。 */
  body?: string;
  /** 服务端消息 ID；没有正文时用于提示「未缓存」。 */
  svrId?: string;
};

export type InboundParts = {
  text: string;
  attachments: InboundAttachment[];
  quote?: QuoteContext;
  /** 当前 daemon 不认识、也没有任何可用内容的 item 类型（给用户明确提示，不再静默丢）。 */
  unsupportedTypes: number[];
};

/** 从被引用的 item 里提取一句可读正文（不下载媒体）。 */
function quotedItemText(item: MessageItem | undefined): string {
  if (!item) return "";
  switch (item.type) {
    case MessageItemType.TEXT:
      return item.text_item?.text ?? "";
    case MessageItemType.VOICE:
      return item.voice_item?.text ?? "";
    case MessageItemType.IMAGE:
      return "[图片]";
    case MessageItemType.FILE:
      return item.file_item?.file_name ? `[文件: ${item.file_item.file_name}]` : "[文件]";
    case MessageItemType.VIDEO:
      return "[视频]";
    default:
      return "";
  }
}

function quoteFrom(ref: RefMessage | undefined): QuoteContext | undefined {
  if (!ref) return undefined;
  const parts: string[] = [];
  if (ref.title?.trim()) parts.push(ref.title.trim());
  const body = quotedItemText(ref.message_item);
  if (body) parts.push(body);
  return {
    body: parts.length ? parts.join(" | ") : undefined,
    svrId: ref.svr_id?.trim() || ref.message_item?.msg_id?.trim() || undefined,
  };
}

/**
 * 把一条 WeixinMessage 拆成文本、附件和引用上下文。
 * 纯文本/语音转写走 text；媒体附件保留原 item，由 worker 下载（不阻塞 poller）。
 */
export function extractInbound(msg: WeixinMessage): InboundParts {
  const textParts: string[] = [];
  const attachments: InboundAttachment[] = [];
  const unsupportedTypes: number[] = [];
  let quote: QuoteContext | undefined;

  for (const it of msg.item_list ?? []) {
    if (!quote && it.ref_msg) quote = quoteFrom(it.ref_msg);
    switch (it.type) {
      case MessageItemType.TEXT:
        if (it.text_item?.text) textParts.push(it.text_item.text);
        break;
      case MessageItemType.VOICE: {
        // 微信侧语音转文字（省事路）：有转写就只当文本，不再算附件——否则会误触发下载提示，
        // 还会把「结束任务」「继续」这类语音指令挡在快车道/任务续跑之外。
        const transcript = it.voice_item?.text?.trim();
        if (transcript) textParts.push(transcript);
        else if (it.voice_item) attachments.push({ kind: "voice", item: it.voice_item });
        break;
      }
      case MessageItemType.IMAGE:
        if (it.image_item) attachments.push({ kind: "image", item: it.image_item });
        break;
      case MessageItemType.FILE:
        if (it.file_item) attachments.push({ kind: "file", item: it.file_item });
        break;
      case MessageItemType.VIDEO:
        if (it.video_item) attachments.push({ kind: "video", item: it.video_item });
        break;
      case MessageItemType.TOOL_CALL_START:
      case MessageItemType.TOOL_CALL_RESULT:
        // 工具进度 item 一般只出现在 BOT 方向；若服务端回显，忽略即可（不是用户内容）。
        break;
      default:
        if (typeof it.type === "number") unsupportedTypes.push(it.type);
        break;
    }
  }

  return {
    text: textParts.join("\n").trim(),
    attachments,
    quote,
    unsupportedTypes,
  };
}

export function extractText(msg: WeixinMessage): string {
  return extractInbound(msg).text;
}

/** 把引用上下文拼成 prompt 前缀；没有引用时返回空串。 */
export function formatQuote(quote: QuoteContext | undefined): string {
  if (!quote) return "";
  if (quote.body) return `[引用消息] ${quote.body}`;
  if (quote.svrId) return "[引用消息内容未缓存]";
  return "";
}

/** 没有可交给大脑的正文/媒体时，返回给用户的明确提示（不进大脑）；有内容则返回 null。 */
export function contentlessNotice(parts: {
  text: string;
  mediaCount: number;
  unsupportedTypes: number[];
  quote?: QuoteContext;
}): string | null {
  if (parts.text.trim() || parts.mediaCount > 0) return null;
  const notes: string[] = [];
  if (parts.unsupportedTypes.length)
    notes.push(
      `暂不支持这条消息的类型（item type=${parts.unsupportedTypes.join(",")}）。可以改用文字、图片、文件、视频或语音再发一次。`,
    );
  // 引用缓存尚未实现：服务端常只给 svr_id，此时不能静默丢，也不能拿空 prompt 去问大脑。
  if (parts.quote)
    notes.push(
      "只收到一条引用，但微信没有提供引用内容、本地也没有缓存原消息；请把要说的话一起打出来。",
    );
  return notes.length ? notes.join("\n") : null;
}

/** 工具标题中文化（无 purpose 时的兜底）。 */
export function zhTool(t: string): string {
  return t
    .replace(/^Searching the web for:?\s*/i, "联网搜索：")
    .replace(/^Running:?\s*/i, "执行：")
    .replace(/^Reading\s+/i, "读取 ")
    .replace(/^Writing\s+/i, "写入 ")
    .replace(/^Finding\s+/i, "查找 ");
}

/** 工具类型 → 中文动词（有 detail 时拼成「动词 参数」；没有 detail 则回退到标题）。 */
const TOOL_VERB: Record<string, string> = {
  read: "读取",
  edit: "修改",
  write: "写入",
  execute: "执行",
  search: "搜索",
  fetch: "访问",
  delete: "删除",
};

/**
 * 工具步骤的可读文案：优先 agent 自己给的人话 purpose，其次从 rawInput 取出的短参数（command/路径/query…），
 * 最后才用工具标题。长命令由协议层截断，这里只负责语义化，避免微信里出现整段原始参数。
 */
export function toolSummary(
  kind?: string,
  title?: string,
  purpose?: string,
  detail?: string,
): string {
  const p = purpose?.trim();
  if (p) return zhTool(p);
  const d = detail?.trim();
  if (d) {
    const verb = TOOL_VERB[kind ?? ""];
    return verb ? `${verb} ${d}` : d;
  }
  if (title?.trim()) return zhTool(title.trim());
  return "调用工具";
}

/** 按工具类型给图标。 */
export function toolIcon(kind?: string): string {
  switch (kind) {
    case "read":
      return "📄";
    case "search":
      return "🔍";
    case "execute":
      return "⌨️";
    case "fetch":
      return "🌐";
    case "edit":
    case "write":
      return "✏️";
    case "delete":
      return "🗑️";
    default:
      return "🔧";
  }
}

/**
 * 解析控制指令（命中则由 daemon 直接处理，不转发给 brain）。
 * 表与解析逻辑都在 chat-commands.ts（`manage.ts` 也要用它渲染 `wemind help`，故不能留在这里）。
 */
export function parseControl(text: string): ChatCommand | null {
  return parseChatCommand(text);
}

/** 解析「明确发给 worker」指令：任务 [agent：]正文 / >xxx / #编号 正文 / 任务列表 / 结束任务 [编号]。 */
export function parseTaskControl(text: string): TaskCommand | null {
  return parseTaskCommand(text);
}

/** 解析「明确问大脑」逃逸前缀：问大脑 xxx / 问大脑：xxx。命中返回去前缀后的文本（强制走 brain，即使 worker 在等你）。 */
export function parseBrainEscape(text: string): string | null {
  const m = text.trim().match(/^问大脑[:：]?\s*([\s\S]+)$/);
  return m ? m[1].trim() : null;
}

/** 判断「继续」类短句时要用到的任务现状（由 task-manager 提供，纯函数便于单测）。 */
export type TaskFacts = { awaiting: number; active: boolean; interrupted: number };

/**
 * 这条消息是否走**快车道**：控制指令与任务指令不经过大脑，不该排在一条十几分钟的大脑回合后面。
 * 「继续」类短句在确实有可续跑任务时也走快车道；问大脑前缀永远走大脑。
 * 带附件的消息一律走大脑：控制/任务指令目前不消费附件，放快车道会静默丢掉用户发来的文件。
 * 注意：切脑 / 会话 / 交接也在快车道，但它们要操作同一个 ACP 连接，仍会在 ACP 门口等当前回合结束——那是语义要求，不是排队阻塞。
 */
export function isFastLane(text: string, tasks: TaskFacts, attachmentCount = 0): boolean {
  if (attachmentCount > 0) return false;
  const t = (text ?? "").trim();
  if (!t || parseBrainEscape(t)) return false;
  if (parseControl(t) || parseTaskControl(t)) return true;
  return shouldResumeTask(t, tasks);
}

/** 大脑队列里的无编号消息是否该交给任务：只有「继续」类短句 + 确实有可续跑任务；带任何媒体的消息永远给大脑。 */
export function shouldResumeInBrainQueue(
  text: string,
  mediaCount: number,
  tasks: TaskFacts,
): boolean {
  return mediaCount === 0 && shouldResumeTask(text, tasks);
}
