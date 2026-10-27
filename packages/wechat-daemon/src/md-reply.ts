/**
 * 长回复转 Markdown 文件：超过阈值的回复正文，作为 .md 文件发送（一条消息），比拆成多条文本更不易触发 iLink 连续发送上限、且阅读体验完整。
 * 文件名由内容生成一个合适的标题。
 */

/** 超过此字符数的回复转 .md 文件发送。可用 WECHAT_REPLY_FILE_THRESHOLD 覆盖。 */
export const LONG_REPLY_THRESHOLD = Number(process.env.WECHAT_REPLY_FILE_THRESHOLD) || 1500;

const ILLEGAL_FILENAME = /[\\/:*?"<>|\r\n\t]/g;

/** 由内容生成一个合适的标题：取首个 Markdown 标题或首个非空行，清洗为合法文件名片段。 */
export function generateTitle(text: string): string {
  let first = "";
  for (const ln of text.split(/\r?\n/)) {
    const t = ln.trim();
    if (t) {
      first = t;
      break;
    }
  }
  // 去掉行首的 Markdown 标记（标题井号、列表符、有序号）
  first = first
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/[*_`~]/g, "");
  first = first.replace(ILLEGAL_FILENAME, " ").replace(/\s+/g, " ").trim();
  if (first.length > 40) first = first.slice(0, 40).trim();
  return first || "回复";
}

/**
 * 构造长回复的 md 文件（不落盘，直接内存 buffer）。
 * 若正文未以 Markdown 标题开头，则前置一个由内容生成的 H1，便于打开后阅读。
 */
export function buildMdReply(text: string): { fileName: string; data: Buffer } {
  const title = generateTitle(text);
  const body = /^\s*#/.test(text) ? text : `# ${title}\n\n${text}`;
  return { fileName: `${title}.md`, data: Buffer.from(body, "utf-8") };
}
