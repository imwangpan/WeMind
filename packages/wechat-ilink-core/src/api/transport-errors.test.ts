import { describe, it, expect } from "vitest";

import { classifyTransportError } from "./transport-errors.js";

describe("classifyTransportError", () => {
  it("AbortError → timeout, 可重试", () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    const r = classifyTransportError(e);
    expect(r.kind).toBe("timeout");
    expect(r.retryable).toBe(true);
  });

  it("ENOTFOUND → dns, 可重试", () => {
    const e = Object.assign(new Error("getaddrinfo ENOTFOUND host"), { code: "ENOTFOUND" });
    const r = classifyTransportError(e);
    expect(r.kind).toBe("dns");
    expect(r.retryable).toBe(true);
    expect(r.code).toBe("ENOTFOUND");
  });

  it("ECONNRESET / socket hang up → connection, 可重试", () => {
    const e = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const r = classifyTransportError(e);
    expect(r.kind).toBe("connection");
    expect(r.retryable).toBe(true);
  });

  // 关键回归点：Node fetch 的网络失败顶层恒为 "fetch failed"，真正的 TLS 原因在 err.cause。
  // 若 TLS 判定被移到 "fetch failed" 兜底之后，下面这个用例会失败（被误判成 network/可重试）。
  it("TLS 证书错误（原因在 cause）→ tls, 不可重试，且不被 fetch failed 兜底", () => {
    const e = new Error("fetch failed", {
      cause: new Error("unable to verify the first certificate"),
    });
    const r = classifyTransportError(e);
    expect(r.kind).toBe("tls");
    expect(r.retryable).toBe(false);
  });

  it("纯 fetch failed（无 TLS 原因）→ network, 可重试", () => {
    const r = classifyTransportError(new Error("fetch failed"));
    expect(r.kind).toBe("network");
    expect(r.retryable).toBe(true);
  });

  it("ECONNREFUSED → network, 可重试", () => {
    const e = Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:443"), {
      code: "ECONNREFUSED",
    });
    const r = classifyTransportError(e);
    expect(r.kind).toBe("network");
    expect(r.retryable).toBe(true);
  });

  it("未知错误 → unknown, 不可重试", () => {
    const r = classifyTransportError(new Error("something totally unexpected"));
    expect(r.kind).toBe("unknown");
    expect(r.retryable).toBe(false);
  });

  it("非 Error 输入（字符串）也能归类", () => {
    const r = classifyTransportError("plain string failure");
    expect(r.kind).toBe("unknown");
    expect(r.message).toBe("plain string failure");
  });
});
