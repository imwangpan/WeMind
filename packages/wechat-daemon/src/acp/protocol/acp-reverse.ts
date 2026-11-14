/**
 * ACP 反向请求的统一应答器。
 *
 * agent 会在回合中发回 `session/request_permission`（工具审批）、`fs/*`、`terminal/*` 等请求；
 * 不回应它们，agent 会一直等到自己的超时，表现为「这条消息卡住」。brain、worker、`brain check`
 * 三处都必须用同一套语义，否则会出现「微信能跑、自检超时」或「worker 与 brain 行为不同」的漂移。
 *
 * 默认 yolo：微信侧无人值守，权限请求自动选 `allow_once` / `allow_always`（「每次自动点允许」，
 * 不放宽 Agent 自己的副本）。要恢复逐次拒绝，设 `WEMIND_ACP_AUTO_ALLOW=0`。
 * 未知 method 回 `-32601`。
 */
export type AcpWriter = (payload: Record<string, unknown>) => void;

export function handleReverseRequest(
  frame: Record<string, any>,
  write: AcpWriter,
  log?: (message: string) => void,
): void {
  const method = String(frame.method);
  log?.(`← reverse request ${method}#${frame.id}`);
  if (method === "session/request_permission") {
    const options = Array.isArray(frame.params?.options) ? frame.params.options : [];
    const autoAllow = !["0", "false", "off", "no"].includes(
      (process.env.WEMIND_ACP_AUTO_ALLOW ?? "").trim().toLowerCase(),
    );
    const allow = autoAllow
      ? options.find((o: any) => o?.kind === "allow_once" || o?.kind === "allow_always")
      : undefined;
    const result = allow
      ? { outcome: { outcome: "selected", optionId: allow.optionId } }
      : { outcome: { outcome: "cancelled" } };
    write({ jsonrpc: "2.0", id: frame.id, result });
    log?.(`permission ${allow ? "allowed" : "rejected"}`);
    return;
  }
  // 未知反向请求也要回错误，否则对端会挂起（哪怕它并不认识这个错误码）。
  write({
    jsonrpc: "2.0",
    id: frame.id,
    error: { code: -32601, message: "method not supported" },
  });
}
