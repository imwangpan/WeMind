import { describe, expect, it } from "vitest";

import {
  FIRST_FRAME_WARN_MS,
  MCP_WARN_COUNT,
  SESSION_NEW_WARN_MS,
  formatMcpPerf,
  mcpPerfWarnings,
} from "./mcp-perf.js";

describe("MCP 性能观测", () => {
  it("指标串可被 doctor 按字段名解析", () => {
    expect(formatMcpPerf({ mcpCount: 3, sessionNewMs: 1200, firstFrameMs: 800 })).toBe(
      "mcpCount=3 sessionNewMs=1200 mcpStartupMs=1200 firstFrameMs=800",
    );
    // 没有 MCP 时不写 mcpStartupMs，避免把纯会话建立误读成 MCP 启动耗时
    expect(formatMcpPerf({ mcpCount: 0, sessionNewMs: 300 })).toBe("mcpCount=0 sessionNewMs=300");
  });

  it("正常范围不告警", () => {
    expect(
      mcpPerfWarnings({
        mcpCount: MCP_WARN_COUNT,
        sessionNewMs: SESSION_NEW_WARN_MS,
        firstFrameMs: FIRST_FRAME_WARN_MS,
      }),
    ).toEqual([]);
  });

  it("超过阈值逐项告警，但只返回说明、不做任何禁用动作", () => {
    const warnings = mcpPerfWarnings({
      mcpCount: MCP_WARN_COUNT + 1,
      sessionNewMs: SESSION_NEW_WARN_MS + 1,
      firstFrameMs: FIRST_FRAME_WARN_MS + 1,
    });
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain("mcp.disable");
    expect(warnings[1]).toContain("含 MCP 启动");
    expect(warnings[2]).toContain("不会自动改变行为");
  });

  it("没收到首帧（-1）不告警", () => {
    expect(mcpPerfWarnings({ mcpCount: 0, firstFrameMs: -1 })).toEqual([]);
  });

  it("原生配置里的 MCP 单独计数并告警（无法 unload）", () => {
    expect(formatMcpPerf({ mcpCount: 0, nativeMcpCount: 2 })).toBe("mcpCount=0 nativeMcpCount=2");
    const warnings = mcpPerfWarnings({ mcpCount: 0, nativeMcpCount: 2 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("无法 unload");
  });
});
