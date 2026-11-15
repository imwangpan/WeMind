import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ResolvedAgent } from "../brain-agents.js";
import type { AgentRuntime } from "../config/runtime.js";
import { stripWechatFromConfigCopy } from "./managed-common.js";

/**
 * 「沙箱 → 副本」全局改名曾把运行日志里的「副本」叠成「副本副本」：日志是给登录者看的、又不在任何断言里，只能靠肉眼发现。
 * 这里同时锁住源码里的日志模板与实际打出的那一行，避免改名再次悄悄改坏日志。
 */
const source = (): string =>
  fs.readFileSync(new URL("./managed-common.ts", import.meta.url), "utf-8");

describe("managed 副本日志文案", () => {
  it("源码日志模板不含重复的「副本副本」，且仍是完整的可读文案", () => {
    const src = source();
    expect(src).not.toContain("副本副本");
    expect(src).toContain("`副本里的微信 MCP 已剔除");
    expect(src).toContain("`副本清洗失败");
    expect(src).toContain("`${label}副本里的 MCP 条目已剥离");
    expect(src).toContain("已从${label}副本剔除");
  });

  it("剥离副本里的微信 MCP 时，实际 WARN 写「副本」且不带重复词", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-copy-log-"));
    try {
      const configDir = path.join(root, "brain-home");
      const patchFile = path.join(configDir, "profiles", "acp", "cordis.patch.yml");
      fs.mkdirSync(path.dirname(patchFile), { recursive: true });
      fs.writeFileSync(
        patchFile,
        [
          "- id: llm-pi-ai",
          "  config:",
          "    providers: {}",
          "- id: mcp-wemind # 用户自己挂的微信 MCP",
          "  name: '@deepseek-ai/dsh-mcp-client'",
          "  config:",
          "    serverName: wechat",
          "    transport: stdio",
          "    command: npx",
          "    args: ['-y', '@wemind/wechat-mcp']",
          "- id: mcp-github",
          "  config:",
          "    serverName: github",
          "",
        ].join("\n"),
        "utf-8",
      );

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        stripWechatFromConfigCopy(
          { name: "deepseek", realProfile: "acp" } as unknown as ResolvedAgent,
          { mode: "managed", configDir } as unknown as AgentRuntime,
        );
        const joined = warn.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
        expect(warn).toHaveBeenCalled();
        expect(joined).toContain("[WARN]");
        expect(joined).toContain("副本里的微信 MCP 已剔除");
        expect(joined).not.toContain("副本副本");
      } finally {
        warn.mockRestore();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
