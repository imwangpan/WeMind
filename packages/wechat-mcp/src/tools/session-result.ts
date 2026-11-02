import { SESSION_EXPIRED_ERRCODE, getRemainingPauseMs } from "@wemind/wechat-ilink-core";

import { jsonResult, type ToolResult } from "./tool-result.js";

/** 会话过期（-14，冷却中）时 get_messages / send / typing 共用的统一 MCP 返回。 */
export function sessionExpiredResult(botId: string): ToolResult {
  const mins = Math.ceil(getRemainingPauseMs(botId) / 60_000);
  return jsonResult({
    status: "session_expired",
    message: `微信机器人会话已过期（错误码 ${SESSION_EXPIRED_ERRCODE}），轮询已暂停约 ${mins} 分钟。要恢复：先调用 logout 清除旧凭证，再调用 login_qrcode 重新扫码；重启 MCP 客户端也能立即解除冷却（冷却只在进程内）。`,
  });
}
