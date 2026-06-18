import crypto from "node:crypto";

import { ILINK_APP_ID } from "../config.js";
import { ILinkError } from "./error-codes.js";
import type { GetUpdatesResp, SendMessageReq, QRCodeResponse, QRStatusResponse, SendTypingReq, GetConfigResp, GetUploadUrlReq, GetUploadUrlResp } from "./types.js";

export type ApiOptions = {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
};

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const QR_LONG_POLL_TIMEOUT_MS = 35_000;

// 对外声明的 iLink 客户端版本：模仿官方 openclaw-weixin 的版本，
// 避免后端因客户端版本过低而拒绝/快速过期二维码。需随官方更新——故支持 env 覆盖，免改代码。
const ILINK_CLIENT_VERSION = process.env.ILINK_CLIENT_VERSION?.trim() || "2.4.3";
const CHANNEL_VERSION = ILINK_CLIENT_VERSION;

/**
 * iLink-App-ClientVersion: uint32 编码 0x00MMNNPP（major<<16 | minor<<8 | patch）。
 * 编码方式借鉴自官方 Tencent/openclaw-weixin（MIT）。
 */
function buildClientVersion(version: string): number {
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

async function apiFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
  label: string;
}): Promise<string> {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const hdrs = buildHeaders({ token: params.token, body: params.body });

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: hdrs,
      body: params.body,
      signal: controller.signal,
    });
    const rawText = await res.text(); // 读完响应体后再 clearTimeout：否则慢 body 不受超时保护、可能无限阻塞（长轮询尤甚）
    clearTimeout(t);
    if (!res.ok) {
      throw new Error(`${params.label} ${res.status}: ${rawText}`);
    }
    return rawText;
  } catch (err) {
    clearTimeout(t);
    throw err;
  }
}

/** 防御性解析 API JSON 响应：失败抛带 label 与响应片段的清晰错误，而非裸 SyntaxError（畸形/代理 HTML/截断响应不致以晦涩错误打断调用方）。 */
function parseJsonResp<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${label}: response not JSON (${raw.slice(0, 120)})`);
  }
}

export function buildBaseInfo() {
  return { channel_version: CHANNEL_VERSION };
}

export async function getUpdates(params: {
  baseUrl: string;
  token?: string;
  updatesBuf?: string;
  timeoutMs?: number;
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
    });
    return parseJsonResp<GetUpdatesResp>(rawText, "getUpdates");
  } catch (err) {
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
}): Promise<void> {
  const raw = await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: "sendMessage",
  });
  // iLink 即使 HTTP 200 也可能在响应体返回非 0 ret/errcode 表示失败。语义见 error-codes.ts：
  //   ret=-2 参数错误（最常见 context_token 失效/不匹配）；errcode=-14 会话过期。
  // 不校验会导致"假成功"——消息其实没送达。仅在明确拿到非 0 错误码时抛 ILinkError（携带码+分类，供上层按类型处理）。
  let code: number | undefined;
  let errmsg: string | undefined;
  try {
    const resp = raw ? (JSON.parse(raw) as { ret?: number; errcode?: number; errmsg?: string }) : null;
    code = resp?.ret ?? resp?.errcode;
    errmsg = resp?.errmsg;
  } catch { /* 空/非 JSON 的成功响应，忽略 */ }
  if (code !== undefined && code !== 0) {
    throw new ILinkError("sendMessage", code, errmsg);
  }
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
  return parseJsonResp<GetUploadUrlResp>(raw, "getUploadUrl");
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

export async function pollQRStatus(
  apiBaseUrl: string,
  qrcode: string,
): Promise<QRStatusResponse> {
  const base = ensureTrailingSlash(apiBaseUrl);
  const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), {
      headers: buildCommonHeaders(),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      clearTimeout(timer);
      throw new Error(`Failed to poll QR status: ${response.status} ${response.statusText} ${body}`);
    }
    const text = await response.text();
    clearTimeout(timer);
    return parseJsonResp<QRStatusResponse>(text, "pollQRStatus");
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "wait" };
    }
    throw err;
  }
}

export function generateId(prefix: string): string {
  return `${prefix}:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

const DEFAULT_CONFIG_TIMEOUT_MS = 15_000;

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
    timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
    label: "getConfig",
  });
  return parseJsonResp<GetConfigResp>(rawText, "getConfig");
}

export async function sendTyping(params: {
  baseUrl: string;
  token?: string;
  body: SendTypingReq;
}): Promise<void> {
  await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendtyping",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
    label: "sendTyping",
  });
}

/** 通知服务端该 bot 客户端上线（best-effort，失败不阻断）。 */
export async function notifyStart(params: { baseUrl: string; token?: string }): Promise<void> {
  try {
    await apiFetch({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/msg/notifystart",
      body: JSON.stringify({ base_info: buildBaseInfo() }),
      token: params.token,
      timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
      label: "notifyStart",
    });
  } catch (err) {
    console.error(`[ilink] notifyStart failed (ignored, best-effort): ${String(err)}`);
  }
}

/** 通知服务端该 bot 客户端下线（best-effort，失败不阻断）。 */
export async function notifyStop(params: { baseUrl: string; token?: string }): Promise<void> {
  try {
    await apiFetch({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/msg/notifystop",
      body: JSON.stringify({ base_info: buildBaseInfo() }),
      token: params.token,
      timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
      label: "notifyStop",
    });
  } catch (err) {
    console.error(`[ilink] notifyStop failed (ignored, best-effort): ${String(err)}`);
  }
}
