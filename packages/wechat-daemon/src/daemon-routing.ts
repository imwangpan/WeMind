import type { WeixinMessage } from "@wemind/wechat-ilink-core";
import { MessageItemType } from "@wemind/wechat-ilink-core";
import { authHint } from "./brain-agents.js";
import {
  parseChatCommand,
  parseTaskCommand,
  type ChatCommand,
  type TaskCommand,
} from "./chat-commands.js";
import { providerIssue, shouldResumeTask } from "./task-manager.js";

/** 快回合的进度抑制阈值：即时确认延迟到 5s；「正在整理回复」只在回合满 5s 且尚未发过即时确认时发。 */
export const PROGRESS_ACK_DELAY_MS = 5_000;
export const PROGRESS_ANSWER_MIN_MS = 5_000;

/** 是否值得为这一回合再发「正在整理回复」：简单短回合只留最终答案，避免多占一条连发额度。 */
export function shouldShowAnswerNotice(elapsedMs: number, ackSent: boolean): boolean {
  return !ackSent && elapsedMs >= PROGRESS_ANSWER_MIN_MS;
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

export function extractText(msg: WeixinMessage): string {
  return (msg.item_list ?? [])
    .map((it) => {
      if (it.type === MessageItemType.TEXT) return it.text_item?.text ?? "";
      if (it.type === MessageItemType.VOICE) return it.voice_item?.text ?? ""; // 微信侧语音转文字（省事路）
      return "";
    })
    .filter((s) => s)
    .join("\n")
    .trim();
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
 * 注意：切脑 / 会话 / 交接也在快车道，但它们要操作同一个 ACP 连接，仍会在 ACP 门口等当前回合结束——那是语义要求，不是排队阻塞。
 */
export function isFastLane(text: string, tasks: TaskFacts): boolean {
  const t = (text ?? "").trim();
  if (!t || parseBrainEscape(t)) return false;
  if (parseControl(t) || parseTaskControl(t)) return true;
  return shouldResumeTask(t, tasks);
}

/** 大脑队列里的无编号消息是否该交给任务：只有「继续」类短句 + 确实有可续跑任务；带图片的消息永远给大脑。 */
export function shouldResumeInBrainQueue(
  text: string,
  imageCount: number,
  tasks: TaskFacts,
): boolean {
  return imageCount === 0 && shouldResumeTask(text, tasks);
}
