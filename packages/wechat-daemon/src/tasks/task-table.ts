/**
 * 任务列表的两种渲染共用这一层：状态 → 图标/中文、时长、按显示宽度截断。
 *
 * 微信侧（`renderTaskList()`）输出 markdown 表格，由客户端排版、可左右滑动；
 * CLI 侧（`renderTaskTable()`）输出**自己算好列宽的纯文本表格**——终端不渲染 markdown，
 * 直接打 `| a | b |` 只会看到一堆管道符，所以这里按显示宽度补齐/截断，画一张终端里能对齐的表。
 */

export type TaskRow = {
  id: number;
  agent: string;
  status: string;
  turns: number;
  startedAt?: number;
  lastOutput?: string;
};

/** 任务列表里的状态图标：手机上一眼能分出「在跑 / 等你 / 停住」。 */
export const STATUS_ICON: Record<string, string> = {
  running: "▶️",
  waiting: "💬",
  interrupted: "⏸️",
};

export const STATUS_LABEL: Record<string, string> = {
  running: "运行中",
  waiting: "等你回复",
  interrupted: "待继续",
};

/** 未知状态原样显示，别把新状态显示成空白。 */
export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

/** 毫秒 → `12s` / `3m` / `2h5m`（小时以上带分钟，方便判断「挂多久了」）。 */
export function since(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

// 组合符、零宽字符、变体选择符不占列（`⏸️` 是 U+23F8 + U+FE0F）。
// 用码点区间而不是正则字符类：组合符写在字符类里会被 lint 当成「误用」并报错。
function isZeroWidth(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f)
  );
}

/** 宽字符：CJK、全角、谚文、emoji。终端里都占 2 列。 */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f000 && cp <= 0x1faff) ||
    (cp >= 0x17000 && cp <= 0x18aff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/**
 * 显示宽度：中日韩与 emoji 算 2 列，其余算 1 列。
 * 终端是等宽的，只有按这个口径补齐，表格才对得齐（`str.length` 会把「待继续」算成 3，直接歪）。
 */
export function displayWidth(text: string): number {
  const chars = [...text];
  let width = 0;
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    const cp = ch.codePointAt(0) ?? 0;
    // `⏸️` = U+23F8 + U+FE0F：带变体选择符的是「emoji 呈现」，终端按 2 列画，基准字符本身是 1 列。
    if (chars[i + 1]?.codePointAt(0) === 0xfe0f) {
      width += 2;
      i += 1;
      continue;
    }
    if (isZeroWidth(cp)) continue;
    width += isWide(cp) ? 2 : 1;
  }
  return width;
}

/** 按显示宽度截断，超出时用 `…` 收尾（不切断代理对）。 */
export function truncateToWidth(text: string, max: number): string {
  if (displayWidth(text) <= max) return text;
  const budget = Math.max(1, max - 1);
  let out = "";
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const w = isZeroWidth(cp) ? 0 : isWide(cp) ? 2 : 1;
    if (width + w > budget) break;
    out += ch;
    width += w;
  }
  return `${out}…`;
}

function pad(text: string, width: number, align: "left" | "right" = "left"): string {
  const fill = " ".repeat(Math.max(0, width - displayWidth(text)));
  return align === "right" ? fill + text : text + fill;
}

/**
 * CLI 的 `task-list`：一张对齐的纯文本表格。
 *
 * 为什么不直接用微信那串 markdown：终端不渲染表格语法，`|` 和 `---` 会原样出现；
 * 这里按显示宽度算好每列，用 `│` 分隔、`─` 画表头线，看起来才是「表」。
 * 状态列只写中文不写图标：`▶️`/`⏸️` 在部分终端里宽度是 1 也可能是 2，一格错整行歪。
 */
export function renderTaskTable(
  rows: TaskRow[],
  opts: { recentWidth?: number; now?: number } = {},
): string {
  if (!rows.length) return "（没有任务）";
  const recentWidth = opts.recentWidth ?? 40;
  const now = opts.now ?? Date.now();
  // 单元格内容不能带换行/制表符，否则整行错位。
  const clean = (x: string): string => x.replace(/\s+/g, " ").trim();
  const body = rows.map((r) => ({
    id: `#${r.id}`,
    status: statusLabel(r.status),
    recent: r.lastOutput ? truncateToWidth(clean(r.lastOutput), recentWidth) : "—",
    agent: clean(r.agent),
    turns: String(r.turns),
    age: r.startedAt ? since(now - r.startedAt) : "—",
  }));
  const head = {
    id: "任务",
    status: "状态",
    recent: "最近输出",
    agent: "Agent",
    turns: "轮次",
    age: "时长",
  };
  const cols = ["id", "status", "recent", "agent", "turns", "age"] as const;
  const widths = Object.fromEntries(
    cols.map((c) => [c, Math.max(displayWidth(head[c]), ...body.map((b) => displayWidth(b[c])))]),
  ) as Record<(typeof cols)[number], number>;
  const line = (row: Record<string, string>): string =>
    ` ${cols.map((c) => pad(row[c]!, widths[c], c === "turns" ? "right" : "left")).join(" │ ")}`;
  const rule = `─${cols.map((c) => "─".repeat(widths[c])).join("─┼─")}`;
  // 表头也走同一行渲染，宽度全列后一定对得齐。
  return [line(head), rule, ...body.map((b) => line(b))].map((l) => l.trimEnd()).join("\n");
}
