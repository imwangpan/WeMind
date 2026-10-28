import { ACP_AGENT_PRESETS } from "./brain-agents.js";

/**
 * 微信指令表：**解析与帮助是同一张表**（一处改动不会让「帮助里写的」和「真正认的」漂移）。
 *
 * 为什么独立成模块：`manage.ts`（CLI 侧）要用它渲染 `wemind help`，而 `manage.ts` **不能** import `index.ts`
 * （那会把 daemon、长轮询、账户状态全拖进每次 CLI 调用）。所以这里保持**无副作用**：不读环境、不碰磁盘、
 * 不在模块加载时解析任何东西——只做纯字符串匹配。
 *
 * 解析规则（与既有 parseControl/parseTaskControl 一致，**整串锚定**）：
 *  - 「整串锚定」意味着 `帮助我写代码`、`mcp 是什么`、`任务很重要` 都是**普通消息**（照旧转给大脑）；
 *  - `任务 <预设>：正文` 里的「冒号前」必须**恰好是一个已知预设名**才算指定 agent，
 *    所以 `任务 明天：去买菜`、`> nav: 去某地` 仍是普通内容（不会因为带冒号就被误当成指定 agent）；
 *  - `#<数字> 正文` 只在 `#`/`＃` 后跟纯数字时才寻址（`#abc 你好` 是普通消息；`#1 号文件在哪` 说的是「1 号文件」，
 *    数字后紧跟「号」也按普通消息，见 task.reply 的 match）；
 *  - 中文写法与斜杠写法**等价**；`/ai` 家族是收敛入口（`/ai`、`/ai brain X`、`/ai task X`）。
 */

export type ChatCommand =
  /** mcp 列表（沿用旧 kind 名，历史测试与调用方不受影响）。 */
  | { kind: "list" }
  /** 新会话（可命名）。 */
  | { kind: "new"; name?: string }
  | { kind: "add"; name: string }
  | { kind: "remove"; name: string }
  /** 会话列表（分页）。 */
  | { kind: "sessions"; page?: number }
  /** 恢复（切回）某个旧会话。 */
  | { kind: "resume"; ref: string }
  | { kind: "rename"; ref: string; name: string }
  | { kind: "delete"; ref: string }
  /** AI 总览：可选 agent + 当前对话大脑 / 默认任务大脑 / 池中进程。 */
  | { kind: "ai" }
  /** 切换对话大脑（无参 = 显示当前）。 */
  | { kind: "brain"; target?: string }
  /** 切默认任务大脑（本次运行内一直生效；不写 brain.json）。 */
  | { kind: "workerBrain"; target?: string }
  /** 生成切换用摘要并落盘。 */
  | { kind: "handoff" }
  | { kind: "help" };

export type TaskCommand =
  /** 派发/注入任务（可选指定 agent）。 */
  | { kind: "toWorker"; text: string; agentToken?: string }
  /** 结束任务（无 id = 唯一那条；`all` = 全部）。 */
  | { kind: "stop"; id?: number | "all" }
  /** 向指定编号的任务注入内容。 */
  | { kind: "reply"; id: number; text: string }
  /** 任务列表。 */
  | { kind: "tasks" };

/** owner-only 的指令：非登录者发送 → 短提示拒绝，**不**转发给大脑（避免大脑替用户执行越权动作）。 */
export const OWNER_ONLY_KINDS: ReadonlySet<ChatCommand["kind"]> = new Set([
  "ai",
  "brain",
  "workerBrain",
  "handoff",
]);

export function isOwnerOnly(cmd: ChatCommand): boolean {
  return OWNER_ONLY_KINDS.has(cmd.kind);
}

export type CommandSection = "session" | "task" | "brain" | "mcp" | "misc";

export type CommandSpec<C> = {
  id: string;
  section: CommandSection;
  /** 仅登录者可用（兜底门：微信平台只投递登录者的消息，正常不会触发）。 */
  ownerOnly?: boolean;
  /** 帮助里的中文写法。 */
  zh: string;
  /** 等价的斜杠写法（无则省略）。 */
  slash?: string;
  /** 等价的 CLI 命令（`wemind help` 与文档用）。 */
  cli?: string;
  brief: string;
  match: (t: string) => C | null;
};

/** 预设定名集合（小写）：`任务 <预设>：正文` 的判定表；`auto` 也算（自动探测）。 */
function agentTokenOk(token: string): boolean {
  const k = token.trim().toLowerCase();
  return k === "auto" || Object.prototype.hasOwnProperty.call(ACP_AGENT_PRESETS, k);
}

/** 中文里常见的「页」写法：`会话列表 2` / `会话列表 第2页` / `会话列表 2 页`。 */
const PAGE_SUFFIX = String.raw`(?:\s*第?\s*(\d+)\s*页?)?`;

export const COMMAND_SPECS: CommandSpec<ChatCommand>[] = [
  {
    id: "mcp.list",
    section: "mcp",
    zh: "mcp",
    slash: "/mcp",
    brief: "列出可选/已激活的 MCP",
    match: (t) => (/^(?:\/?mcp|列出\s*mcp|mcp\s*list)$/i.test(t) ? { kind: "list" } : null),
  },
  {
    id: "mcp.add",
    section: "mcp",
    zh: "加载 <名字>",
    brief: "加载一个 MCP（下条消息生效）",
    match: (t) => {
      const m = t.match(/^(?:加载|load)\s+(\S+)$/i);
      return m ? { kind: "add", name: m[1] } : null;
    },
  },
  {
    id: "mcp.remove",
    section: "mcp",
    zh: "卸载 <名字>",
    brief: "卸载一个 MCP",
    match: (t) => {
      const m = t.match(/^(?:卸载|unload)\s+(\S+)$/i);
      return m ? { kind: "remove", name: m[1] } : null;
    },
  },
  {
    id: "session.new",
    section: "session",
    zh: "新会话 [名字]",
    slash: "/new [名字]",
    cli: "wemind session new [名字]",
    brief: "清空上下文重开（可命名）",
    match: (t) => {
      const m = t.match(/^(?:新会话|重置|清空上下文|\/new|new\s*session)(?:\s+([\s\S]+))?$/i);
      if (!m) return null;
      const name = m[1]?.trim();
      return name ? { kind: "new", name } : { kind: "new" };
    },
  },
  {
    id: "session.list",
    section: "session",
    zh: "会话列表 [页]",
    slash: "/sessions [页]",
    cli: "wemind session list [--page N]",
    brief: "列出本人会话（← 当前 标当前）",
    match: (t) => {
      const m = t.match(
        new RegExp(
          String.raw`^(?:会话列表|查看会话|我的会话|\/sessions?)` + PAGE_SUFFIX + "$",
          "i",
        ),
      );
      if (!m) return null;
      const page = m[1] ? Number(m[1]) : undefined;
      return page ? { kind: "sessions", page } : { kind: "sessions" };
    },
  },
  {
    id: "session.resume",
    section: "session",
    zh: "恢复会话 <序号|名字|id前缀>",
    slash: "/resume <同上>",
    cli: "wemind session resume <ref>",
    brief: "切回旧会话（失败明确报错，不静默新建）",
    match: (t) => {
      const m = t.match(/^(?:恢复会话|回到会话|切换会话|\/resume)\s+([\s\S]+)$/i);
      return m ? { kind: "resume", ref: m[1].trim() } : null;
    },
  },
  {
    id: "session.rename",
    section: "session",
    zh: "重命名会话 <序号|名字> <新名字>",
    slash: "/rename <同上>",
    cli: "wemind session rename <ref> <名字>",
    brief: "给会话起名字（命名后不会被淘汰）",
    match: (t) => {
      const m = t.match(/^(?:重命名会话|会话重命名|会话改名|\/rename)\s+(\S+)\s+([\s\S]+)$/i);
      return m ? { kind: "rename", ref: m[1], name: m[2].trim() } : null;
    },
  },
  {
    id: "session.delete",
    section: "session",
    zh: "删除会话 <序号|名字|id前缀>",
    slash: "/delete <同上>",
    cli: "wemind session delete <ref>",
    brief: "只删登记（agent 侧归档不动）",
    match: (t) => {
      const m = t.match(/^(?:删除会话|删会话|\/delete|\/del)\s+([\s\S]+)$/i);
      return m ? { kind: "delete", ref: m[1].trim() } : null;
    },
  },
  {
    id: "agent.overview",
    section: "brain",
    ownerOnly: true,
    zh: "AI / AI 列表",
    slash: "/ai",
    cli: "wemind brain",
    brief: "看可选 agent 与当前配置",
    match: (t) => (/^(?:ai|ai\s*列表|列出\s*ai|\/ai)$/i.test(t) ? { kind: "ai" } : null),
  },
  {
    id: "agent.brain",
    section: "brain",
    ownerOnly: true,
    zh: "切换大脑 [预设|auto]",
    slash: "/brain [预设|auto]、/ai brain [预设|auto]",
    cli: "wemind brain switch <预设|auto>",
    brief: "热切换对话大脑（失败自动回滚）",
    match: (t) => {
      const m = t.match(/^(?:切换大脑|ai\s*大脑|\/brain|\/ai\s+brain)(?:\s+([\s\S]+))?$/i);
      if (!m) return null;
      const target = m[1]?.trim();
      return target ? { kind: "brain", target } : { kind: "brain" };
    },
  },
  {
    id: "agent.workerBrain",
    section: "brain",
    ownerOnly: true,
    zh: "切换任务大脑 [预设|auto]",
    slash: "/worker [预设|auto]、/ai task [预设|auto]",
    cli: "wemind brain switch <预设> --worker",
    brief: "设默认任务大脑（本次运行内一直生效，不写 brain.json）",
    match: (t) => {
      const m = t.match(
        /^(?:切换任务大脑|任务大脑|ai\s*任务|\/worker|\/ai\s+task)(?:\s+([\s\S]+))?$/i,
      );
      if (!m) return null;
      const target = m[1]?.trim();
      return target ? { kind: "workerBrain", target } : { kind: "workerBrain" };
    },
  },
  {
    id: "brain.handoff",
    section: "brain",
    ownerOnly: true,
    zh: "交接",
    slash: "/handoff",
    cli: "wemind brain handoff",
    brief: "生成当前会话摘要，切换后给新大脑接手",
    match: (t) => (/^(?:交接|会话交接|\/handoff)$/i.test(t) ? { kind: "handoff" } : null),
  },
  {
    id: "misc.help",
    section: "misc",
    zh: "帮助",
    slash: "/help",
    cli: "wemind help",
    brief: "这张表",
    match: (t) => (/^(?:帮助|指令|命令|\/help|\/h)$/i.test(t) ? { kind: "help" } : null),
  },
];

export const TASK_COMMAND_SPECS: CommandSpec<TaskCommand>[] = [
  {
    id: "task.dispatch",
    section: "task",
    zh: "任务 [<预设>：]正文",
    slash: "/task [<预设>] 正文",
    cli: 'wemind task "正文" [--agent <预设>]',
    brief: "派发新任务；带预设名即指定 agent（只影响这一条）",
    match: (t) => {
      // ① `任务：正文` / `task: 正文`（沿用旧写法，无预设）
      let m = t.match(/^(?:任务|task)[:：]\s*([\s\S]+)$/i);
      if (m) return { kind: "toWorker", text: m[1].trim() };
      // ② `任务 <预设>：正文` —— 冒号前必须恰好是已知预设名，否则整串都是正文
      m = t.match(/^(?:任务|task)\s+(\S+?)[:：]\s*([\s\S]+)$/i);
      if (m) {
        if (agentTokenOk(m[1]))
          return { kind: "toWorker", text: m[2].trim(), agentToken: m[1].toLowerCase() };
        return { kind: "toWorker", text: t.replace(/^(?:任务|task)\s+/i, "").trim() };
      }
      // ③ `/task <预设> 正文`（斜杠形式用空格分隔，预设名同样必须命中）
      m = t.match(/^\/task\s+(\S+)\s+([\s\S]+)$/i);
      if (m && agentTokenOk(m[1]))
        return { kind: "toWorker", text: m[2].trim(), agentToken: m[1].toLowerCase() };
      m = t.match(/^\/task\s+([\s\S]+)$/i);
      if (m) return { kind: "toWorker", text: m[1].trim() };
      // ④ `> 正文` 快捷别名（沿用旧写法）
      m = t.match(/^>\s*([\s\S]+)$/);
      if (m) return { kind: "toWorker", text: m[1].trim() };
      return null;
    },
  },
  {
    id: "task.reply",
    section: "task",
    zh: "#<编号> 正文",
    slash: "/reply <编号> 正文",
    cli: 'wemind task-reply <编号> "正文"',
    brief: "给指定编号的任务回话（多任务时必须）",
    match: (t) => {
      const m = t.match(/^(?:[#＃](\d+)|\/reply\s+(\d+))\s+([\s\S]+)$/i);
      if (!m) return null;
      // `#1 号文件在哪` 说的是「1 号文件」，不是给 1 号任务回话 —— 数字后面紧跟「号」时按普通消息处理。
      if (m[1] !== undefined && m[3].startsWith("号")) return null;
      return { kind: "reply", id: Number(m[1] ?? m[2]), text: m[3].trim() };
    },
  },
  {
    id: "task.list",
    section: "task",
    zh: "任务列表",
    slash: "/tasks",
    cli: "wemind task-list",
    brief: "编号 / agent / 状态 / 轮次 / 已运行",
    match: (t) => (/^(?:任务列表|任务清单|列出任务|\/tasks?)$/i.test(t) ? { kind: "tasks" } : null),
  },
  {
    id: "task.stop",
    section: "task",
    zh: "结束任务 [编号]、结束全部任务",
    slash: "/stop [编号|全部]",
    cli: "wemind task-stop [编号|全部]",
    brief: "结束任务（进程回池，可复用）",
    match: (t) => {
      if (/^(?:结束全部任务|停止全部任务|\/stop\s+(?:all|全部))$/i.test(t))
        return { kind: "stop", id: "all" };
      const m = t.match(/^(?:结束任务|停止任务|\/stop)(?:\s*(\d+))?$/i);
      if (!m) return null;
      return m[1] ? { kind: "stop", id: Number(m[1]) } : { kind: "stop" };
    },
  },
];

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
      out.push(s.cli ? `  ${s.cli} — ${s.brief}` : `  （无 CLI）${s.zh} — ${s.brief}`);
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
