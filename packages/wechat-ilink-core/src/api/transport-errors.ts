/**
 * 传输层错误分类：把 fetch/网络层抛出的错误归类，判定是否可重试。
 * 与 error-codes.ts（iLink 业务 ret/errcode）正交——这里只管「网络传输」层面的失败。
 * 借鉴 wxclawbot-cli（MIT）client.ts 的 classifyTransportError 思路。
 */

export type TransportErrorKind =
  | "timeout"
  | "dns"
  | "tls"
  | "connection"
  | "network"
  | "http"
  | "unknown";

/** HTTP 非 2xx：带上状态码，供调用方区分「限流/服务端故障可重试」与「4xx 请求问题」。 */
export class HttpStatusError extends Error {
  readonly status: number;
  constructor(label: string, status: number, body: string) {
    super(`${label} ${status}: ${body.slice(0, 500)}`);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

export interface TransportErrorInfo {
  kind: TransportErrorKind;
  /** 是否值得重试（瞬时网络问题可重试；TLS/未知不重试）。 */
  retryable: boolean;
  message: string;
  code?: string;
}

/** 归类一个传输层错误。timeout（AbortError）一律可重试。 */
export function classifyTransportError(err: unknown): TransportErrorInfo {
  if (err instanceof Error && err.name === "AbortError") {
    return { kind: "timeout", retryable: true, message: err.message || "request timeout" };
  }
  if (err instanceof HttpStatusError) {
    // 429（限流）与 5xx（服务端故障/网关）值得退避重试；其它 4xx 是请求本身的问题，重试不会好。
    return {
      kind: "http",
      retryable: err.status === 429 || err.status >= 500,
      message: err.message,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  const code =
    err &&
    typeof err === "object" &&
    "code" in err &&
    typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : undefined;
  const cause = err instanceof Error && err.cause != null ? String(err.cause) : undefined;
  const s = `${message} ${code ?? ""} ${cause ?? ""}`.toLowerCase();

  if (s.includes("enotfound") || s.includes("dns"))
    return { kind: "dns", retryable: true, message, code };
  if (s.includes("econnreset") || s.includes("socket hang up"))
    return { kind: "connection", retryable: true, message, code };
  // TLS/证书错误判定必须排在 "fetch failed" 兜底之前：Node fetch 的网络失败顶层恒为 "TypeError: fetch failed"，真正的 cert/tls 原因在 err.cause 里（已并入 s）。若放在 network 分支之后，会被 "fetch failed" 先匹配成可重试 → 此分支成死代码。
  if (s.includes("cert") || s.includes("tls") || s.includes("ssl"))
    return { kind: "tls", retryable: false, message, code };
  if (
    s.includes("econnrefused") ||
    s.includes("ehostunreach") ||
    s.includes("enetunreach") ||
    s.includes("etimedout") ||
    s.includes("network") ||
    s.includes("fetch failed")
  ) {
    return { kind: "network", retryable: true, message, code };
  }
  return { kind: "unknown", retryable: false, message, code };
}
