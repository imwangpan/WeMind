import { describe, expect, it } from "vitest";

import { MessageState } from "@wemind/wechat-ilink-core";
import { PendingPushes } from "./pending-push.js";
import { SendPipeline, type SendPipelineDeps } from "./send-pipeline.js";

class ParamError extends Error {}

type Harness = {
  pipeline: SendPipeline;
  sent: Array<{ to: string; text: string; state: number; ctx?: string; at: number }>;
  files: Array<{ to: string; text: string }>;
  images: Array<{ to: string; bytes: Buffer }>;
  errors: unknown[];
  logs: string[];
  advanced: () => number;
  setSendText: (fn: SendPipelineDeps["sendText"]) => void;
  setSendFile: (fn: SendPipelineDeps["sendFileMd"]) => void;
};

function harness(overrides: Partial<SendPipelineDeps> = {}): Harness {
  let now = 1000;
  const sent: Harness["sent"] = [];
  const files: Harness["files"] = [];
  const images: Harness["images"] = [];
  const errors: unknown[] = [];
  const logs: string[] = [];
  let sendText: SendPipelineDeps["sendText"] = async (to, ctx, text, state) => {
    sent.push({ to, text, state, ctx, at: now });
  };
  let sendFileMd: SendPipelineDeps["sendFileMd"] = async (to, _ctx, text) => {
    files.push({ to, text });
  };
  const pipeline = new SendPipeline({
    sendText: (to, ctx, text, state, fallbackToken) =>
      sendText(to, ctx, text, state, fallbackToken),
    sendImage: async (to, _ctx, bytes) => {
      images.push({ to, bytes });
    },
    sendFileMd: (to, ctx, text) => sendFileMd(to, ctx, text),
    onSendError: (e) => errors.push(e),
    isParamError: (e) => e instanceof ParamError,
    log: (...args) => logs.push(args.map(String).join(" ")),
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    minGapMs: 100,
    consecLimit: 10,
    pendingBatch: 2,
    pending: new PendingPushes(20),
    ...overrides,
  });
  return {
    pipeline,
    sent,
    files,
    images,
    errors,
    logs,
    advanced: () => now,
    setSendText: (fn) => {
      sendText = fn;
    },
    setSendFile: (fn) => {
      sendFileMd = fn;
    },
  };
}

describe("SendPipeline：串行发送与节流", () => {
  it("按入队顺序发送，且两条之间有最小间隔", async () => {
    const h = harness();
    h.pipeline.sendOrdered("u1", "ctx", "一");
    h.pipeline.sendOrdered("u1", "ctx", "二");
    await h.pipeline.sendOrdered("u1", "ctx", "三");
    expect(h.sent.map((s) => s.text)).toEqual(["一", "二", "三"]);
    expect(h.sent.map((s) => s.at)).toEqual([1000, 1100, 1200]);
  });

  it("一次发送失败不会卡死后续消息", async () => {
    const h = harness();
    h.setSendText(async (to, ctx, text, state) => {
      if (text === "坏") throw new Error("boom");
      h.sent.push({ to, text, state, ctx, at: h.advanced() });
    });
    await h.pipeline.sendOrdered("u1", "ctx", "坏", MessageState.FINISH, undefined, () => {});
    await h.pipeline.sendOrdered("u1", "ctx", "好");
    expect(h.errors).toHaveLength(1);
    expect(h.sent.map((s) => s.text)).toEqual(["好"]);
  });
});

describe("SendPipeline：连发预算", () => {
  it("sendNotice 先计额度，普通发送不计", async () => {
    const h = harness();
    await h.pipeline.sendOrdered("u1", "ctx", "进度", MessageState.GENERATING);
    expect(h.pipeline.budgetOf("u1").count).toBe(0);
    await h.pipeline.sendNotice("u1", "ctx", "答复");
    expect(h.pipeline.budgetOf("u1").count).toBe(1);
  });

  it("在途发送计入 inflight，落定后归零（用户发消息时据此计算新窗口已占额度）", async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    h.setSendText(async (to, ctx, text, state) => {
      await gate;
      h.sent.push({ to, text, state, ctx, at: h.advanced() });
    });
    const sending = h.pipeline.sendOrdered("u1", "ctx", "在途");
    await Promise.resolve();
    expect(h.pipeline.inflightCount("u1")).toBe(1);
    release();
    await sending;
    expect(h.pipeline.inflightCount("u1")).toBe(0);
  });
});

describe("SendPipeline：旧 token 挂起与补发", () => {
  it("未收到过该用户消息时的 -2 挂起；收到过之后不再挂起", async () => {
    const h = harness();
    h.setSendText(async () => {
      throw new ParamError("ret=-2");
    });
    await h.pipeline.sendNotice("old", "ctx", "旧 token");
    expect(h.pipeline.pendingCount("old")).toBe(1);

    h.pipeline.markFresh("new");
    await h.pipeline.sendNotice("new", "ctx", "限流");
    expect(h.pipeline.pendingCount("new")).toBe(0);
  });

  it("新 token 补发受单轮批量与额度双重限制，剩下的留给后续消息", async () => {
    const h = harness();
    for (const t of ["1", "2", "3", "4", "5"])
      h.pipeline.holdUndelivered("u1", t, new ParamError());
    h.pipeline.flushHeldPushes("u1", "new-token");
    await h.pipeline.idle();
    expect(h.sent.map((s) => s.text)).toEqual(["1", "2"]);
    expect(h.sent.every((s) => s.ctx === "new-token")).toBe(true);
    expect(h.pipeline.budgetOf("u1").count).toBe(2);
    expect(h.pipeline.pendingCount("u1")).toBe(3);
  });

  it("留给最终答案的两条额度不够时，一条都不补发", async () => {
    const h = harness();
    h.pipeline.holdUndelivered("u1", "x", new ParamError());
    h.pipeline.budgetOf("u1").count = 8;
    h.pipeline.flushHeldPushes("u1", "new-token");
    await h.pipeline.idle();
    expect(h.sent).toHaveLength(0);
    expect(h.pipeline.pendingCount("u1")).toBe(1);
  });

  it("补发失败重新挂起，试满 3 次后放弃", async () => {
    const h = harness();
    h.setSendText(async () => {
      throw new ParamError("still bad");
    });
    h.pipeline.holdUndelivered("u1", "x", new ParamError());
    for (let i = 0; i < 3; i++) {
      h.pipeline.flushHeldPushes("u1", "new-token");
      await h.pipeline.idle();
    }
    expect(h.pipeline.pendingCount("u1")).toBe(0);
    expect(h.logs.some((l) => l.includes("放弃这条挂起的推送"))).toBe(true);
  });
});

describe("SendPipeline：任务推送让位", () => {
  it("回合结束后还有额度就立刻补发", async () => {
    const h = harness();
    h.pipeline.deferTaskPush("u1", "任务结果");
    h.pipeline.budgetOf("u1").count = 8;
    h.pipeline.flushDeferredTaskPushes("u1", "tok", false);
    await h.pipeline.idle();
    expect(h.sent.map((s) => s.text)).toEqual(["任务结果"]);
    expect(h.pipeline.budgetOf("u1").count).toBe(9);
  });

  it("没有额度或最终答案失败时转挂起，等用户下一条消息", async () => {
    const h = harness();
    h.pipeline.deferTaskPush("u1", "a");
    h.pipeline.deferTaskPush("u1", "b");
    h.pipeline.budgetOf("u1").count = 9;
    h.pipeline.flushDeferredTaskPushes("u1", "tok", false);
    await h.pipeline.idle();
    expect(h.sent.map((s) => s.text)).toEqual(["a"]);
    expect(h.pipeline.pendingCount("u1")).toBe(1);

    h.pipeline.deferTaskPush("u2", "c");
    h.pipeline.flushDeferredTaskPushes("u2", "tok", true);
    expect(h.pipeline.pendingCount("u2")).toBe(1);
    expect(h.pipeline.pendingCount("u2") + h.pipeline.pendingCount("u1")).toBe(2);
  });
});

describe("SendPipeline：图片与 .md", () => {
  it("图片发送失败返回 false 并交给错误处理器", async () => {
    const h = harness({
      sendImage: async () => {
        throw new Error("upload failed");
      },
    });
    await expect(h.pipeline.sendImageOrdered("u1", "ctx", Buffer.from("x"))).resolves.toBe(false);
    expect(h.errors).toHaveLength(1);
  });

  it(".md 发送失败回退为文本", async () => {
    const h = harness();
    h.setSendFile(async () => {
      throw new Error("file failed");
    });
    await h.pipeline.sendMdOrdered("u1", "ctx", "长回复");
    expect(h.sent.map((s) => s.text)).toEqual(["长回复"]);
    expect(h.logs.some((l) => l.includes("fallback to text"))).toBe(true);
  });
});
