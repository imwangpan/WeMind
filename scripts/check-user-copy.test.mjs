/**
 * `scripts/check-user-copy.mjs` 的用例。
 *
 * 重点不是「词表有多全」，而是**判得准**：该拦的拦、注释与日志不误报、`copy-ok:` 能豁免。
 * 一个动不动误报的守卫最后一定会被人加一堆豁免注释绕过，等于没守卫。
 */
import { describe, expect, it } from "vitest";

import { BANNED, findViolations } from "./check-user-copy.mjs";

describe("findViolations", () => {
  it("拦住直译腔：返回行号、禁用词与改法", () => {
    const src = ['const a = "把停在半路的任务全部拉起";'].join("\n");
    const hits = findViolations(src, "x.ts");
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
    expect(hits[0].word).toBe("停在半路");
    expect(hits[0].hint).toContain("待继续");
  });

  it("注释与日志不算文案：不误报", () => {
    const src = [
      "// 这里只是兜底：把任务拉起",
      " * 落盘与幂等",
      "log.info(`拉起 ${n} 个任务`);",
      "console.warn(`兜底：${x}`);",
    ].join("\n");
    expect(findViolations(src, "x.ts")).toEqual([]);
  });

  it("行尾注释里的词也不算", () => {
    const src = "const n = 3; // 兜底用，任务拉起后再看";
    expect(findViolations(src, "x.ts")).toEqual([]);
  });

  it("没有字符串字面量时不算（标识符/类型名）", () => {
    const src = "const 拉起 = 1;";
    expect(findViolations(src, "x.ts")).toEqual([]);
  });

  it("`copy-ok:` 可豁免，理由写在行尾", () => {
    const src = 'const a = "把任务拉起"; // copy-ok: 引用用户原话';
    expect(findViolations(src, "x.ts")).toEqual([]);
  });

  it("每个禁用词都带改法：别只拦不说怎么改", () => {
    expect(BANNED.length).toBeGreaterThan(0);
    for (const b of BANNED) expect(b.hint.trim().length).toBeGreaterThan(0);
  });
});
