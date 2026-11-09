import {
  COMMAND_SPECS,
  TASK_COMMAND_SPECS,
  type ChatCommand,
  type CommandSection,
  type TaskCommand,
} from "./chat-command-specs.js";

export * from "./chat-command-specs.js";

/**
 * 微信指令的**解析与帮助渲染**。表本身（类型、COMMAND_SPECS、TASK_COMMAND_SPECS）在
 * chat-command-specs.ts；这里只做整串锚定匹配与帮助输出，re-export 保持外部 import 路径不变。
 */

/** 解析一条微信指令（命中 → daemon 自己处理，不转发大脑）；不命中 → null（普通消息）。 */
export function parseChatCommand(text: string): ChatCommand | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  for (const spec of COMMAND_SPECS) {
    const hit = spec.match(t);
    if (hit) return hit;
  }
  return null;
}

/** 解析「任务/worker 相关」指令。先于普通消息判定，后于 parseChatCommand。 */
export function parseTaskCommand(text: string): TaskCommand | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  for (const spec of TASK_COMMAND_SPECS) {
    const hit = spec.match(t);
    if (hit) return hit;
  }
  return null;
}

const SECTION_TITLE: Record<CommandSection, string> = {
  session: "会话（各自只管自己的）",
  task: "任务",
  brain: "大脑（仅登录者）",
  mcp: "MCP",
  misc: "",
};

/** 渲染帮助只需这些字段（两种指令表的公共形状）。 */
type HelpSpec = {
  section: CommandSection;
  ownerOnly?: boolean;
  zh: string;
  slash?: string;
  cli?: string;
  brief: string;
};

function specLines(specs: HelpSpec[], mode: "wechat" | "cli"): string[] {
  const out: string[] = [];
  for (const s of specs) {
    if (mode === "cli") {
      // CLI 帮助只列有 CLI 等价物的条目：加载/卸载 MCP、「允许敏感文件」这类只在微信里操作。
      if (!s.cli) continue;
      out.push(`  ${s.cli} — ${s.brief}`);
    } else {
      const alt = s.slash ? ` ｜ ${s.slash}` : "";
      out.push(`  ${s.zh}${alt} — ${s.brief}`);
    }
  }
  return out;
}

/**
 * 渲染帮助。`role` 非 owner 时**隐藏** owner-only 指令（只留一行说明），避免「看得见、发过去被拒」的挫败。
 * `mode=cli` 时同一张表换成 CLI 写法（`wemind help` 用）；`sections` 可只取几个分区
 * （CLI 帮助里 MCP 是微信侧才有的操作，列进去只会是「（无 CLI）」噪音）。
 */
export function renderHelp(
  role: "owner" | "user" = "owner",
  mode: "wechat" | "cli" = "wechat",
  opts: { sections?: CommandSection[] } = {},
): string {
  const chat = COMMAND_SPECS.filter((s) => role === "owner" || !s.ownerOnly);
  const tasks = TASK_COMMAND_SPECS;
  const head =
    mode === "cli"
      ? "📖 WeMind 指令（CLI 写法；微信里中文/斜杠等价）"
      : "📖 WeMind 指令（中文与斜杠写法等价，任选一种）";
  const lines: string[] = [head];
  const sections =
    opts.sections ?? (["session", "task", "brain", "mcp", "misc"] as CommandSection[]);
  for (const section of sections) {
    const specs = section === "task" ? tasks : chat.filter((s) => s.section === section);
    if (!specs.length) continue;
    const title = SECTION_TITLE[section];
    if (title) lines.push(`【${title}】`);
    lines.push(...specLines(specs, mode));
  }
  if (role !== "owner")
    lines.push("（切换大脑 / 交接这类账号级指令仅登录者可用；会话与任务指令永远只属于你自己。）");
  lines.push("提示：<尖括号> 表示占位内容，实际发送不要带尖括号。");
  return lines.join("\n");
}
