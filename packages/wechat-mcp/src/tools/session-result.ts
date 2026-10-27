import { SESSION_EXPIRED_ERRCODE, getRemainingPauseMs } from "@wemind/wechat-ilink-core";

import { jsonResult, type ToolResult } from "./tool-result.js";

/** 会话过期（-14，冷却中）时 get_messages / send / typing 共用的统一 MCP 返回。 */
export function sessionExpiredResult(botId: string): ToolResult {
  const mins = Math.ceil(getRemainingPauseMs(botId) / 60_000);
  return jsonResult({
    status: "session_expired",
    message: `WeChat bot session expired (errcode ${SESSION_EXPIRED_ERRCODE}). Call login_qrcode to re-authenticate. Polling paused for ~${mins} min.`,
  });
}
