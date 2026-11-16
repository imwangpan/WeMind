/**
 * MCP / 首帧耗时观测：只记录与告警，**绝不自动禁用**（用户明确要求“慢了只警告”）。
 *
 * 口径：
 * - `mcpCount`：本次 `session/new|load|resume` 下发的 MCP 条数（不含 Agent 自己配置文件里的原生项）。
 * - `sessionNewMs`：会话建立请求本身的耗时；ACP 不单列 MCP 启动时间，所以 `mcpStartupMs` 在同一次建立里等于它，
 *   仅用于让日志/doctor 有一个稳定字段名，不要解读成“纯 MCP 启动耗时”。
 * - `firstFrameMs`：`session/prompt` 发出到本会话收到第一帧的间隔（-1=没收到）。
 *
 * 阈值是经验值，集中在这一处；`scripts/doctor.ps1` 里的同名常量必须与这里保持一致。
 */
export const MCP_WARN_COUNT = 10;
export const SESSION_NEW_WARN_MS = 5_000;
export const FIRST_FRAME_WARN_MS = 15_000;

export type McpPerf = {
  mcpCount: number;
  /** Agent 自己配置文件里的 MCP 条数（目前只有 Codex 的 config.toml）；WeMind 只读、无法 unload。 */
  nativeMcpCount?: number;
  sessionNewMs?: number;
  firstFrameMs?: number;
};

/** 一行可 grep 的指标串；doctor 按这些字段名解析。 */
export function formatMcpPerf(p: McpPerf): string {
  const parts = [`mcpCount=${p.mcpCount}`];
  if (p.nativeMcpCount !== undefined && p.nativeMcpCount > 0) {
    parts.push(`nativeMcpCount=${p.nativeMcpCount}`);
  }
  if (p.sessionNewMs !== undefined) {
    parts.push(`sessionNewMs=${p.sessionNewMs}`);
    if (p.mcpCount > 0) parts.push(`mcpStartupMs=${p.sessionNewMs}`);
  }
  if (p.firstFrameMs !== undefined) parts.push(`firstFrameMs=${p.firstFrameMs}`);
  return parts.join(" ");
}

/** 返回需要 WARN 的说明；空数组表示正常。 */
export function mcpPerfWarnings(p: McpPerf): string[] {
  const out: string[] = [];
  if (p.nativeMcpCount !== undefined && p.nativeMcpCount > 0) {
    out.push(
      `Agent 自己的配置文件里还有 ${p.nativeMcpCount} 个 MCP（WeMind 只读，无法 unload）；brain 默认空只控制 WeMind 下发的集合。`,
    );
  }
  if (p.mcpCount > MCP_WARN_COUNT) {
    out.push(
      `MCP 数量 ${p.mcpCount} 超过 ${MCP_WARN_COUNT}：启动/首帧会变慢、模型 prefill 变大；不会自动禁用，可用 mcp.disable 或在终端配置里关掉不用的。`,
    );
  }
  if (p.sessionNewMs !== undefined && p.sessionNewMs > SESSION_NEW_WARN_MS) {
    out.push(
      `会话建立耗时 ${p.sessionNewMs}ms 超过 ${SESSION_NEW_WARN_MS}ms（含 MCP 启动）：先看 mcpCount=${p.mcpCount}，再按 agent 实测决定是否精简。`,
    );
  }
  if (p.firstFrameMs !== undefined && p.firstFrameMs > FIRST_FRAME_WARN_MS) {
    out.push(
      `首帧耗时 ${p.firstFrameMs}ms 超过 ${FIRST_FRAME_WARN_MS}ms：可能是 MCP 工具 schema 过大或模型排队；不会自动改变行为。`,
    );
  }
  return out;
}
