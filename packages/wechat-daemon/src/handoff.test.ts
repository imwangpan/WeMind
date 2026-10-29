import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  HANDOFF_SEP,
  HANDOFF_VERSION,
  clearHandoff,
  handoffPath,
  handoffPrefix,
  loadHandoff,
  saveHandoff,
  stripHandoffPrefix,
  takeHandoffFor,
  type Handoff,
} from "./handoff.js";

/**
 * 交接的三条克制规则（本人 / 不切回来源 / TTL）与「作为前缀带上可原样剥回」都在这里钉死；
 * 文件侧只验「往返、过期即不可用、损坏降级、消费后消失」。
 */
let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-handoff-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const mk = (over: Partial<Handoff> = {}): Handoff => ({
  version: HANDOFF_VERSION,
  fromAgent: "kiro",
  userId: "u1",
  text: "目标：把 X 做完；未决：选 A 还是 B。",
  createdAt: 1000,
  expiresAt: 2000,
  ...over,
});

describe("takeHandoffFor（要不要注入）", () => {
  it("来源 ≠ 目标、本人、未过期 → 注入正文", () => {
    expect(takeHandoffFor(mk(), "opencode", "u1", 1500)).toContain("未决");
  });

  it("切回来源大脑 → 不带上（那是它自己的上下文，塞回去等于复述）", () => {
    expect(takeHandoffFor(mk(), "kiro", "u1", 1500)).toBeNull();
    expect(takeHandoffFor(mk(), "KIRO", "u1", 1500)).toBeNull(); // 大小写不敏感
  });

  it("别人 → 不带上（给 A 写的摘要绝不进 B 的消息）", () => {
    expect(takeHandoffFor(mk(), "opencode", "u2", 1500)).toBeNull();
  });

  it("过期 / 空 / 没有摘要 → 不带上", () => {
    expect(takeHandoffFor(mk(), "opencode", "u1", 2000)).toBeNull(); // 边界：到期即失效
    expect(takeHandoffFor(mk({ text: "  " }), "opencode", "u1", 1500)).toBeNull();
    expect(takeHandoffFor(null, "opencode", "u1", 1500)).toBeNull();
  });
});

describe("落盘", () => {
  it("往返：字段齐；过期后 load 返回 null（文件还在，但不可用）", () => {
    saveHandoff(mk(), dir);
    const back = loadHandoff(dir, 1500);
    expect(back).toMatchObject({
      fromAgent: "kiro",
      userId: "u1",
      createdAt: 1000,
      expiresAt: 2000,
    });
    expect(loadHandoff(dir, 2500)).toBeNull();
  });

  it("损坏/坏形状 → null，不抛", () => {
    fs.writeFileSync(handoffPath(dir), "{ 不是 JSON", "utf-8");
    expect(loadHandoff(dir, 1)).toBeNull();
    fs.writeFileSync(handoffPath(dir), JSON.stringify({ fromAgent: "kiro" }), "utf-8");
    expect(loadHandoff(dir, 1)).toBeNull();
    expect(loadHandoff(path.join(dir, "没这个目录"), 1)).toBeNull();
  });

  it("clearHandoff：删掉后消失，再删返回 false（消费语义用）", () => {
    saveHandoff(mk(), dir);
    expect(clearHandoff(dir)).toBe(true);
    expect(fs.existsSync(handoffPath(dir))).toBe(false);
    expect(clearHandoff(dir)).toBe(false);
    expect(loadHandoff(dir, 1500)).toBeNull();
  });
});

describe("作为前缀带上", () => {
  it("注入后能用 stripHandoffPrefix 原样取回用户的话（多行也算）", () => {
    const text = "目标：把 X 做完\n未决：A 还是 B";
    const userMsg = "接着上次的做\n第二行";
    const injected = handoffPrefix("kiro", text, 1_700_000_000_000) + userMsg;
    expect(injected).toContain("来自 kiro");
    expect(injected).toContain(text);
    expect(injected).toContain(HANDOFF_SEP);
    expect(stripHandoffPrefix(injected)).toBe(userMsg);
  });

  it("用户自己打出的正文不会被误剥（只在确实是我们的前缀时才动手）", () => {
    expect(stripHandoffPrefix("普通消息")).toBe("普通消息");
    expect(stripHandoffPrefix(`我不小心打出了 ${HANDOFF_SEP} 这行`)).toBe(
      `我不小心打出了 ${HANDOFF_SEP} 这行`,
    );
    // 头对得上但没分隔行（坏数据）：原样返回，别切掉用户的正文
    expect(stripHandoffPrefix("【交接摘要 · 来自 kiro，01-01 00:00】\n只有头")).toContain("只有头");
  });
});
