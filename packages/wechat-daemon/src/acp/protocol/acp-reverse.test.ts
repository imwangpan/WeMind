import { describe, it, expect, afterEach, vi } from "vitest";

import { handleReverseRequest } from "./acp-reverse.js";

function capture() {
  const written: Array<Record<string, any>> = [];
  const logs: string[] = [];
  return {
    written,
    logs,
    write: (payload: Record<string, any>) => written.push(payload),
    log: (message: string) => logs.push(message),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("handleReverseRequest（brain / worker / brain check 共用）", () => {
  it("权限请求默认拒绝（安全默认）", () => {
    const c = capture();
    handleReverseRequest(
      {
        id: 7,
        method: "session/request_permission",
        params: { options: [{ kind: "allow_once", optionId: "ok" }] },
      },
      c.write,
      c.log,
    );

    expect(c.written).toEqual([
      { jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "cancelled" } } },
    ]);
    expect(c.logs).toContain("permission rejected");
  });

  it("WEMIND_ACP_AUTO_ALLOW=1 时只选 agent 明确提供的 allow 选项", () => {
    vi.stubEnv("WEMIND_ACP_AUTO_ALLOW", "1");
    const c = capture();
    handleReverseRequest(
      {
        id: 8,
        method: "session/request_permission",
        params: {
          options: [
            { kind: "reject_once", optionId: "no" },
            { kind: "allow_always", optionId: "yes" },
          ],
        },
      },
      c.write,
      c.log,
    );

    expect(c.written[0].result).toEqual({
      outcome: { outcome: "selected", optionId: "yes" },
    });
    expect(c.logs).toContain("permission allowed");
  });

  it("自动放行开启但选项里没有 allow 时仍然拒绝", () => {
    vi.stubEnv("WEMIND_ACP_AUTO_ALLOW", "1");
    const c = capture();
    handleReverseRequest(
      {
        id: 9,
        method: "session/request_permission",
        params: { options: [{ kind: "reject_once", optionId: "no" }] },
      },
      c.write,
    );

    expect(c.written[0].result).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("未知反向请求回 -32601，不静默挂起", () => {
    const c = capture();
    handleReverseRequest({ id: 10, method: "fs/read_text_file", params: {} }, c.write, c.log);

    expect(c.written).toEqual([
      {
        jsonrpc: "2.0",
        id: 10,
        error: { code: -32601, message: "method not supported" },
      },
    ]);
    expect(c.logs[0]).toContain("fs/read_text_file");
  });
});
