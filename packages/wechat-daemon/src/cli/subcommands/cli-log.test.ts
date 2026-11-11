import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ERROR_MARKERS,
  isErrorLine,
  parseLogArgs,
  readLogTail,
  type LogOptions,
} from "./cli-log.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeDir(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-log-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

const opts = (over: Partial<LogOptions> = {}): LogOptions => ({
  lines: 50,
  errorsOnly: false,
  ...over,
});

describe("parseLogArgs", () => {
  it("默认 50 行、全量日志、不指定账号", () => {
    expect(parseLogArgs([])).toEqual({ lines: 50, errorsOnly: false });
  });

  it("账号 + --lines / -n + --errors + --file 可以组合", () => {
    expect(parseLogArgs(["wp", "--lines", "10", "--errors", "--file", "2"])).toEqual({
      sel: "wp",
      lines: 10,
      errorsOnly: true,
      file: "2",
    });
    expect(parseLogArgs(["-n", "3"]).lines).toBe(3);
  });

  it("非法参数一律报错，不静默用默认值", () => {
    for (const args of [
      ["--lines", "0"],
      ["--lines", "abc"],
      ["--lines", "2001"],
      ["--lines"],
      ["--file", "x"],
      ["--file"],
      ["--wat"],
      ["a", "b"],
    ]) {
      expect(() => parseLogArgs(args)).toThrow();
    }
  });
});

const lines = [
  "[wemind/wechat-daemon] up. v1.7.0 bot=y",
  "[wemind/wechat-daemon] turn start to=u",
  "[wemind/wechat-daemon/acp] spawn opencode",
  "[wemind/wechat-daemon] prompt ok 1200ms",
  "[wemind/wechat-daemon] poller error: Error: boom",
  "[wemind/wechat-daemon] replied to=u",
  "[wemind/wechat-daemon] prompt FAIL -> rebuild",
];

describe("isErrorLine / ERROR_MARKERS（修漏检与误伤）", () => {
  it("兼容清单锁住旧日志特有的错误文案（新日志不靠它）", () => {
    for (const marker of ["退避", "限流", "过期", "挂起", "接不上", "不可用", "error"]) {
      expect(ERROR_MARKERS).toContain(marker);
    }
  });

  it("新格式按级别标记精确识别，INFO/DEBUG 不算错误", () => {
    expect(isErrorLine("[wemind/wechat-daemon][ERROR] poller error: boom")).toBe(true);
    expect(isErrorLine("[wemind/wechat-daemon][WARN] send -2 → 退避 1.5s 后重试")).toBe(true);
    expect(isErrorLine("[wemind/wechat-daemon][INFO] up. v1.7.0 bot=y")).toBe(false);
    expect(isErrorLine("[wemind/wechat-daemon/acp][INFO] prompt ok 703ms chunks=1")).toBe(false);
    expect(isErrorLine("[wemind/wechat-daemon][DEBUG] raw frame")).toBe(false);
    // 新格式的 INFO 行里即使出现 error 字样也不算错误（正文误伤从根上没了）。
    expect(isErrorLine("[wemind/wechat-daemon][INFO] 用户消息里有 error 字样")).toBe(false);
  });

  it("旧日志（无级别标记）仍能按关键词命中", () => {
    for (const line of [
      "[wemind/wechat-daemon] send -2(限流或token失效) → 退避 1.5s 后重试",
      "[wemind/wechat-daemon] 会话过期(-14) on send → 该账号暂停 1h，待重新登录",
      "[wemind/wechat-daemon] send -2（旧 token）→ 挂起，累计 1 条",
      "[wemind/wechat-daemon] task 1 没起得来：无法连接",
      "[wemind/wechat-daemon] prompt FAIL -> rebuild",
    ]) {
      expect(isErrorLine(line)).toBe(true);
    }
  });

  it("只认带 `[wemind/...]` 前缀的日志行：用户消息正文里出现 error 不算错误", () => {
    expect(isErrorLine("用户消息正文里有 error 字样")).toBe(false);
    expect(isErrorLine("    at pollerLoop (src/index.ts:900)")).toBe(false);
    expect(isErrorLine("[wemind/wechat-daemon] prompt ok 1200ms")).toBe(false);
  });
});

describe("readLogTail", () => {
  it("默认输出全量尾部（不是只挑错误）", () => {
    const dir = makeDir({ "daemon.log": lines.join("\n") + "\n" });
    const v = readLogTail(dir, opts());
    expect(v.total).toBe(7);
    expect(v.hits).toBe(0);
    expect(v.shown).toEqual(lines);
    expect(v.path).toBe(path.join(dir, "daemon.log"));
  });

  it("--lines 只取尾部 N 行", () => {
    const dir = makeDir({ "daemon.log": lines.join("\n") });
    expect(readLogTail(dir, opts({ lines: 2 })).shown).toEqual(lines.slice(-2));
  });

  it("--errors 全文找命中、取最后 N 条，并带前后各 2 行上下文（去重、按原顺序）", () => {
    const dir = makeDir({ "daemon.log": lines.join("\n") });
    const v = readLogTail(dir, opts({ errorsOnly: true }));
    expect(v.hits).toBe(2);
    // 命中索引 4 与 6：各自 ±2 行合并后是索引 2..6。
    expect(v.shown).toEqual(lines.slice(2, 7));
    const one = readLogTail(dir, opts({ errorsOnly: true, lines: 1 }));
    expect(one.hits).toBe(2);
    expect(one.shown).toEqual(lines.slice(4, 7));
  });

  it("末段没有错误也不返回空；正文里的 error 不增加命中数", () => {
    const withBody = [
      ...lines,
      "用户消息正文里有 error 字样",
      "[wemind/wechat-daemon] replied to=u",
    ];
    const dir = makeDir({ "daemon.log": withBody.join("\n") });
    const v = readLogTail(dir, opts({ errorsOnly: true }));
    expect(v.hits).toBe(2);
    expect(v.shown.length).toBeGreaterThan(2);
  });

  it("--file 读轮转文件，并列出其它轮转文件", () => {
    const dir = makeDir({
      "daemon.log": lines.join("\n"),
      "daemon.log.1": "OLD ERROR LINE\n",
      "daemon.log.2": "OLDER\n",
    });
    const v = readLogTail(dir, opts({ file: "1" }));
    expect(v.shown).toEqual(["OLD ERROR LINE"]);
    expect(v.rotated).toContain(path.join(dir, "daemon.log.2"));
    // 正在看的文件不再出现在「更早的轮转日志」里。
    expect(v.rotated).not.toContain(path.join(dir, "daemon.log.1"));
  });

  it("文件不存在 / 空文件：不抛错，返回空并仍列出轮转文件", () => {
    const dir = makeDir({ "daemon.log.1": "OLD\n" });
    const v = readLogTail(dir, opts());
    expect(v.total).toBe(0);
    expect(v.shown).toEqual([]);
    expect(v.rotated).toHaveLength(1);
    expect(readLogTail(makeDir({ "daemon.log": "" }), opts()).shown).toEqual([]);
  });

  it("CRLF 与末尾换行都归一，不产生多余的空行", () => {
    const dir = makeDir({ "daemon.log": "a\r\nb\r\n" });
    expect(readLogTail(dir, opts()).shown).toEqual(["a", "b"]);
  });
});
