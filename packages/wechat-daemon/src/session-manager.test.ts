import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { brainSessionMapPath, readSessionMap, writeSessionMap } from "./session-map.js";

/**
 * 会话管理操作层（session-manager）：把「新会话 / 列表 / 恢复 / 重命名 / 删除」拼成回执。
 *
 * 这里**不**起 ACP 进程：`create`/`resume` 是注入的（真实现在 acp-brain，由 acp-switch.test.ts 用假 agent 覆盖）。
 * 要钉死的是顺序与失败语义——尤其是「恢复失败**不**动当前会话记录」「删除**只**删登记」这两条对用户的承诺。
 * 所有用例显式传 dir（临时目录），不碰 DATA_DIR。
 */
const { newSessionCmd, sessionsCmd, resumeSessionCmd, renameSessionCmd, deleteSessionCmd } =
  await import("./session-manager.js");
const { currentSessionIdOf, ensureEntry, loadRegistry, labelOf, syncFromPointerMap, touchEntry } =
  await import("./session-registry.js");

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-session-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const AG = "kiro";
const mapFile = (): string => brainSessionMapPath(dir);
/** 模拟 ACP 层写当前会话记录（真实现在 acp-brain.ensureSession / resumeSession）。 */
const setPointer = (userId: string, sid: string): void =>
  writeSessionMap(mapFile(), { ...readSessionMap(mapFile()), [`${AG}:${userId}`]: sid });
const cur = (userId: string): string | undefined => currentSessionIdOf(AG, userId, dir);
/** 造一条历史会话（turns 用绝对值写）。 */
const seed = (
  sid: string,
  opts: { name?: string; title?: string; turns?: number; at: number; user?: string },
): void => {
  const userId = opts.user ?? "u1";
  ensureEntry(AG, userId, sid, { name: opts.name, dir, now: opts.at });
  touchEntry(AG, userId, sid, { title: opts.title, turns: opts.turns ?? 1, dir, now: opts.at });
};
const entryOf = (sid: string, user = "u1") =>
  loadRegistry(dir).entries.find((e) => e.agent === AG && e.userId === user && e.sessionId === sid);

describe("新会话", () => {
  it("命名新建：先建后登记命名（按刚写下的当前会话记录读 id）", async () => {
    const create = vi.fn(async (userId: string) => {
      setPointer(userId, "sess-a");
    });
    const r = await newSessionCmd({ agent: AG, userId: "u1", dir, name: "周报", create });
    expect(create).toHaveBeenCalledWith("u1");
    expect(r).toContain("周报");
    expect(cur("u1")).toBe("sess-a");
    expect(entryOf("sess-a")?.name).toBe("周报");
  });

  it("名字非法（纯数字）→ 拒绝，且**不**清上下文（create 没被调用）", async () => {
    setPointer("u1", "sess-old");
    const create = vi.fn(async () => {});
    const r = await newSessionCmd({ agent: AG, userId: "u1", dir, name: "3", create });
    expect(r).toContain("❌");
    expect(r).toContain("纯数字");
    expect(create).not.toHaveBeenCalled();
    expect(cur("u1")).toBe("sess-old"); // 上下文没白清
  });

  it("不带名字：只新建，不写名字", async () => {
    const create = vi.fn(async (userId: string) => setPointer(userId, "sess-b"));
    expect(await newSessionCmd({ agent: AG, userId: "u1", dir, create })).toContain("已开启新会话");
    expect(entryOf("sess-b")?.name).toBeUndefined();
  });
});

describe("会话列表", () => {
  beforeEach(() => {
    for (let i = 1; i <= 12; i++)
      seed(`s${String(i).padStart(2, "0")}`, {
        title: `第 ${i} 条的标题`,
        turns: i,
        at: 1_000_000 + i * 1000,
      });
    seed("s-cur", { title: "当前这条", at: 1_000_000 + 99_000 });
    setPointer("u1", "s-cur");
    // 别人（u2）的会话、其它大脑的会话：都不该出现在 u1 的列表里
    seed("s-other-user", { at: 1_000_000 + 50_000, user: "u2" });
    ensureEntry("opencode", "u1", "s-other-agent", { dir, now: 1_000_000 + 60_000 });
    ensureEntry("opencode", "u1", "s-other-agent2", { dir, now: 1_000_000 + 61_000 });
  });

  it("分页 + 当前标记 + 其它大脑条数；别人的会话不出现", () => {
    const p1 = sessionsCmd({ agent: AG, userId: "u1", dir, now: 1_000_000 + 100_000 });
    expect(p1).toContain("共 13 条，第 1/2 页");
    expect(p1).toContain("← 当前");
    expect(p1).toContain("1. 当前这条"); // 最近使用在前
    expect(p1).not.toContain("s-other-user");
    expect(p1).toContain("另有 2 条属于其它大脑的会话");
    expect(p1).toContain("会话列表 2");

    const p2 = sessionsCmd({ agent: AG, userId: "u1", dir, page: 2, now: 1_000_000 + 100_000 });
    expect(p2).toContain("第 2/2 页");
    expect(p2).toContain("13.");
    expect(p2).not.toContain("← 当前"); // 当前那条在第 1 页
  });

  it("空表：给出下一步怎么做（不是干巴巴的「无数据」）", () => {
    const r = sessionsCmd({ agent: "qoder", userId: "u1", dir });
    expect(r).toContain("还没有历史会话");
    expect(r).toContain("新会话");
  });
});

describe("恢复会话", () => {
  it("成功：严格恢复的 load 由注入实现做，成功后才登记「最近使用」", async () => {
    seed("s-old", { title: "旧会话", turns: 5, at: 1_000_000 });
    seed("s-new", { title: "新会话", turns: 1, at: 1_000_000 + 5000 });
    setPointer("u1", "s-new");
    const resume = vi.fn(async (userId: string, sid: string) => {
      setPointer(userId, sid); // 真实现在 acp-brain：load 成功才写当前会话记录
      return { ok: true as const };
    });
    const r = await resumeSessionCmd({ agent: AG, userId: "u1", dir, resume, now: 2_000_000 }, "2");
    expect(r).toContain("✅");
    expect(r).toContain("旧会话");
    expect(r).toContain("5 轮");
    expect(resume).toHaveBeenCalledWith("u1", "s-old");
    expect(cur("u1")).toBe("s-old");
    expect(entryOf("s-old")?.lastUsedAt).toBe(2_000_000); // 顶到列表首位
    expect(entryOf("s-old")?.turns).toBe(5); // 「切回」不是「又聊一轮」
    expect(entryOf("s-old")?.title).toBe("旧会话"); // 标题不被抹掉
  });

  it("失败：如实报错、markUsed 不执行、**当前会话记录不变**", async () => {
    seed("s-old", { name: "旧会话", turns: 5, at: 1_000_000 });
    setPointer("u1", "s-cur");
    const resume = vi.fn(async () => ({
      ok: false as const,
      problem: "接不上会话 s-old（该 agent 不支持恢复）。",
    }));
    const r = await resumeSessionCmd(
      { agent: AG, userId: "u1", dir, resume, now: 2_000_000 },
      "旧会话",
    );
    expect(r).toContain("❌");
    expect(r).toContain("接不上");
    expect(cur("u1")).toBe("s-cur"); // 当前会话原样
    expect(entryOf("s-old")?.lastUsedAt).toBe(1_000_000); // 没被假装用上
  });

  it("已经是当前会话：不重复 load（省一次往返），直接说清楚", async () => {
    seed("s-cur", { title: "当前", at: 1_000_000 });
    setPointer("u1", "s-cur");
    const resume = vi.fn(async () => ({ ok: true as const }));
    const r = await resumeSessionCmd({ agent: AG, userId: "u1", dir, resume }, "1");
    expect(r).toContain("当前就在这条会话上");
    expect(resume).not.toHaveBeenCalled();
  });

  it("找不到/序号超范围：报错且不调 resume", async () => {
    seed("s1", { at: 1_000_000 });
    seed("s2", { at: 1_000_001 });
    const resume = vi.fn(async () => ({ ok: true as const }));
    expect(await resumeSessionCmd({ agent: AG, userId: "u1", dir, resume }, "9")).toContain(
      "序号超范围",
    );
    expect(await resumeSessionCmd({ agent: AG, userId: "u1", dir, resume }, "没这个")).toContain(
      "没有找到",
    );
    expect(resume).not.toHaveBeenCalled();
  });
});

describe("重命名 / 删除", () => {
  it("重命名：按序号寻址，回执给「旧标签 → 新名字」，命名后可用新名字寻址", () => {
    seed("s1", { title: "原始标题", at: 1_000_000 });
    const r = renameSessionCmd({ agent: AG, userId: "u1", dir }, "1", "项目A");
    expect(r).toContain("原始标题");
    expect(r).toContain("项目A");
    expect(entryOf("s1")?.name).toBe("项目A");
    // 用新名字再寻址一次（重命名走的是名字解析，能命中说明名字真的写进去了）
    expect(renameSessionCmd({ agent: AG, userId: "u1", dir }, "项目A", "项目B")).toContain("项目B");
  });

  it("重命名：名字非法 → 拒绝且不改登记", () => {
    seed("s1", { title: "标题", at: 1_000_000 });
    expect(renameSessionCmd({ agent: AG, userId: "u1", dir }, "1", "12")).toContain("❌");
    expect(entryOf("s1")?.name).toBeUndefined();
  });

  it("删除当前会话：清当前会话记录（下条消息开新的），并如实说 agent 侧归档还在", () => {
    seed("s-cur", { name: "当前", at: 1_000_000 });
    seed("s2", { title: "另一条", at: 1_000_001 });
    setPointer("u1", "s-cur");
    const r = deleteSessionCmd({ agent: AG, userId: "u1", dir }, "当前");
    expect(r).toContain("✅");
    expect(r).toContain("下一条消息会开一个新的");
    expect(r).toContain("agent 自己那份历史归档不在 WeMind 手里");
    expect(cur("u1")).toBeUndefined(); // 当前会话记录清了
    expect(loadRegistry(dir).entries.map((e) => e.sessionId)).toEqual(["s2"]); // 只删了这一条
  });

  it("删除非当前会话：当前会话记录不动", () => {
    seed("s-cur", { title: "当前", at: 1_000_000 });
    seed("s2", { title: "另一条", at: 1_000_001 });
    setPointer("u1", "s-cur");
    const r = deleteSessionCmd({ agent: AG, userId: "u1", dir }, "1");
    expect(r).toContain("当前会话没有变");
    expect(cur("u1")).toBe("s-cur");
    expect(loadRegistry(dir).entries.map((e) => e.sessionId)).toEqual(["s-cur"]);
  });

  it("删除不存在的 → 报错且登记表原样", () => {
    seed("s1", { at: 1_000_000 });
    expect(deleteSessionCmd({ agent: AG, userId: "u1", dir }, "7")).toContain("❌");
    expect(loadRegistry(dir).entries.map((e) => e.sessionId)).toEqual(["s1"]);
  });
});

describe("回填（功能上线前的老账号）", () => {
  it("syncFromPointerMap 把当前会话表里的会话补进登记表，标题/轮次留待真实回合", () => {
    setPointer("u1", "sess-legacy");
    expect(syncFromPointerMap(dir, 5_000_000)).toBe(1);
    const e = entryOf("sess-legacy");
    expect(e).toMatchObject({ turns: 0, backfilled: true });
    expect(labelOf(e!)).toContain("sess-leg"); // 没有标题时用短 id
    expect(syncFromPointerMap(dir, 5_000_001)).toBe(0); // 幂等
  });
});
