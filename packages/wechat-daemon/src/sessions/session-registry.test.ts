import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { brainSessionMapPath, writeSessionMap } from "./session-map.js";
import {
  capEntries,
  currentSessionIdOf,
  deleteSession,
  ensureEntry,
  formatWhen,
  listSessions,
  loadRegistry,
  markUsed,
  renameSession,
  renderSessionList,
  resolveRef,
  sortEntries,
  syncFromPointerMap,
  titleOf,
  touchEntry,
  upsertEntry,
  validateSessionName,
  type SessionEntry,
} from "./session-registry.js";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-registry-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const entry = (over: Partial<SessionEntry> = {}): SessionEntry => ({
  agent: "kiro",
  userId: "u1",
  sessionId: "ses_" + Math.random().toString(36).slice(2, 8),
  turns: 1,
  createdAt: 1000,
  lastUsedAt: 1000,
  ...over,
});

describe("resolveRef（序号 > 名字 > id 精确 > id 前缀）", () => {
  const list: SessionEntry[] = [
    entry({ sessionId: "ses_aaa111", name: "项目A" }),
    entry({ sessionId: "ses_bbb222", title: "帮我看看报错" }),
    entry({ sessionId: "ses_aaa999" }),
  ];

  it("序号：1 起，超范围报错", () => {
    expect(resolveRef("2", list)).toMatchObject({ ok: true, index: 2 });
    expect(resolveRef("0", list)).toMatchObject({ ok: false });
    expect(resolveRef("9", list)).toMatchObject({
      ok: false,
      error: expect.stringContaining("共 3 条"),
    });
  });

  it("名字：精确与忽略大小写；同名歧义不猜", () => {
    expect(resolveRef("项目A", list)).toMatchObject({ ok: true, index: 1 });
    const two = [entry({ name: "同名" }), entry({ name: "同名" })];
    expect(resolveRef("同名", two)).toMatchObject({
      ok: false,
      error: expect.stringContaining("都叫"),
    });
  });

  it("id：精确优先，前缀唯一才命中，歧义给候选", () => {
    expect(resolveRef("ses_bbb222", list)).toMatchObject({ ok: true, index: 2 });
    expect(resolveRef("ses_bbb", list)).toMatchObject({ ok: true, index: 2 });
    expect(resolveRef("ses_aaa", list)).toMatchObject({
      ok: false,
      error: expect.stringContaining("匹配到 2 条"),
    });
  });

  it("空列表 / 找不到", () => {
    expect(resolveRef("1", [])).toMatchObject({
      ok: false,
      error: expect.stringContaining("还没有"),
    });
    expect(resolveRef("不存在", list)).toMatchObject({ ok: false });
    expect(resolveRef("  ", list)).toMatchObject({ ok: false });
  });
});

describe("validateSessionName", () => {
  it("拒绝空 / 纯数字 / 超长 / 换行；正常名字通过", () => {
    expect(validateSessionName("")).toMatch(/不能为空/);
    expect(validateSessionName("  ")).toMatch(/不能为空/);
    expect(validateSessionName("42")).toMatch(/纯数字/);
    expect(validateSessionName("一二三四五六七八九十一二三四五六七八九十一")).toMatch(/最多/);
    expect(validateSessionName("a\nb")).toMatch(/换行/);
    expect(validateSessionName("项目 A")).toBeNull();
    expect(validateSessionName(" 项目A ")).toBeNull();
  });
});

describe("排序与裁剪", () => {
  it("sortEntries：最近使用在前，同刻按创建时间", () => {
    const a = entry({ sessionId: "a", lastUsedAt: 100 });
    const b = entry({ sessionId: "b", lastUsedAt: 300, createdAt: 1000 });
    const c = entry({ sessionId: "c", lastUsedAt: 300, createdAt: 10 });
    const d = entry({ sessionId: "d", lastUsedAt: 300, createdAt: 99 });
    expect(sortEntries([a, b, c, d]).map((e) => e.sessionId)).toEqual(["b", "d", "c", "a"]);
  });

  it("capEntries：先淘汰未命名且最旧的；有名字的留到第二轮；keep 永不淘汰", () => {
    const list = [
      entry({ sessionId: "n1", lastUsedAt: 1 }),
      entry({ sessionId: "n2", lastUsedAt: 2, name: "宝贝" }),
      entry({ sessionId: "n3", lastUsedAt: 3 }),
      entry({ sessionId: "n4", lastUsedAt: 999, name: "当前" }),
    ];
    const kept = capEntries(list, "kiro", "u1", 3, ["n4"]);
    expect(kept.map((e) => e.sessionId).sort()).toEqual(["n2", "n3", "n4"]);
    // 上限 1 且全都命名了 → 仍要裁到上限（keep 优先）
    const kept2 = capEntries(list, "kiro", "u1", 1, ["n4"]);
    expect(kept2.map((e) => e.sessionId)).toEqual(["n4"]);
  });

  it("裁剪只影响同一个 (agent,userId) 分组", () => {
    const list = [
      entry({ userId: "u1", sessionId: "a", lastUsedAt: 1 }),
      entry({ userId: "u1", sessionId: "b", lastUsedAt: 2 }),
      entry({ userId: "u2", sessionId: "c", lastUsedAt: 3 }),
      entry({ agent: "opencode", sessionId: "d", lastUsedAt: 4 }),
    ];
    const kept = capEntries(list, "kiro", "u1", 1);
    expect(kept.map((e) => e.sessionId).sort()).toEqual(["b", "c", "d"]);
  });

  it("upsertEntry：同一条更新而非重复插入，且刚写入的那条不会被裁掉", () => {
    const list = [
      entry({ sessionId: "x", lastUsedAt: 1 }),
      entry({ sessionId: "y", lastUsedAt: 2 }),
    ];
    const next = upsertEntry(list, entry({ sessionId: "x", lastUsedAt: 100 }), { max: 1 });
    expect(next).toHaveLength(1);
    expect(next[0].sessionId).toBe("x");
  });
});

describe("写入磁盘与读写入口", () => {
  it("损坏文件 → 空表，不抛", () => {
    fs.writeFileSync(path.join(dir, "session-registry.json"), "{ 坏", "utf-8");
    expect(loadRegistry(dir).entries).toEqual([]);
  });

  it("无效条目在读入时丢弃；缺时间字段用 now 兜底", () => {
    fs.writeFileSync(
      path.join(dir, "session-registry.json"),
      JSON.stringify({
        version: 1,
        entries: [{ agent: "kiro" }, { agent: "kiro", userId: "u1", sessionId: "ok" }],
      }),
      "utf-8",
    );
    const reg = loadRegistry(dir, 777);
    expect(reg.entries).toHaveLength(1);
    expect(reg.entries[0].sessionId).toBe("ok");
    expect(reg.entries[0].createdAt).toBe(777);
    expect(reg.entries[0].lastUsedAt).toBe(777);
  });

  it("ensureEntry 新建（turns=0）；touchEntry 累加轮次并只写首次标题", () => {
    ensureEntry("kiro", "u1", "s1", { dir, now: 5 });
    let { entries } = listSessions("kiro", "u1", dir);
    expect(entries[0]).toMatchObject({ sessionId: "s1", turns: 0, createdAt: 5 });

    touchEntry("kiro", "u1", "s1", { title: "第一条", dir, now: 10 });
    touchEntry("kiro", "u1", "s1", { title: "不该覆盖", dir, now: 20 });
    ({ entries } = listSessions("kiro", "u1", dir));
    expect(entries[0]).toMatchObject({ turns: 2, title: "第一条", lastUsedAt: 20 });

    touchEntry("kiro", "u1", "s1", { turns: 9, dir, now: 30 });
    expect(listSessions("kiro", "u1", dir).entries[0].turns).toBe(9);
  });

  it("touchEntry 对未登记的会话（老库/直接 load）自动补登记", () => {
    touchEntry("kiro", "u1", "s_new", { dir, now: 3 });
    expect(listSessions("kiro", "u1", dir).entries[0]).toMatchObject({
      sessionId: "s_new",
      turns: 1,
    });
  });

  it("markUsed：只刷新最近使用（不动轮次/标题），未登记则补一条 turns=0", () => {
    ensureEntry("kiro", "u1", "s1", { dir, now: 5 });
    touchEntry("kiro", "u1", "s1", { title: "标题", dir, now: 10 });
    markUsed("kiro", "u1", "s1", { dir, now: 99 });
    expect(listSessions("kiro", "u1", dir).entries[0]).toMatchObject({
      turns: 1, // 「切回」不是「又聊一轮」
      title: "标题",
      lastUsedAt: 99,
    });

    markUsed("kiro", "u1", "s_loaded", { dir, now: 123 });
    const e = listSessions("kiro", "u1", dir).entries.find((x) => x.sessionId === "s_loaded");
    expect(e).toMatchObject({ turns: 0, createdAt: 123, lastUsedAt: 123 });
    expect(e?.backfilled).toBeUndefined();
  });

  it("titleOf：折叠换行/多空格、超长截断；空文本给 undefined（纯图片消息没有标题可写）", () => {
    expect(titleOf("你好\n世界   呀")).toBe("你好 世界 呀");
    expect(titleOf("   ")).toBeUndefined();
    expect(titleOf("")).toBeUndefined();
    expect(titleOf("一".repeat(40))).toBe(`${"一".repeat(30)}…`);
  });

  it("写入磁盘失败不抛（登记表是派生元数据，绝不能拖垮回合）：目录位置被一个文件占住", () => {
    const blocked = path.join(dir, "占位");
    fs.writeFileSync(blocked, "x", "utf-8");
    expect(() => ensureEntry("kiro", "u1", "s1", { dir: blocked })).not.toThrow();
    expect(() => markUsed("kiro", "u1", "s1", { dir: blocked })).not.toThrow();
  });

  it("listSessions：只列本人的 + 其它大脑的条数 + 当前会话记录", () => {
    ensureEntry("kiro", "u1", "s1", { dir });
    ensureEntry("opencode", "u1", "s2", { dir });
    ensureEntry("kiro", "u2", "s3", { dir });
    writeSessionMap(brainSessionMapPath(dir), { "kiro:u1": "s1" });
    const r = listSessions("kiro", "u1", dir);
    expect(r.entries.map((e) => e.sessionId)).toEqual(["s1"]);
    expect(r.others).toBe(1);
    expect(r.currentSessionId).toBe("s1");
    expect(currentSessionIdOf("kiro", "u1", dir)).toBe("s1");
  });
});

describe("重命名 / 删除", () => {
  it("重命名：可用序号或名字寻址；非法名字被拒", () => {
    ensureEntry("kiro", "u1", "s1", { dir, now: 1 });
    ensureEntry("kiro", "u1", "s2", { dir, now: 2 });
    expect(renameSession("kiro", "u1", "1", "旧会话", dir)).toMatchObject({ ok: true });
    expect(renameSession("kiro", "u1", "旧会话", "改名了", dir)).toMatchObject({ ok: true });
    expect(renameSession("kiro", "u1", "改名了", "7", dir)).toMatchObject({ ok: false });
    const names = listSessions("kiro", "u1", dir).entries.map((e) => e.name);
    expect(names).toContain("改名了");
  });

  it("删除：删登记项；删的若是当前会话则同时清当前会话记录（下条消息自然开新的）", () => {
    ensureEntry("kiro", "u1", "s1", { dir, now: 1 });
    ensureEntry("kiro", "u1", "s2", { dir, now: 2 });
    writeSessionMap(brainSessionMapPath(dir), { "kiro:u1": "s2" });

    expect(deleteSession("kiro", "u1", "s1", { dir })).toMatchObject({
      ok: true,
      clearedPointer: false,
    });
    const r = deleteSession("kiro", "u1", "s2", { dir });
    expect(r).toMatchObject({ ok: true, clearedPointer: true });
    expect(listSessions("kiro", "u1", dir).entries).toEqual([]);
    expect(fs.readFileSync(brainSessionMapPath(dir), "utf-8")).not.toContain("s2");
  });

  it("删除不存在的 → 报错且不动登记表", () => {
    ensureEntry("kiro", "u1", "s1", { dir });
    expect(deleteSession("kiro", "u1", "9", { dir })).toMatchObject({ ok: false });
    expect(listSessions("kiro", "u1", dir).entries).toHaveLength(1);
  });
});

describe("回填与渲染", () => {
  it("syncFromPointerMap：补当前会话表里有、登记表里没有的（幂等）", () => {
    writeSessionMap(brainSessionMapPath(dir), { "kiro:u1": "s1", "opencode:u1": "s2", 坏键: "s3" });
    expect(syncFromPointerMap(dir, 100)).toBe(2);
    expect(syncFromPointerMap(dir, 200)).toBe(0);
    const reg = loadRegistry(dir);
    expect(reg.entries.map((e) => `${e.agent}:${e.sessionId}`).sort()).toEqual([
      "kiro:s1",
      "opencode:s2",
    ]);
    expect(reg.entries.every((e) => e.backfilled === true)).toBe(true);
  });

  it("formatWhen：同年给月日时分，跨年补年份，无时间说明", () => {
    const now = new Date("2026-10-28T10:00:00").getTime();
    expect(formatWhen(new Date("2026-10-27T12:03:00").getTime(), now)).toBe("10-27 12:03");
    expect(formatWhen(new Date("2025-01-05T01:02:00").getTime(), now)).toBe("2025-01-05");
    expect(formatWhen(0, now)).toBe("时间未知");
  });

  it("renderSessionList：分页、当前标记、其它大脑提示、空表文案", () => {
    const list: SessionEntry[] = Array.from({ length: 12 }, (_, i) =>
      entry({
        sessionId: `s${i + 1}`,
        name: i === 0 ? "项目A" : undefined,
        title: `第${i + 1}条`,
        lastUsedAt: 100 - i,
        turns: i + 1,
      }),
    );
    const p1 = renderSessionList(list, {
      agent: "kiro",
      page: 1,
      currentSessionId: "s1",
      others: 3,
      now: 100,
    });
    expect(p1).toContain("共 12 条，第 1/2 页");
    expect(p1).toContain("「项目A」");
    expect(p1).toContain("← 当前");
    expect(p1).toContain("会话列表 2");
    expect(p1).toContain("另有 3 条属于其它大脑");
    const p2 = renderSessionList(list, { agent: "kiro", page: 2, pageSize: 10 });
    expect(p2).toContain("第 2/2 页");
    expect(p2).toContain("11.");
    expect(p2).toContain("12.");
    // 页码越界 → 钳到最后一页，不炸
    expect(renderSessionList(list, { agent: "kiro", page: 99, pageSize: 10 })).toContain(
      "第 2/2 页",
    );
    expect(renderSessionList([], { agent: "kiro" })).toContain("还没有历史会话");
  });
});
