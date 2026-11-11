import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, print } from "./logging.js";

const savedLevel = process.env.WEMIND_LOG_LEVEL;

afterEach(() => {
  vi.restoreAllMocks();
  if (savedLevel === undefined) delete process.env.WEMIND_LOG_LEVEL;
  else process.env.WEMIND_LOG_LEVEL = savedLevel;
});

describe("createLogger（stderr + 级别标记）", () => {
  it("级别写进文本：INFO/ERROR 走 console.error，WARN 走 console.warn（都是 stderr，不碰 stdout）", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger("wechat-daemon");
    log.info("up. v1.7.0");
    log.warn("退避 1.5s");
    log.error("poller error:", "boom");
    expect(out).not.toHaveBeenCalled();
    expect(err.mock.calls.map((c) => c.join(" "))).toEqual([
      "[wemind/wechat-daemon][INFO] up. v1.7.0",
      "[wemind/wechat-daemon][ERROR] poller error: boom",
    ]);
    expect(warn).toHaveBeenCalledWith("[wemind/wechat-daemon][WARN]", "退避 1.5s");
  });

  it("child 追加子系统，不改父 logger", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const parent = createLogger("wechat-daemon");
    parent.child("acp").info("spawn opencode");
    parent.info("turn start");
    expect(err.mock.calls.map((c) => c[0])).toEqual([
      "[wemind/wechat-daemon/acp][INFO]",
      "[wemind/wechat-daemon][INFO]",
    ]);
  });

  it("DEBUG 预留：默认静默，WEMIND_LOG_LEVEL=debug 才输出", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = createLogger("wechat-daemon");
    delete process.env.WEMIND_LOG_LEVEL;
    log.debug("raw frame payload");
    expect(err).not.toHaveBeenCalled();
    process.env.WEMIND_LOG_LEVEL = "debug";
    log.debug("raw frame payload");
    expect(err).toHaveBeenCalledWith("[wemind/wechat-daemon][DEBUG]", "raw frame payload");
  });

  it("级别大小写不敏感，其它值不打开 DEBUG", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.WEMIND_LOG_LEVEL = "INFO";
    createLogger("x").debug("no");
    expect(err).not.toHaveBeenCalled();
  });
});

describe("print（stdout 纯文本）", () => {
  it("原样转发给 console.log，不加前缀不加级别", () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    print("wemind 1.7.0 (@wemind/cli, node 24)", 42);
    expect(out).toHaveBeenCalledWith("wemind 1.7.0 (@wemind/cli, node 24)", 42);
    expect(err).not.toHaveBeenCalled();
  });
});
