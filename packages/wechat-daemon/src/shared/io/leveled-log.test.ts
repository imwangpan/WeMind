import { describe, expect, it, vi } from "vitest";
import type { Logger } from "@wemind/wechat-ilink-core";
import { bindLogger } from "./leveled-log.js";

describe("bindLogger（回调式日志保留级别）", () => {
  it("按第一参数路由到 logger 的 info/warn/error", () => {
    const logger: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: () => logger,
    };
    const log = bindLogger(logger);
    log("info", "a", 1);
    log("warn", "b");
    log("error", "c");
    expect(logger.info).toHaveBeenCalledWith("a", 1);
    expect(logger.warn).toHaveBeenCalledWith("b");
    expect(logger.error).toHaveBeenCalledWith("c");
  });
});
