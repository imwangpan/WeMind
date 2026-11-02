import { describe, it, expect } from "vitest";

import { cliHook } from "./cli-dispatch.js";

describe("cliHook（cli.js 入口分派）", () => {
  it("daemon / _watchdog 是内部入口，其余都交给 manage", () => {
    expect(cliHook(["daemon"])).toBe("daemon");
    expect(cliHook(["_watchdog"])).toBe("watchdog");
    expect(cliHook([])).toBe("manage");
    expect(cliHook(["version"])).toBe("manage");
    expect(cliHook(["brain", "check"])).toBe("manage");
    // 只认第一个参数：`wemind help daemon` 是帮助，不是起 daemon
    expect(cliHook(["help", "daemon"])).toBe("manage");
  });
});
