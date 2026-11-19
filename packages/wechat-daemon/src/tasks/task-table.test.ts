import { describe, expect, it } from "vitest";

import {
  STATUS_LABEL,
  displayWidth,
  renderTaskTable,
  since,
  statusLabel,
  truncateToWidth,
} from "./task-table.js";

describe("displayWidth（终端列宽）", () => {
  it("中文按 2 列算，ASCII 按 1 列算", () => {
    expect(displayWidth("待继续")).toBe(6);
    expect(displayWidth("kiro")).toBe(4);
    expect(displayWidth("#17")).toBe(3);
  });

  it("emoji 按 2 列算，变体选择符不占列", () => {
    // ⏸️ = U+23F8 + U+FE0F；后者是变体选择符，不能再算一列。
    expect(displayWidth("⏸️")).toBe(2);
    expect(displayWidth("🤖【任务】")).toBe(10); // 🤖=2、【=2、任务=4、】=2
  });
});

describe("truncateToWidth（按显示宽度截断）", () => {
  it("够长就原样返回，超了才加省略号", () => {
    expect(truncateToWidth("abcdef", 6)).toBe("abcdef");
    expect(truncateToWidth("abcdefg", 6)).toBe("abcde…");
  });

  it("中文不切半个字", () => {
    expect(truncateToWidth("一二三四", 8)).toBe("一二三四");
    expect(truncateToWidth("一二三四五", 8)).toBe("一二三…");
  });
});

describe("since / statusLabel", () => {
  it("时长分档", () => {
    expect(since(5_000)).toBe("5s");
    expect(since(3 * 60_000)).toBe("3m");
    expect(since(2 * 3_600_000 + 5 * 60_000)).toBe("2h5m");
  });

  it("未知状态原样显示，不显示空白", () => {
    expect(statusLabel("running")).toBe(STATUS_LABEL.running);
    expect(statusLabel("cancelled")).toBe("cancelled");
  });
});

/** 每行分隔符所在列位（显示宽度），用来断言表格真的对齐。 */
function separators(line: string): number[] {
  const out: number[] = [];
  let acc = 0;
  for (const part of line.split(/[│┼]/).slice(0, -1)) {
    acc += displayWidth(part) + 1;
    out.push(acc);
  }
  return out;
}

describe("renderTaskTable（CLI 的对齐表格）", () => {
  const rows = [
    {
      id: 17,
      agent: "opencode",
      status: "interrupted",
      turns: 3,
      startedAt: 1_000,
      lastOutput: "🤖【任务】明白了，视频和文件是这样发",
    },
    { id: 20, agent: "cline", status: "running", turns: 1 },
  ];
  const now = 1_000 + 2 * 3_600_000;

  it("每一行的分隔符都在同一列（终端里才对得齐）", () => {
    const lines = renderTaskTable(rows, { now }).split("\n");
    const expected = separators(lines[0]!);
    expect(expected.length).toBe(5);
    for (const line of lines.slice(1)) expect(separators(line)).toEqual(expected);
  });

  it("表头是中文列名，数据行带编号与状态", () => {
    const out = renderTaskTable(rows, { now });
    expect(out).toContain("任务");
    expect(out).toContain("最近输出");
    expect(out).toContain("#17");
    expect(out).toContain("待继续");
    expect(out).toContain("2h0m");
  });

  it("没有任务时给一句明确的话，不是空表格", () => {
    expect(renderTaskTable([])).toBe("（没有任务）");
  });

  it("最近输出太长按宽度截断，不破坏表格", () => {
    const long = renderTaskTable(
      [{ id: 1, agent: "pi", status: "waiting", turns: 1, lastOutput: "很长".repeat(60) }],
      { recentWidth: 12, now },
    );
    const lines = long.split("\n");
    const expected = separators(lines[0]!);
    for (const line of lines.slice(1)) expect(separators(line)).toEqual(expected);
    expect(lines[2]).toContain("…");
  });
});
