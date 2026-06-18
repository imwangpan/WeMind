/**
 * iLink Bot API 错误码定义与分类。
 *
 * 权威来源：逆向自官方 Tencent/openclaw-weixin 的「iLink Bot API 协议参考」
 * （corespeed-io/wechatbot `docs/protocol.md` 的 Error Codes 表，社区逆向、目前最权威的公开文档）。
 *
 * 两个字段，语义不同：
 *  - `ret`    ：发送/上传等 RPC 的返回码（sendmessage / getuploadurl 等响应体）。
 *  - `errcode`：长轮询/会话类接口的错误码（getupdates 等）。
 *
 * 已知错误码（截至文档）：
 *  | 码            | 字段     | 含义                         | 处理                                   |
 *  |---------------|----------|------------------------------|----------------------------------------|
 *  | 0             | ret      | 成功                          | —                                      |
 *  | -2            | ret      | 参数错误 (Parameter error)    | 检查请求参数                            |
 *  | -14           | errcode  | 会话过期 (Session expired)    | 重新登录（本项目对该账号冷却 1 小时）   |
 *
 * ⚠️ 重要澄清（避免重蹈覆辙）：
 *  - `ret = -2` 官方定义是**参数错误**，**不是**"context_token 按时间过期"。
 *    常见诱因：context_token 失效/与当前会话不匹配、必填字段缺失/格式不对。
 *  - context_token 官方说明：按 `(accountId, userId)` **缓存、持久化、重用**，
 *    **仅在会话过期(-14)/重新登录时清除**——**没有**文档化的时间 TTL。
 *  - 真正"按时间/会话过期"的是 `errcode = -14`（会话级），与 -2 无关。
 */

/** 发送/上传 RPC 的 `ret` 码。 */
export const ILINK_RET = {
  OK: 0,
  /** 参数错误：检查请求（最常见为 context_token 失效/不匹配；也可能被复用为发送限流——短时连续发送过多，见 README「连续发送上限」）。 */
  PARAM_ERROR: -2,
} as const;

/** 长轮询/会话类接口的 `errcode` 码。 */
export const ILINK_ERRCODE = {
  /** 会话过期，需重新登录。 */
  SESSION_EXPIRED: -14,
} as const;

export type ILinkErrorKind = "ok" | "param_error" | "session_expired" | "unknown";

/** 把一个 ret/errcode 数值分类。 */
export function classifyILinkCode(code: number | undefined | null): ILinkErrorKind {
  if (code === undefined || code === null || code === 0) return "ok";
  if (code === ILINK_ERRCODE.SESSION_EXPIRED) return "session_expired";
  if (code === ILINK_RET.PARAM_ERROR) return "param_error";
  return "unknown";
}

/** 返回可读标签 + 处理建议，用于日志与提示。 */
export function describeILinkCode(code: number | undefined | null): { kind: ILinkErrorKind; label: string; hint: string } {
  switch (classifyILinkCode(code)) {
    case "ok": return { kind: "ok", label: `ok(${code ?? 0})`, hint: "" };
    case "session_expired": return { kind: "session_expired", label: "会话过期(-14)", hint: "需重新登录" };
    case "param_error": return { kind: "param_error", label: "参数错误(-2)", hint: "检查请求参数（最常见：context_token 失效/不匹配；或发送限流——短时连续发送过多）" };
    default: return { kind: "unknown", label: `未知错误码(${code})`, hint: "对照 iLink 协议文档排查" };
  }
}

/** iLink 接口返回非 0 ret/errcode 时抛出的结构化错误，携带原始码与分类，便于上层按类型处理。 */
export class ILinkError extends Error {
  readonly code: number;
  readonly kind: ILinkErrorKind;
  constructor(op: string, code: number, errmsg?: string) {
    const { kind, label, hint } = describeILinkCode(code);
    super(`${op} failed: ${label}${hint ? ` — ${hint}` : ""}${errmsg ? ` (${errmsg})` : ""}`);
    this.name = "ILinkError";
    this.code = code;
    this.kind = kind;
  }
}
