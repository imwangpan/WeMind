import { describe, it, expect } from "vitest";

import {
  agentKey,
  planAcquire,
  planReap,
  poolLimits,
  type ConnInfo,
  type PoolLimits,
} from "./worker-pool.js";
import type { ResolvedAgent } from "./brain-agents.js";

/**
 * 进程池的**取用/回收策略**是纯函数（`planAcquire`/`planReap`），IO（真起进程）在别处。
 * 这样「什么时候复用、什么时候回收、什么时候拒绝」可以一条条钉死在测试里，不必靠起真进程碰运气。
 */
const LIM: PoolLimits = { maxConcurrent: 3, idleMax: 2, idleMs: 300_000 };
const T = 1_000_000;
const K = "kiro|/bin/kiro|acp";
const K2 = "opencode|/bin/oc|acp";

const conn = (id: string, key: string, state: "busy" | "idle", lastUsedAt = T): ConnInfo => ({
  id,
  agent: key.split("|")[0],
  key,
  state,
  lastUsedAt,
});

describe("poolLimits", () => {
  it("默认 3 并发 / 2 空闲 / 5 分钟回收", () => {
    expect(poolLimits({})).toEqual({ maxConcurrent: 3, idleMax: 2, idleMs: 300_000 });
  });

  it("env 覆盖，非法值（0/负数/NaN）回落默认", () => {
    expect(
      poolLimits({ WEMIND_MAX_WORKERS: "5", WEMIND_IDLE_MAX: "1", WEMIND_WORKER_REAP_MS: "60000" }),
    ).toEqual({ maxConcurrent: 5, idleMax: 1, idleMs: 60_000 });
    expect(
      poolLimits({ WEMIND_MAX_WORKERS: "0", WEMIND_IDLE_MAX: "-1", WEMIND_WORKER_REAP_MS: "abc" }),
    ).toEqual({ maxConcurrent: 3, idleMax: 2, idleMs: 300_000 });
  });
});

describe("agentKey", () => {
  it("名字+bin+args 一起构成身份：同名但启动参数不同 → 不是同一条（不能互相复用进程）", () => {
    const mk = (name: string, bin: string, args: string[]) =>
      ({ name, bin, args }) as unknown as ResolvedAgent;
    expect(agentKey(mk("kiro", "/bin/kiro", ["acp"]))).toBe(
      agentKey(mk("kiro", "/bin/kiro", ["acp"])),
    );
    expect(agentKey(mk("kiro", "/bin/kiro", ["acp"]))).not.toBe(
      agentKey(mk("kiro", "/bin/kiro", ["acp", "--yolo"])),
    );
    expect(agentKey(mk("kiro", "/bin/kiro", ["acp"]))).not.toBe(
      agentKey(mk("kiro", "/other/kiro", ["acp"])),
    );
  });
});

describe("planAcquire", () => {
  it("空池 → spawn", () => {
    expect(planAcquire([], K, LIM, T)).toEqual({ kind: "spawn", reap: [] });
  });

  it("同 agent 有空闲 → 复用（最旧的先用：它本来最接近被回收，先让它干活正好续命）", () => {
    const conns = [conn("a", K, "idle", T - 9000), conn("b", K, "idle", T - 1000)];
    const plan = planAcquire(conns, K, LIM, T);
    expect(plan).toMatchObject({ kind: "reuse", connId: "a" });
  });

  it("只有别的 agent 的空闲 → spawn（不跨 agent 复用）", () => {
    const conns = [conn("a", K2, "idle")];
    expect(planAcquire(conns, K, LIM, T)).toMatchObject({ kind: "spawn" });
  });

  it("并发达上限 → 拒绝（不排队、不硬上）", () => {
    const conns = [conn("a", K, "busy"), conn("b", K2, "busy"), conn("c", K, "busy")];
    const plan = planAcquire(conns, K, LIM, T);
    expect(plan.kind).toBe("reject");
    expect(plan.kind === "reject" && plan.problem).toContain("已达上限（3 个）");
  });

  it("过期的同 agent 空闲仍**优先复用**（先杀再起是纯亏），且它不出现在 reap 里", () => {
    const conns = [conn("old", K, "idle", T - 400_000)];
    const plan = planAcquire(conns, K, LIM, T);
    expect(plan).toMatchObject({ kind: "reuse", connId: "old" });
    expect(plan.kind !== "reject" && plan.reap).not.toContain("old");
  });

  it("spawn 时顺带回收过期的空闲（别的 agent 的）", () => {
    const conns = [conn("old", K2, "idle", T - 400_000), conn("fresh", K2, "idle", T - 1000)];
    const plan = planAcquire(conns, K, LIM, T);
    expect(plan).toMatchObject({ kind: "spawn", reap: ["old"] });
  });
});

describe("planReap", () => {
  it("空闲超时 → 收；忙的不动", () => {
    const conns = [
      conn("busyOld", K, "busy", T - 400_000), // 忙的再老也不收（杀了就是丢任务）
      conn("idleOld", K2, "idle", T - 400_000),
      conn("idleNew", K2, "idle", T - 1000),
    ];
    expect(planReap(conns, LIM, T)).toEqual(["idleOld"]);
  });

  it("没过期但超编（idleMax=2）→ 从最旧的开始收", () => {
    const conns = [
      conn("a", K, "idle", T - 3000),
      conn("b", K2, "idle", T - 2000),
      conn("c", K, "idle", T - 1000),
    ];
    expect(planReap(conns, LIM, T)).toEqual(["a"]);
  });

  it("keep（刚用上的那条）永不回收，哪怕它是最旧/过期的", () => {
    const conns = [
      conn("keep", K, "idle", T - 400_000),
      conn("a", K2, "idle", T - 3000),
      conn("b", K2, "idle", T - 2000),
      conn("c", K2, "idle", T - 1000),
    ];
    const reap = planReap(conns, LIM, T, "keep");
    expect(reap).not.toContain("keep");
    // keep 占了一个空闲名额，所以另外 3 条里要收掉 2 条才回到 idleMax=2
    expect(reap.sort()).toEqual(["a", "b"]);
  });

  it("空池/全忙 → 什么都不收", () => {
    expect(planReap([], LIM, T)).toEqual([]);
    expect(planReap([conn("a", K, "busy")], LIM, T)).toEqual([]);
  });
});
