import { describe, expect, it } from "vitest";

import type { ChatCommand } from "./chat-commands.js";
import { handleControl } from "./daemon-control.js";

function ctx(owner: string) {
  return { owner, notify: async () => {} };
}

describe("handleControl（微信侧控制指令分派）", () => {
  it("help 按「登录者 / 其他发送者」裁剪：ownerOnly 指令只出现在登录者那份", async () => {
    const ownerHelp = await handleControl({ kind: "help" }, "u1", ctx("u1"));
    const userHelp = await handleControl({ kind: "help" }, "u2", ctx("u1"));
    expect(ownerHelp).toContain("AI / AI 列表");
    expect(ownerHelp).toContain("切换大脑");
    expect(userHelp).not.toContain("AI / AI 列表");
    expect(userHelp).not.toBe(ownerHelp);
  });

  it("指令表新增了 kind 但分派没接通时给明确提示，不静默吞掉", async () => {
    const out = await handleControl(
      { kind: "future-kind" } as unknown as ChatCommand,
      "u1",
      ctx("u1"),
    );
    expect(out).toContain("future-kind");
    expect(out).toContain("还没接通");
  });
});
