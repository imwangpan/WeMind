import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// mock 进程池（用 vi.hoisted 让 mock 工厂可引用）：本文件只验任务表状态机与路由，不真起进程
const { acquire, release, drop, killAll } = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
  drop: vi.fn(),
  killAll: vi.fn(),
}));
vi.mock("./worker-pool.js", () => ({
  acquire: (...a: unknown[]) => acquire(...a),
  release: (...a: unknown[]) => release(...a),
  drop: (...a: unknown[]) => drop(...a),
  killAll: () => killAll(),
  poolSummary: () => [],
}));

/** 假连接：ask 由用例逐次控制（deferred），其余方法记个调用。 */
function fakeConn(name = "kiro") {
  return {
    id: `fake-${name}-${Math.random().toString(36).slice(2, 6)}`,
    agent: { name },
    asks: [] as string[],
    sessions: [] as string[],
    cwd: undefined as string | undefined,
    alive: true,
    ask: vi.fn(),
    setCwd(c: string | undefined) {
      this.cwd = c;
    },
    effectiveCwd: () => "/cwd",
    dropSession(k: string) {
      this.sessions.push(k);
    },
    isAlive: () => true,
    pid: () => 1234,
  };
}

const { setAgent: setSlotAgent, resetSlotsForTest, getAgent } = await import("./agent-slot.js");
const {
  dispatchTask,
  injectTask,
  stopTask,
  hasActiveTask,
  awaitingTasks,
  interruptedTasks,
  looksLikeResume,
  listTasks,
  renderTaskList,
  initTasks,
  resetTasksForTest,
  providerIssue,
  setTaskPush,
  setTaskStateSink,
  setTaskAckSink,
} = await import("./task-manager.js");
import type { TaskStateSnapshot } from "./task-manager.js";

const AG = (name: string) => ({ name, bin: "node", args: ["acp"], shell: false }) as never;

function deferred<T = string>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const has = (arr: string[], sub: string) => arr.some((p) => p.includes(sub));

let pushed: string[] = [];
let states: TaskStateSnapshot[] = [];
let acks: Array<{ id: string; text: string }> = [];
/** 每次 dispatch 都换一条新连接（除非用例自己设置 acquire 的返回值）。 */
let conns: ReturnType<typeof fakeConn>[] = [];
let tmpDir = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-tasks-"));
  resetTasksForTest(tmpDir);
  resetSlotsForTest();
  setSlotAgent("worker", AG("kiro"));
  // 显式 `agentKey`（`任务 <agent 名>：`）走的是真实 agent 解析 + 可用性预检：把用到的 agent 指向本机 node（不 spawn，池是 mock 的）
  fs.writeFileSync(
    path.join(tmpDir, "brain.json"),
    JSON.stringify({
      agent: "kiro",
      presets: {
        kiro: { bin: process.execPath, args: ["--acp"] },
        opencode: { bin: process.execPath, args: ["--acp"] },
        qoder: { bin: process.execPath, args: ["--acp"] },
      },
    }),
  );
  pushed = [];
  states = [];
  acks = [];
  conns = [];
  setTaskPush((_to, t) => pushed.push(t));
  setTaskStateSink((s) => states.push(s));
  setTaskAckSink((id, text) => acks.push({ id, text }));
  acquire.mockReset();
  release.mockReset();
  drop.mockReset();
  acquire.mockImplementation(async () => {
    const c = fakeConn();
    conns.push(c);
    return { ok: true, conn: c };
  });
});

afterEach(() => {
  for (const t of listTasks("u1")) stopTask("u1", t.id);
  resetTasksForTest();
  resetSlotsForTest();
  setTaskStateSink(() => {});
  setTaskPush(() => {});
  setTaskAckSink(() => {});
});

describe("task-manager 状态机（单任务：行为与改造前一致）", () => {
  it("派发 → 一轮推送【任务】→ waiting → 回话续跑 → stop", async () => {
    const r1 = deferred();
    const r2 = deferred();
    acquire.mockImplementationOnce(async () => {
      const c = fakeConn();
      conns.push(c);
      c.ask.mockReturnValueOnce(r1.promise).mockReturnValueOnce(r2.promise);
      return { ok: true, conn: c };
    });

    const ack = dispatchTask("u1", "做X");
    expect(ack).toContain("已派");
    expect(ack).not.toContain("#1"); // 单任务免编号：沿用改造前那句话
    await vi.waitFor(() => expect(hasActiveTask("u1")).toBe(true));
    const conn = conns[0];
    await vi.waitFor(() => expect(conn.ask).toHaveBeenCalledTimes(1));
    expect(conn.ask.mock.calls[0][0]).toBe("做X");

    r1.resolve("方案 A 还是 B？");
    await vi.waitFor(() => expect(has(pushed, "方案 A 还是 B？")).toBe(true));
    expect(has(pushed, "🤖【任务】")).toBe(true); // 来源标记
    await vi.waitFor(() => expect(awaitingTasks("u1").length).toBe(1)); // 推送后进入 waiting

    injectTask("u1", "选 A"); // waiting 态回话 → 第二轮
    await vi.waitFor(() => expect(conn.ask).toHaveBeenCalledTimes(2));
    expect(conn.ask.mock.calls[1][0]).toBe("选 A");

    r2.resolve("已完成");
    await vi.waitFor(() => expect(has(pushed, "已完成")).toBe(true));

    expect(stopTask("u1")).toContain("已结束");
    expect(hasActiveTask("u1")).toBe(false);
    expect(awaitingTasks("u1").length).toBe(0);
    await vi.waitFor(() => expect(release).toHaveBeenCalled()); // 连接留着复用（不是杀掉）
    expect(drop).not.toHaveBeenCalled();
  });

  it("中断 → 推送中断提示（含「继续」字样）", async () => {
    const r1 = deferred();
    acquire.mockImplementationOnce(async () => {
      const c = fakeConn();
      conns.push(c);
      c.ask.mockReturnValueOnce(r1.promise);
      return { ok: true, conn: c };
    });
    dispatchTask("u1", "重任务");
    await vi.waitFor(() => expect(conns[0]?.ask).toHaveBeenCalled());
    r1.reject(new Error("session/prompt idle timeout (idle=999ms total=999ms)"));
    await vi.waitFor(() => expect(has(pushed, "继续")).toBe(true));
    expect(has(pushed, "中断")).toBe(true);
    expect(has(pushed, "超时/卡住")).toBe(true);
    // 超时这类「等一下重试就好」的失败仍停在「等你回复」：无编号消息照样喂给它（老规矩，别顺手改掉）
    await vi.waitFor(() => expect(awaitingTasks("u1").length).toBe(1));
    expect(interruptedTasks("u1").length).toBe(0);
  });

  it("provider 报错（余额不足）→ 转「已中断」，不再抢下一条无编号消息；回「继续」能续跑", async () => {
    const r1 = deferred();
    const r2 = deferred();
    acquire.mockImplementationOnce(async () => {
      const c = fakeConn();
      conns.push(c);
      c.ask.mockReturnValueOnce(r1.promise).mockReturnValueOnce(r2.promise);
      return { ok: true, conn: c };
    });
    dispatchTask("u1", "做X");
    await vi.waitFor(() => expect(conns[0]?.ask).toHaveBeenCalledTimes(1));
    r1.reject(
      new Error(
        '{"code":-32603,"message":"Internal error: turn failed: Insufficient Balance (request_id: x)"}',
      ),
    );
    await vi.waitFor(() => expect(has(pushed, "额度/余额不足")).toBe(true));
    expect(has(pushed, "重试也不会好")).toBe(true);
    // 关键：不留在 waiting（否则下一条无编号消息会被它吞掉），而是「已中断」
    await vi.waitFor(() => expect(interruptedTasks("u1").map((t) => t.id)).toEqual([1]));
    expect(awaitingTasks("u1").length).toBe(0);
    // 任务列表的「最近输出」也要是这条中断说明（别留着上一轮的旧输出，让人以为它跑完了）
    expect(renderTaskList("u1")).toContain("额度/余额不足");
    expect(renderTaskList("u1")).toContain("已中断");

    // 显式「继续」→ 走续跑路径（strictResume），重新拉连接、带上「没跑完就中断了」的前缀
    const r = injectTask("u1", "继续");
    expect(r).toContain("正在按 #1 号任务续跑");
    await vi.waitFor(() => expect(conns.length).toBe(2));
    await vi.waitFor(() => expect(conns[1].ask).toHaveBeenCalledTimes(1));
    expect(String(conns[1].ask.mock.calls[0][0])).toContain("上一轮没跑完就中断了");
    expect(conns[1].ask.mock.calls[0][3]).toMatchObject({ strictResume: true });
    await vi.waitFor(() => expect(hasActiveTask("u1")).toBe(true));
  });

  it("providerIssue：认清账号类错误，限流与普通错误不认（宁可不误判）", () => {
    expect(providerIssue("Insufficient Balance (request_id: x)")).toBe("额度/余额不足");
    expect(providerIssue("requires more credits, or use a smaller max_tokens")).toBe(
      "额度/余额不足",
    );
    expect(providerIssue('no API key for provider route "deepseek-official"')).toBe(
      "密钥/鉴权有问题",
    );
    expect(providerIssue("402 Payment Required")).toBe("计费问题");
    expect(providerIssue("model_not_found: deepseek-xyz")).toBe("模型不可用");
    expect(providerIssue("429 Too Many Requests / rate limit")).toBeNull();
    expect(providerIssue("session/prompt idle timeout (idle=999ms)")).toBeNull();
    expect(providerIssue("fetch failed")).toBeNull();

    // 各家 provider 的真实措辞（2026-10-29 评审补的样本）
    expect(providerIssue("Your credit balance is too low to access the API")).toBe("额度/余额不足");
    expect(providerIssue("Authentication required.")).toBe("密钥/鉴权有问题"); // Qoder 实测原文（见 docs/接入-Qoder.md）
    expect(providerIssue("models/gemini-2.0-flash is not found for API version v1beta")).toBe(
      "模型不可用",
    );
    expect(providerIssue("The model `gpt-5.5` does not exist")).toBe("模型不可用");
    expect(providerIssue('{"error":{"code":402,"message":"Insufficient balance"}}')).toBe(
      "额度/余额不足",
    );
    expect(providerIssue('{"code":402,"message":"upstream rejected"}')).toBe("计费问题"); // 只认 JSON 里的 code，裸数字不行
    expect(providerIssue("write failed: E:\\tmp\\402-report.txt")).toBeNull(); // 裸 402 可能是路径/行号，不能当计费
    // 限流优先：Google 按分钟 429 与 Anthropic 过载都带「quota/credits」味道的字样，仍必须不归类
    expect(
      providerIssue(
        "Quota exceeded for quota metric 'GenerateContentRequestsPerMinutePerProjectPerUser' and limit 'Generate requests per minute' of service 'generativelanguage.googleapis.com'",
      ),
    ).toBeNull();
    expect(providerIssue("429 RESOURCE_EXHAUSTED: quota exceeded for this project")).toBeNull();
    expect(providerIssue("Overloaded")).toBeNull();
    // OpenAI 的余额耗尽虽然也是 HTTP 429，但文案是计费语义 → 仍要归类
    expect(
      providerIssue(
        "429 You exceeded your current quota, please check your plan and billing details",
      ),
    ).toBe("额度/余额不足");
  });

  it("running 期间多次回话全部保留（按序累积，下一轮一并消费）", async () => {
    const r1 = deferred();
    const r2 = deferred();
    acquire.mockImplementationOnce(async () => {
      const c = fakeConn();
      conns.push(c);
      c.ask.mockReturnValueOnce(r1.promise).mockReturnValueOnce(r2.promise);
      return { ok: true, conn: c };
    });
    dispatchTask("u1", "任务");
    await vi.waitFor(() => expect(conns[0]?.ask).toHaveBeenCalledTimes(1));
    expect(awaitingTasks("u1").length).toBe(0); // running 中不算 waiting
    injectTask("u1", "顺便做Y");
    injectTask("u1", "还有Z");
    expect(has(pushed, "已记下")).toBe(true);

    r1.resolve("第一轮完成");
    await vi.waitFor(() => expect(conns[0].ask).toHaveBeenCalledTimes(2));
    expect(conns[0].ask.mock.calls[1][0]).toBe("顺便做Y\n还有Z"); // 一条不丢
    r2.resolve("done");
    await vi.waitFor(() => expect(has(pushed, "done")).toBe(true));
  });

  it("cwd 透传给连接；状态写入磁盘回调 走 running→waiting→idle，且记录带 tasks 数组", async () => {
    const r1 = deferred();
    acquire.mockImplementationOnce(async () => {
      const c = fakeConn();
      conns.push(c);
      c.ask.mockReturnValueOnce(r1.promise);
      return { ok: true, conn: c };
    });
    dispatchTask("u1", "做X", { cwd: "D:\\proj" });
    await vi.waitFor(() => expect(conns[0]?.ask).toHaveBeenCalled());
    expect(conns[0].cwd).toBe("D:\\proj"); // cwd 透传
    await vi.waitFor(() => expect(states.some((s) => s.status === "running")).toBe(true));
    r1.resolve("问你选 A 还是 B");
    await vi.waitFor(() => expect(states.some((s) => s.status === "waiting")).toBe(true));
    const snap = states[states.length - 1];
    expect(snap.tasks.length).toBe(1);
    expect(snap.tasks[0]).toMatchObject({ id: 1, agent: "kiro", status: "waiting", turns: 1 });
    expect(stopTask("u1")).toContain("已结束");
    await vi.waitFor(() => expect(states[states.length - 1].status).toBe("idle"));
  });
});

describe("多任务与编号", () => {
  it("可并行派发多条：编号递增、答复带编号、按编号发话互不串台", async () => {
    const a1 = deferred();
    const a2 = deferred();
    acquire
      .mockImplementationOnce(async () => {
        const c = fakeConn("kiro");
        conns.push(c);
        c.ask.mockReturnValueOnce(a1.promise);
        return { ok: true, conn: c };
      })
      .mockImplementationOnce(async () => {
        const c = fakeConn("opencode");
        conns.push(c);
        c.ask.mockReturnValueOnce(a2.promise);
        return { ok: true, conn: c };
      });

    const ack1 = dispatchTask("u1", "任务甲", { agentKey: "kiro" });
    expect(ack1).toContain("#1");
    const ack2 = dispatchTask("u1", "任务乙", { agentKey: "opencode" });
    expect(ack2).toContain("#2");
    await vi.waitFor(() => expect(conns.length).toBe(2));
    expect(listTasks("u1").map((t) => t.id)).toEqual([1, 2]);
    expect(listTasks("u1").map((t) => t.agent)).toEqual(["kiro", "opencode"]);

    a1.resolve("甲第一轮");
    a2.resolve("乙第一轮");
    await vi.waitFor(() => expect(has(pushed, "乙第一轮")).toBe(true));
    expect(has(pushed, "🤖【任务1】")).toBe(true); // 多条任务时带编号
    expect(has(pushed, "🤖【任务2】")).toBe(true);

    await vi.waitFor(() => expect(awaitingTasks("u1").length).toBe(2));
    // 两条都在等 → 无编号时必须回编号提示（不猜）
    const dis = injectTask("u1", "随便说点什么");
    expect(dis).toContain("2 条任务");
    expect(dis).toContain("#1");
    expect(dis).toContain("#2");
    // 指定编号 → 只喂那一条
    injectTask("u1", "只回给乙", 2);
    await vi.waitFor(() => expect(conns[1].ask).toHaveBeenCalledTimes(2));
    expect(conns[1].ask.mock.calls[1][0]).toBe("只回给乙");
    expect(conns[0].ask).toHaveBeenCalledTimes(1); // 甲没被动过
  });

  it("一条 running + 一条 waiting：无编号消息喂给在等的那条（谁在等就喂谁）", async () => {
    const a1 = deferred();
    const a2 = deferred();
    acquire
      .mockImplementationOnce(async () => {
        const c = fakeConn("kiro");
        conns.push(c);
        c.ask.mockReturnValueOnce(a1.promise).mockReturnValueOnce(deferred().promise);
        return { ok: true, conn: c };
      })
      .mockImplementationOnce(async () => {
        const c = fakeConn("opencode");
        conns.push(c);
        c.ask.mockReturnValueOnce(a2.promise);
        return { ok: true, conn: c };
      });
    dispatchTask("u1", "甲", { agentKey: "kiro" });
    dispatchTask("u1", "乙", { agentKey: "opencode" });
    await vi.waitFor(() => expect(conns.length).toBe(2));
    a1.resolve("甲暂停，等你回话");
    await vi.waitFor(() => expect(awaitingTasks("u1").length).toBe(1)); // 甲 waiting，乙还在跑
    expect(injectTask("u1", "回给甲")).toBe("");
    await vi.waitFor(() => expect(conns[0].ask).toHaveBeenCalledTimes(2));
    expect(conns[0].ask.mock.calls[1][0]).toBe("回给甲");
  });

  it("结束指定编号只停那条；其它照跑", async () => {
    const a1 = deferred();
    acquire
      .mockImplementationOnce(async () => {
        const c = fakeConn("kiro");
        conns.push(c);
        c.ask.mockReturnValueOnce(a1.promise).mockReturnValueOnce(deferred().promise);
        return { ok: true, conn: c };
      })
      .mockImplementationOnce(async () => {
        const c = fakeConn("opencode");
        conns.push(c);
        c.ask.mockReturnValueOnce(deferred().promise);
        return { ok: true, conn: c };
      });
    dispatchTask("u1", "甲", { agentKey: "kiro" });
    dispatchTask("u1", "乙", { agentKey: "opencode" });
    await vi.waitFor(() => expect(conns.length).toBe(2));

    a1.resolve("甲第一轮");
    await vi.waitFor(() => expect(awaitingTasks("u1").length).toBe(1));
    const r = stopTask("u1", 1); // 甲在 waiting → 连接留着复用；乙仍在跑
    expect(r).toContain("#1");
    await vi.waitFor(() => expect(release).toHaveBeenCalled());
    expect(drop).not.toHaveBeenCalled();
    expect(listTasks("u1").map((t) => t.id)).toEqual([2]);
    expect(hasActiveTask("u1")).toBe(true);
  });

  it("结束正在跑的那条 → 杀掉它的连接（不是留着复用）；结束全部 → 两条都收", async () => {
    acquire
      .mockImplementationOnce(async () => {
        const c = fakeConn("kiro");
        conns.push(c);
        c.ask.mockReturnValueOnce(deferred().promise); // 一直 running（不 resolve）
        return { ok: true, conn: c };
      })
      .mockImplementationOnce(async () => {
        const c = fakeConn("opencode");
        conns.push(c);
        c.ask.mockReturnValueOnce(deferred().promise);
        return { ok: true, conn: c };
      });
    dispatchTask("u1", "甲", { agentKey: "kiro" });
    dispatchTask("u1", "乙", { agentKey: "opencode" });
    await vi.waitFor(() => expect(conns.length).toBe(2));

    stopTask("u1", 1);
    await vi.waitFor(() => expect(drop).toHaveBeenCalledTimes(1)); // 正在跑的：只能杀
    expect(stopTask("u1", "all")).toContain("全部");
    await vi.waitFor(() => expect(drop).toHaveBeenCalledTimes(2));
    expect(hasActiveTask("u1")).toBe(false);
  });

  it("无编号「结束任务」在多任务时拒绝并列出编号（不猜）", async () => {
    acquire.mockImplementation(async () => {
      const c = fakeConn();
      conns.push(c);
      c.ask.mockReturnValueOnce(deferred().promise);
      return { ok: true, conn: c };
    });
    dispatchTask("u1", "甲");
    dispatchTask("u1", "乙");
    await vi.waitFor(() => expect(conns.length).toBe(2));
    const r = stopTask("u1");
    expect(r).toContain("指明编号");
    expect(r).toContain("#1");
    expect(hasActiveTask("u1")).toBe(true);
  });

  it("池拒绝派发（并发上限）：如实回话，任务不留在表里", async () => {
    acquire.mockImplementationOnce(async () => ({
      ok: false,
      problem: "同时运行的任务数已达上限（3 个）",
    }));
    const ack = dispatchTask("u1", "做X");
    expect(ack).toContain("已派"); // 答复先发（编号已分配，之后才有结果）
    await vi.waitFor(() => expect(has(pushed, "已达上限")).toBe(true));
    expect(hasActiveTask("u1")).toBe(false);
    expect(listTasks("u1").length).toBe(0);
  });

  it("任务列表：编号/agent/状态/轮次/最近输出", async () => {
    const a1 = deferred();
    acquire.mockImplementationOnce(async () => {
      const c = fakeConn("qoder");
      conns.push(c);
      c.ask.mockReturnValueOnce(a1.promise);
      return { ok: true, conn: c };
    });
    dispatchTask("u1", "做X", { agentKey: "qoder" });
    await vi.waitFor(() => expect(conns[0]?.ask).toHaveBeenCalled());
    a1.resolve("我先问你一件事");
    await vi.waitFor(() => expect(awaitingTasks("u1").length).toBe(1));
    const list = renderTaskList("u1");
    expect(list).toContain("#1");
    expect(list).toContain("[qoder]");
    expect(list).toContain("等你回复");
    expect(list).toContain("1 轮");
    expect(list).toContain("我先问你一件事");
  });

  it("指定 agent 只影响本条任务：不改默认任务大脑（worker 槽位保持 kiro）", async () => {
    dispatchTask("u1", "这条用 opencode", { agentKey: "opencode" });
    await vi.waitFor(() => expect(conns[0]?.ask).toHaveBeenCalled());
    expect(listTasks("u1")[0]?.agent).toBe("opencode");
    expect(getAgent("worker").name).toBe("kiro"); // 回归护栏：`任务 <agent 名>：` 不再顺带改进程内默认
  });
});

describe("任务表写入磁盘与重启续跑", () => {
  it("重启后未完成的标「已中断」，编号接着排不归零；回「继续」才拉进程续跑（strictResume）", async () => {
    // 模拟上次运行留下的一条 running 任务
    fs.writeFileSync(
      path.join(tmpDir, "tasks.json"),
      JSON.stringify({
        version: 1,
        nextId: { u1: 8 },
        tasks: [
          {
            id: 7,
            userId: "u1",
            agent: "kiro",
            key: "task-7@u1",
            status: "running",
            turns: 3,
            startedAt: Date.now() - 60_000,
          },
        ],
      }),
    );
    const out = initTasks(tmpDir);
    expect(out.interrupted).toEqual([7]);
    expect(listTasks("u1")[0].status).toBe("interrupted");
    expect(renderTaskList("u1")).toContain("已中断");
    expect(hasActiveTask("u1")).toBe(false); // 不自动恢复

    // 新任务接着 8 号（不复用 7）
    acquire.mockImplementationOnce(async () => {
      const c = fakeConn();
      conns.push(c);
      c.ask.mockReturnValueOnce(deferred().promise);
      return { ok: true, conn: c };
    });
    expect(dispatchTask("u1", "新活")).toContain("#8");

    // 回「继续」→ 续跑 7 号：拉进程 + strictResume（要求上下文真的接上）
    const resumed = deferred();
    acquire.mockImplementationOnce(async () => {
      const c = fakeConn("kiro");
      conns.push(c);
      c.ask.mockReturnValueOnce(resumed.promise);
      return { ok: true, conn: c };
    });
    const r7 = injectTask("u1", "继续", 7);
    await vi.waitFor(() => expect(conns.length).toBe(2));
    const conn7 = conns[1];
    await vi.waitFor(() => expect(conn7.ask).toHaveBeenCalledTimes(1));
    expect(conn7.ask.mock.calls[0][1]).toBe("task-7@u1"); // 沿用原会话键
    expect(conn7.ask.mock.calls[0][3]).toEqual({ strictResume: true });
    expect(conn7.ask.mock.calls[0][0]).toContain("中断");
    // 续跑提示走**返回值**（微信侧把它当答复发出去、CLI 侧当答复收下），不再只 push
    expect(r7).toContain("正在按 #7 号任务续跑");
    // 续跑里的 agent 已被确认为「kiro」
    expect(listTasks("u1").find((t) => t.id === 7)?.ag?.name).toBe("kiro");
    resumed.resolve("接着干");
    await vi.waitFor(() => expect(has(pushed, "接着干")).toBe(true));
  });

  it("无编号「继续」也能续跑（微信侧走的就是这条路）；日常提问不会被陈旧的中断任务吞掉", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "tasks.json"),
      JSON.stringify({
        version: 1,
        nextId: { u1: 2 },
        tasks: [
          {
            id: 1,
            userId: "u1",
            agent: "kiro",
            key: "task-1@u1",
            status: "running",
            turns: 1,
            startedAt: Date.now() - 1000,
          },
        ],
      }),
    );
    initTasks(tmpDir);
    expect(interruptedTasks("u1").map((t) => t.id)).toEqual([1]);

    // index.ts 那层关键字闸：只有「继续」这类短句放行给任务表，别的照常走大脑
    expect(looksLikeResume("继续")).toBe(true);
    expect(looksLikeResume(" 接着跑！")).toBe(true);
    expect(looksLikeResume("帮我看看这个报错")).toBe(false);
    expect(looksLikeResume("继续写个脚本")).toBe(false);
    expect(looksLikeResume(undefined)).toBe(false);

    // 放行 → 无编号也能续跑：injectTask 内部按「0 条在跑 + 1 条已中断」选中它
    const resumed = deferred();
    acquire.mockImplementationOnce(async () => {
      const c = fakeConn("kiro");
      conns.push(c);
      c.ask.mockReturnValueOnce(resumed.promise);
      return { ok: true, conn: c };
    });
    expect(injectTask("u1", "继续")).toContain("正在按 #1 号任务续跑"); // 续跑提示即答复（两个入口共用）
    await vi.waitFor(() => expect(conns.length).toBe(1));
    expect(conns[0].ask.mock.calls[0][1]).toBe("task-1@u1"); // 沿用原会话键
    expect(conns[0].ask.mock.calls[0][3]).toEqual({ strictResume: true });
    resumed.resolve("done");
    await vi.waitFor(() => expect(has(pushed, "done")).toBe(true));
  });

  it("续跑接不上（会话没了）→ 回到「已中断」并如实报错，不假装续上", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "tasks.json"),
      JSON.stringify({
        version: 1,
        nextId: { u1: 2 },
        tasks: [
          {
            id: 1,
            userId: "u1",
            agent: "kiro",
            key: "task-1@u1",
            status: "waiting",
            turns: 1,
            startedAt: 1,
          },
        ],
      }),
    );
    initTasks(tmpDir);
    acquire.mockImplementationOnce(async () => {
      const c = fakeConn();
      conns.push(c);
      c.ask.mockReturnValueOnce(
        Promise.reject(
          new Error(
            "接不上原会话 sess-old（该 agent 不支持恢复、或这条会话已被它自己清理）。重试还是同一个结果——想重来请结束这条任务后重新派一条（把进展写进新任务里）。",
          ),
        ),
      );
      return { ok: true, conn: c };
    });
    injectTask("u1", "继续");
    await vi.waitFor(() => expect(has(pushed, "这次接不上")).toBe(true));
    expect(listTasks("u1")[0].status).toBe("interrupted"); // 回到可重试状态
    expect(hasActiveTask("u1")).toBe(false);
    expect(has(pushed, "结束任务 1")).toBe(true); // 给出真正的出路，而不是劝「重述一遍」
    // 会话映射保留（登记/当前会话不动）：接不上是 agent 侧的会话没了，不是要伪造一次恢复
    expect(conns[0].sessions).toEqual([]);
  });

  it("续跑时进程起不来（agent 不可用/池满）→ 不删任务记录，仍留在「已中断」里可再试", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "tasks.json"),
      JSON.stringify({
        version: 1,
        nextId: { u1: 2 },
        tasks: [
          {
            id: 1,
            userId: "u1",
            agent: "kiro",
            key: "task-1@u1",
            status: "interrupted",
            turns: 1,
            startedAt: 1,
          },
        ],
      }),
    );
    initTasks(tmpDir);
    acquire.mockImplementationOnce(async () => ({ ok: false, problem: "已达并发上限（3）" }));
    injectTask("u1", "继续");
    await vi.waitFor(() => expect(has(pushed, "没起得来")).toBe(true));
    // 关键：记录还在（新派发起不来才该删——用户是照着「修好后回继续」来的，删掉等于把承诺作废）
    expect(listTasks("u1").map((t) => t.id)).toEqual([1]);
    expect(interruptedTasks("u1").map((t) => t.id)).toEqual([1]);
    expect(has(pushed, "任务记录还在")).toBe(true);
    expect(renderTaskList("u1")).toContain("没起得来"); // 最近输出说清为什么没动
  });

  it("「结束任务 <编号>」可清掉已中断任务的记录（不再占着编号）", () => {
    fs.writeFileSync(
      path.join(tmpDir, "tasks.json"),
      JSON.stringify({
        version: 1,
        nextId: { u1: 3 },
        tasks: [
          {
            id: 2,
            userId: "u1",
            agent: "kiro",
            key: "task-2@u1",
            status: "running",
            turns: 0,
            startedAt: 1,
          },
        ],
      }),
    );
    initTasks(tmpDir);
    expect(stopTask("u1", 2)).toContain("清掉");
    expect(listTasks("u1").length).toBe(0);
    // 清理已落到磁盘：重新读回表里没有它
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, "tasks.json"), "utf-8"));
    expect(onDisk.tasks).toEqual([]);
  });
});

/**
 * CLI 侧的答复：`wemind task` 这类命令丢完命令就再也看不见结果，于是只能自己编「已派发」——
 * 达上限被拒、agent 起不来都会被报成成功（甚至报成上一条任务的编号，因为 `active` 本来就是 true）。
 * 这里钉死「答复等起进程有结果」「失败答复就是失败」。
 */
describe("本地命令的答复（daemon 说了才算）", () => {
  it("派发成功：**起进程之后**才答复「已派发 #1」", async () => {
    const r = dispatchTask("u1", "做X", { agentKey: "kiro", ackId: "ack-1" });
    expect(r).toContain("已派发任务 #1"); // dispatchTask 当场返回的文案仍给微信侧用
    expect(acks.length).toBe(0); // 进程还没起来 → 还不能说「派上了」
    await vi.waitFor(() => expect(acks.length).toBe(1));
    expect(acks[0].id).toBe("ack-1");
    expect(acks[0].text).toContain("已派发任务 #1");
    expect(acks[0].text).toContain("kiro");
  });

  it("达上限被拒：答复是那句警告（不是「已派发」），任务也不留在表里", async () => {
    acquire.mockImplementationOnce(async () => ({
      ok: false,
      problem:
        "同时运行的任务数已达上限（2 个）。等一个跑完，或先「结束任务 <编号>」收掉不再需要的。",
    }));
    dispatchTask("u1", "做X", { agentKey: "kiro", ackId: "ack-2" });
    await vi.waitFor(() => expect(acks.length).toBe(1));
    expect(acks[0].text).toContain("没起得来");
    expect(acks[0].text).toContain("上限");
    expect(acks[0].text).not.toContain("已派发");
    expect(listTasks("u1").length).toBe(0);
  });

  it("正文为空 / agent 用不了：当场答复，不派也不占编号", () => {
    dispatchTask("u1", "   ", { ackId: "ack-3" });
    expect(acks[0].text).toContain("空");
    dispatchTask("u1", "做X", { agentKey: "不存在的 agent", ackId: "ack-4" });
    expect(acks[1].text.startsWith("❌")).toBe(true);
    expect(listTasks("u1").length).toBe(0);
  });

  it("回复：编号不存在 → 答复带上那句「没有 #9 号任务」（原先只进 daemon 日志）", () => {
    expect(injectTask("u1", "继续", 9, "ack-5")).toContain("没有 #9 号任务");
    expect(acks[0]).toEqual({ id: "ack-5", text: "没有 #9 号任务。发「任务列表」看现有编号。" });
  });

  it("回复成功（送进 waiting 的任务）：答复是空文案——CLI 据此**立刻**用自己的措辞，不干等超时", async () => {
    const r1 = deferred();
    acquire.mockImplementationOnce(async () => {
      const c = fakeConn();
      conns.push(c);
      c.ask.mockReturnValueOnce(r1.promise).mockReturnValueOnce(deferred().promise);
      return { ok: true, conn: c };
    });
    dispatchTask("u1", "做X", { ackId: "ack-6" });
    await vi.waitFor(() => expect(conns.length).toBe(1));
    r1.resolve("问完了");
    await vi.waitFor(() => expect(awaitingTasks("u1").length).toBe(1));
    acks = [];
    expect(injectTask("u1", "按 B 做", undefined, "ack-7")).toBe("");
    expect(acks).toEqual([{ id: "ack-7", text: "" }]); // 空文案＝「已送达，无别的话」；不写空行、不让人干等
  });

  it("结束：答复就是 daemon 的真实结果（含「没有 #9 号在跑的任务」这类否定答案）", () => {
    expect(stopTask("u1", 9, "ack-8")).toContain("没有 #9 号在跑的任务");
    expect(acks[0].text).toContain("没有 #9 号在跑的任务");
  });

  it("没有 ackId 时一切照旧（微信侧指令本来就有自己的答复）", () => {
    expect(dispatchTask("u1", "做X")).toContain("已派");
    expect(injectTask("u1", "继续", 9)).toContain("没有 #9 号任务");
    expect(stopTask("u1", 9)).toContain("没有 #9 号在跑的任务");
    expect(acks).toEqual([]);
  });
});
