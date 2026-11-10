import crypto from "node:crypto";

import { ILINK_APP_ID } from "../config.js";
import { ILinkError } from "./error-codes.js";
import { HttpStatusError } from "./transport-errors.js";
import { parseJsonWithLosslessIds } from "./message-id.js";
import type {
  BaseInfo,
  GetUpdatesResp,
  SendMessageReq,
  SendMessageResp,
  QRCodeResponse,
  QRStatusResponse,
  SendTypingReq,
  GetConfigResp,
  GetUploadUrlReq,
  GetUploadUrlResp,
} from "./types.js";

/** 普通 RPC 的超时（send/typing/config/upload/notify）。 */
const DEFAULT_API_TIMEOUT_MS = 15_000;
/** 消息长轮询（getupdates）超时。 */
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
/** 扫码状态长轮询（get_qrcode_status）超时。与消息长轮询语义不同，故分开命名。 */
const QR_LONG_POLL_TIMEOUT_MS = 35_000;

// 对外声明的 iLink 客户端版本：模仿官方 openclaw-weixin 的版本，避免后端因客户端版本过低而拒绝/快速过期二维码。需随官方更新——故支持 env 覆盖，免改代码。
const ILINK_CLIENT_VERSION = process.env.ILINK_CLIENT_VERSION?.trim() || "2.4.3";
const CHANNEL_VERSION = ILINK_CLIENT_VERSION;

/**
 * iLink-App-ClientVersion: uint32 编码 0x00MMNNPP（major<<16 | minor<<8 | patch）。
 * 编码方式借鉴自官方 Tencent/openclaw-weixin（MIT）。
 */
export function buildClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((p) => parseInt(p, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}
const ILINK_APP_CLIENT_VERSION = String(buildClientVersion(ILINK_CLIENT_VERSION));

/** iLink 公共请求头：所有 GET/POST 都需携带，缺失会导致服务端拒绝连接。 */
function buildCommonHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
  };
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(opts: { token?: string; body: string }): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(opts.body, "utf-8")),
    "X-WECHAT-UIN": randomWechatUin(),
    ...buildCommonHeaders(),
  };
  if (opts.token?.trim()) {
    headers.Authorization = `Bearer ${opts.token.trim()}`;
  }
  return headers;
}

/** POST 一个 iLink CGI，返回原始响应体。HTTP 非 2xx 抛错；响应体是否是 JSON 由调用方决定。 */
async function apiFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
  label: string;
  /** 调用方的取消信号（MCP 客户端断开）：与超时共用同一个 controller。 */
  signal?: AbortSignal;
}): Promise<string> {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const hdrs = buildHeaders({ token: params.token, body: params.body });

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (params.signal?.aborted) controller.abort();
  else params.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: hdrs,
      body: params.body,
      signal: controller.signal,
    });
    // 读完响应体后才算这次请求结束：只清定时器会漏掉「头已到、体卡住」的慢响应，长轮询尤甚——所以清理放在 finally，成功/失败/超时都只写一次。
    const rawText = await res.text();
    if (!res.ok) {
      throw new HttpStatusError(params.label, res.status, rawText);
    }
    return rawText;
  } finally {
    clearTimeout(timer);
    params.signal?.removeEventListener("abort", onAbort);
  }
}

/** 防御性解析 API JSON 响应：parseJsonWithLosslessIds 自己抛带 label 与响应片段的清晰错误（畸形/代理 HTML/截断响应不致以晦涩错误打断调用方），这里不再重复包一层。 */
function parseJsonResp<T>(raw: string, label: string): T {
  return parseJsonWithLosslessIds<T>(raw, label);
}

/** sendMessage 的成功响应可能为空/非 JSON（历史上 iLink 如此）；只有明确错误码才失败。 */
function tryParseJsonResp<T>(raw: string, label: string): T | null {
  if (!raw) return null;
  try {
    return parseJsonWithLosslessIds<T>(raw, label);
  } catch {
    return null;
  }
}

/**
 * iLink 即使 HTTP 200 也可能在响应体返回非 0 ret/errcode 表示失败。语义见 error-codes.ts：
 *   ret=-2 参数错误（最常见 context_token 失效/不匹配）；errcode=-14 会话过期。
 * 不校验会导致「假成功」——消息其实没送达。仅在明确拿到非 0 错误码时抛 ILinkError（携带码+分类，供上层按类型处理）。
 */
function throwIfErrorCode(
  op: string,
  resp: { ret?: number; errcode?: number; errmsg?: string } | null,
): void {
  if (!resp) return;
  // 两个字段分别判断：`ret ?? errcode` 在 ret=0、errcode=-14 时会取到 0，把会话过期掩盖成成功。
  if (resp.ret !== undefined && resp.ret !== 0) throw new ILinkError(op, resp.ret, resp.errmsg);
  if (resp.errcode !== undefined && resp.errcode !== 0)
    throw new ILinkError(op, resp.errcode, resp.errmsg);
}

export function buildBaseInfo(): BaseInfo {
  return { channel_version: CHANNEL_VERSION };
}

export async function getUpdates(params: {
  baseUrl: string;
  token?: string;
  updatesBuf?: string;
  timeoutMs?: number;
  /** MCP 客户端取消/断开时中止在途长轮询（否则要等满 25s 才回到循环顶部检查）。 */
  signal?: AbortSignal;
}): Promise<GetUpdatesResp> {
  const timeout = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  try {
    const rawText = await apiFetch({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: params.updatesBuf ?? "",
        base_info: buildBaseInfo(),
      }),
      token: params.token,
      timeoutMs: timeout,
      label: "getUpdates",
      signal: params.signal,
    });
    const resp = parseJsonResp<GetUpdatesResp>(rawText, "getUpdates");
    // ret 非 0 且没有 errcode 时，调用方（daemon/MCP）只看 errcode 会把它当成「这轮没有新消息」而静默空转。
    // errcode 留给调用方处理（-14 要触发冷却，不能在这里抛成普通失败）。
    if (resp.ret !== undefined && resp.ret !== 0 && !resp.errcode) {
      throw new ILinkError("getUpdates", resp.ret, resp.errmsg);
    }
    return resp;
  } catch (err) {
    // 调用方主动取消 ≠ 长轮询超时：不能伪装成「空结果」，否则 MCP 会继续空转。
    if (params.signal?.aborted) throw err;
    // 长轮询超时是常态：返回空结果（保留游标），让调用方直接进入下一轮。
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: params.updatesBuf };
    }
    throw err;
  }
}

export async function sendMessage(params: {
  baseUrl: string;
  token?: string;
  body: SendMessageReq;
  timeoutMs?: number;
}): Promise<SendMessageResp> {
  const raw = await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: "sendMessage",
  });
  // 空/非 JSON 响应视为成功（历史上 iLink 成功时可能无响应体）；只有明确拿到非 0 错误码才抛。
  const resp = tryParseJsonResp<SendMessageResp>(raw, "sendMessage");
  throwIfErrorCode("sendMessage", resp);
  return resp ?? {};
}

/** 取 CDN 上传地址（发图/发文件用）。返回 upload_full_url 或 upload_param。 */
export async function getUploadUrl(
  params: { baseUrl: string; token?: string; timeoutMs?: number } & GetUploadUrlReq,
): Promise<GetUploadUrlResp> {
  const raw = await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body: JSON.stringify({
      filekey: params.filekey,
      media_type: params.media_type,
      to_user_id: params.to_user_id,
      rawsize: params.rawsize,
      rawfilemd5: params.rawfilemd5,
      filesize: params.filesize,
      no_need_thumb: params.no_need_thumb,
      aeskey: params.aeskey,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: "getUploadUrl",
  });
  const resp = parseJsonResp<GetUploadUrlResp>(raw, "getUploadUrl");
  throwIfErrorCode("getUploadUrl", resp);
  return resp;
}

export async function fetchQRCode(apiBaseUrl: string): Promise<QRCodeResponse> {
  // 对齐官方：get_bot_qrcode 为 POST，body 带 local_token_list，并走全套请求头。
  const rawText = await apiFetch({
    baseUrl: apiBaseUrl,
    endpoint: "ilink/bot/get_bot_qrcode?bot_type=3",
    body: JSON.stringify({ local_token_list: [] }),
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    label: "fetchQRCode",
  });
  return parseJsonResp<QRCodeResponse>(rawText, "fetchQRCode");
}

export async function pollQRStatus(apiBaseUrl: string, qrcode: string): Promise<QRStatusResponse> {
  const base = ensureTrailingSlash(apiBaseUrl);
  const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), {
      headers: buildCommonHeaders(),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `pollQRStatus ${response.status} ${response.statusText} ${text.slice(0, 500)}`,
      );
    }
    return parseJsonResp<QRStatusResponse>(text, "pollQRStatus");
  } catch (err) {
    // 服务端会把长轮询 hold 到超时：AbortError 表示「这段时间没人扫码」，不是失败。
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "wait" };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function generateId(prefix: string): string {
  return `${prefix}:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

export async function getConfig(params: {
  baseUrl: string;
  token?: string;
  ilinkUserId: string;
  contextToken?: string;
}): Promise<GetConfigResp> {
  const rawText = await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getconfig",
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      context_token: params.contextToken,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    label: "getConfig",
  });
  const resp = parseJsonResp<GetConfigResp>(rawText, "getConfig");
  throwIfErrorCode("getConfig", resp);
  return resp;
}

export async function sendTyping(params: {
  baseUrl: string;
  token?: string;
  body: SendTypingReq;
}): Promise<void> {
  const raw = await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendtyping",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    label: "sendTyping",
  });
  // 与 sendMessage 同理：HTTP 200 也可能带非 0 ret，不校验会让「打字中」显示成假成功。
  throwIfErrorCode("sendTyping", tryParseJsonResp(raw, "sendTyping"));
}

/**
 * 上线/下线通知的共同实现。
 * best-effort：失败只记日志、绝不抛出——通知失败不应阻断登录/登出主流程。
 * 也正因为要吞错，这里刻意**不校验**响应体的 ret/errcode。
 */
async function notifyLifecycle(
  op: "notifyStart" | "notifyStop",
  endpoint: string,
  params: { baseUrl: string; token?: string },
): Promise<void> {
  try {
    await apiFetch({
      baseUrl: params.baseUrl,
      endpoint,
      body: JSON.stringify({ base_info: buildBaseInfo() }),
      token: params.token,
      timeoutMs: DEFAULT_API_TIMEOUT_MS,
      label: op,
    });
  } catch (err) {
    console.error(
      `[wemind/wechat-ilink-core/ilink] ${op} failed (ignored, best-effort): ${String(err)}`,
    );
  }
}

/** 通知服务端该 bot 客户端上线（best-effort，失败不阻断）。 */
export async function notifyStart(params: { baseUrl: string; token?: string }): Promise<void> {
  await notifyLifecycle("notifyStart", "ilink/bot/msg/notifystart", params);
}

/** 通知服务端该 bot 客户端下线（best-effort，失败不阻断）。 */
export async function notifyStop(params: { baseUrl: string; token?: string }): Promise<void> {
  await notifyLifecycle("notifyStop", "ilink/bot/msg/notifystop", params);
}
