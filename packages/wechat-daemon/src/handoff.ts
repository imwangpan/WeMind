import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "@wemind/wechat-ilink-core";
import { formatWhen } from "./session-registry.js";

/**
 * 会话交接（`交接` / `wemind brain handoff`）：换大脑**不自动迁移上下文**（各 agent 的会话互不相通），
 * 要接着聊就显式交接一次——让旧大脑把上下文写成一段摘要，存盘，然后**作为下一条用户消息的前缀**带进新大脑。
 *
 * 为什么是「前缀」而不是「单独占一个回合」：单独发摘要等于让新大脑先空转一轮（多一次模型调用、多占微信额度），
 * 而且那轮它的回复用户并不想看。前缀注入是零额外成本的：用户本来就要说下一句话，摘要只是挂在前面。
 *
 * 三条克制规则（都由 `takeHandoffFor` 钉死）：
 *  - **只给本人用**：给 A 生成的摘要绝不注入 B 的消息；
 *  - **切回来源大脑不注入**：那是它自己的上下文，塞回去等于对着本人复述；
 *  - **有 TTL**（默认 24h）：过期摘要不注入——几天前的上下文塞给新大脑只会污染判断。
 *
 * 消费语义：注入的那一回合**成功**之后才删（见 index.ts）——失败就留着，下次还能用。
 * 文本处理全是纯函数（`handoffPrefix`/`stripHandoffPrefix`），可单测；文件读写只有 save/load/clear。
 */

export const HANDOFF_VERSION = 1;

/** 摘要有效期：超过就不再注入（可通过 `WEMIND_HANDOFF_TTL_MS` 调整）。 */
export const HANDOFF_TTL_MS = Number(process.env.WEMIND_HANDOFF_TTL_MS) || 24 * 3600_000;

/** 前缀与用户新消息之间的分隔行；注入与剥离靠同一常量，两边不会写岔。 */
export const HANDOFF_SEP = "——以下才是用户的新消息——";

/** 前缀开头，`stripHandoffPrefix` 据此确认「这确实是我们的前缀」而不是用户自己发的正文。 */
export const HANDOFF_HEAD = "【交接摘要 · 来自 ";

export type Handoff = {
  version: number;
  /** 由哪个大脑写的（预设名，小写）。 */
  fromAgent: string;
  /** 给谁写的（微信 userId）。 */
  userId: string;
  /** 摘要正文（Markdown）。 */
  text: string;
  createdAt: number;
  expiresAt: number;
};

export function handoffPath(dir: string = DATA_DIR): string {
  return path.join(dir, "handoff.json");
}

/** 读摘要：缺失/损坏/字段不全/已过期 → null（注入与否只该由「有没有可用的」决定，不该抛）。 */
export function loadHandoff(dir: string = DATA_DIR, now: number = Date.now()): Handoff | null {
  let j: any;
  try {
    j = JSON.parse(fs.readFileSync(handoffPath(dir), "utf-8"));
  } catch {
    return null;
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const fromAgent = typeof j.fromAgent === "string" ? j.fromAgent.trim().toLowerCase() : "";
  const userId = typeof j.userId === "string" ? j.userId.trim() : "";
  const text = typeof j.text === "string" ? j.text.trim() : "";
  if (!fromAgent || !userId || !text) return null;
  const num = (v: unknown, d: number): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d;
  const h: Handoff = {
    version: HANDOFF_VERSION,
    fromAgent,
    userId,
    text,
    createdAt: num(j.createdAt, now),
    expiresAt: num(j.expiresAt, now + HANDOFF_TTL_MS),
  };
  return h.expiresAt > now ? h : null;
}

/** 原子写摘要（tmp + rename）。 */
export function saveHandoff(h: Handoff, dir: string = DATA_DIR): void {
  fs.mkdirSync(dir, { recursive: true });
  const fp = handoffPath(dir);
  const tmp = `${fp}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(h, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, fp);
}

/** 删摘要（注入的那回合成功后调用）；返回是否确有文件。 */
export function clearHandoff(dir: string = DATA_DIR): boolean {
  try {
    fs.unlinkSync(handoffPath(dir));
    return true;
  } catch {
    return false;
  }
}

/**
 * 判断这份摘要要不要注入给 `agent` 的这次对话（纯函数，调用方负责读盘与消费）。
 * 返回正文表示「要注入」，null 表示「不注入」——四种不注入的情形各是一句能对用户解释的话。
 */
export function takeHandoffFor(
  h: Handoff | null,
  agent: string,
  userId: string,
  now: number = Date.now(),
): string | null {
  if (!h) return null;
  const text = h.text?.trim();
  if (!text) return null;
  if (h.userId !== userId) return null;
  if (h.fromAgent === agent.trim().toLowerCase()) return null; // 切回来源大脑：那是它自己的上下文
  if (h.expiresAt <= now) return null;
  return text;
}

/** 交接摘要的生成指令（固定模板：四节、无前后缀，便于新大脑直接当上下文读）。 */
export const HANDOFF_PROMPT = [
  "请把**现在这段对话**整理成一份交接摘要，写给另一个 AI 助手看（它看不到我们的聊天记录，也不会问你）。",
  "只要下面四节，每节几条要点；不要客套、不要复述我的原话、不要写「以下是」这类前后缀：",
  "1. 目标：我们在做什么、做到哪一步；",
  "2. 已确认的结论与决定（含我明确表达过的偏好与约束）；",
  "3. 未决问题：还没定的事、等我回答的问题；",
  "4. 关键事实：文件路径、命令、报错信息、外部资源等硬信息（有多少写多少，别概括掉）。",
  "直接输出 Markdown 摘要正文。",
].join("\n");

/** 注入用前缀（以分隔行结尾，调用方把用户新消息接在后面）。 */
export function handoffPrefix(fromAgent: string, text: string, now: number = Date.now()): string {
  return `${HANDOFF_HEAD}${fromAgent}，${formatWhen(now, now)}】\n${text}\n${HANDOFF_SEP}\n`;
}

/**
 * 从前缀注入后的消息里取回用户真正说的那句（登记表的标题用）。
 * 只在确实是我们的前缀时才剥（开头对得上 `HANDOFF_HEAD`），用户自己打那行字不会被误伤。
 */
export function stripHandoffPrefix(message: string): string {
  const m = message ?? "";
  if (!m.startsWith(HANDOFF_HEAD)) return m;
  const i = m.indexOf(HANDOFF_SEP);
  if (i < 0) return m;
  return m.slice(i + HANDOFF_SEP.length).trim();
}
