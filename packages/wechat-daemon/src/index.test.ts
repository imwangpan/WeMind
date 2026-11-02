import { describe, it, expect } from "vitest";

import {
  brainErrorMessage,
  brainFailurePlan,
  isFastLane,
  parseBrainEscape,
  parseControl,
  parseTaskControl,
} from "./index.js";

describe("parseControl（daemon 直接处理的控制指令）", () => {
  it("列出 mcp", () => {
    expect(parseControl("mcp")).toEqual({ kind: "list" });
    expect(parseControl("/mcp")).toEqual({ kind: "list" });
    expect(parseControl("列出 mcp")).toEqual({ kind: "list" });
    expect(parseControl("mcp list")).toEqual({ kind: "list" });
  });

  it("新会话", () => {
    expect(parseControl("新会话")).toEqual({ kind: "new" });
    expect(parseControl("重置")).toEqual({ kind: "new" });
    expect(parseControl("清空上下文")).toEqual({ kind: "new" });
    expect(parseControl("/new")).toEqual({ kind: "new" });
  });

  it("加载/卸载 mcp", () => {
    expect(parseControl("加载 foo")).toEqual({ kind: "add", name: "foo" });
    expect(parseControl("load bar")).toEqual({ kind: "add", name: "bar" });
    expect(parseControl("卸载 foo")).toEqual({ kind: "remove", name: "foo" });
    expect(parseControl("unload baz")).toEqual({ kind: "remove", name: "baz" });
  });

  it("普通对话 → null（不拦截）", () => {
    expect(parseControl("你好")).toBeNull();
    expect(parseControl("帮我写个脚本")).toBeNull();
    expect(parseControl("mcp 是什么")).toBeNull();
  });
});

describe("parseTaskControl（明确发给 worker 的指令）", () => {
  it("停止任务", () => {
    expect(parseTaskControl("结束任务")).toEqual({ kind: "stop" });
    expect(parseTaskControl("停止任务")).toEqual({ kind: "stop" });
    expect(parseTaskControl("/stop")).toEqual({ kind: "stop" });
  });

  it("任务：xxx → toWorker", () => {
    expect(parseTaskControl("任务：写个脚本")).toEqual({ kind: "toWorker", text: "写个脚本" });
    expect(parseTaskControl("task: do it")).toEqual({ kind: "toWorker", text: "do it" });
  });

  it("> 快捷别名 → toWorker", () => {
    expect(parseTaskControl("> 继续干")).toEqual({ kind: "toWorker", text: "继续干" });
  });

  it("普通对话 → null", () => {
    expect(parseTaskControl("你好")).toBeNull();
    expect(parseTaskControl("任务很重要")).toBeNull();
  });
});

describe("parseBrainEscape（强制走大脑的逃逸前缀）", () => {
  it("问大脑 前缀", () => {
    expect(parseBrainEscape("问大脑 今天天气如何")).toBe("今天天气如何");
    expect(parseBrainEscape("问大脑：你好")).toBe("你好");
  });

  it("无前缀 → null", () => {
    expect(parseBrainEscape("普通消息")).toBeNull();
    expect(parseBrainEscape("我想问大脑一个问题")).toBeNull();
  });
});

describe("brainFailurePlan / brainErrorMessage（大脑失败的处置）", () => {
  it("provider 侧永久错误只试 1 次（余额/密钥/模型），并把原因说给用户", () => {
    const bal = new Error("Internal error: turn failed: Insufficient Balance (request_id: x)");
    expect(brainFailurePlan(bal)).toEqual({ attemptLimit: 1, category: "provider：额度/余额不足" });
    expect(brainErrorMessage(bal)).toMatch(/额度\/余额不足/);
    expect(brainErrorMessage(bal)).toMatch(/重试不会好/); // 别再让用户「稍后重发」白等

    const key = new Error('-32603 ... no API key for provider route "deepseek-official"');
    expect(brainFailurePlan(key)).toEqual({
      attemptLimit: 1,
      category: "provider：密钥/鉴权有问题",
    });
    expect(brainErrorMessage(key)).toMatch(/密钥\/鉴权有问题/);
    expect(brainErrorMessage(key)).toMatch(/重启一次 daemon/); // 本地改登录态/模型后必须重启才生效
    expect(brainErrorMessage(bal)).not.toMatch(/重启/); // 余额在 provider 侧处理，重发即可

    const model = new Error("model_not_found: deepseek-xyz");
    expect(brainFailurePlan(model)).toEqual({ attemptLimit: 1, category: "provider：模型不可用" });
  });

  it("Cline 的认证失败给环境变量建议，而不是「重启就好」", () => {
    const auth = new Error(
      "-32000 Authentication required: Call authenticate before starting a session",
    );
    expect(brainFailurePlan(auth)).toEqual({
      attemptLimit: 1,
      category: "provider：密钥/鉴权有问题",
    });
    const msg = brainErrorMessage(auth, "cline");
    expect(msg).toMatch(/CLINE_PROVIDER/);
    expect(msg).toMatch(/CLINE_API_KEY/);
    expect(msg).not.toMatch(/wemind stop && wemind start/); // 通用建议被 agent 专属提示顶掉
    // 不传 agent 名时沿用通用文案（其它调用方/旧测试不受影响）
    expect(brainErrorMessage(auth)).toMatch(/重启一次 daemon/);
  });

  it("限流仍是 backend（重试 3 次）——不能把「等一会儿就好」误判成账号问题", () => {
    const rl = new Error("-32603 internal error: rate limit exceeded, please try again");
    expect(brainFailurePlan(rl)).toEqual({ attemptLimit: 3, category: "backend" });
    expect(brainErrorMessage(rl)).toMatch(/模型后端临时出错/);
  });

  it("超时/其它 → 2 次，提示维持原样", () => {
    expect(
      brainFailurePlan(new Error("session/prompt idle timeout (idle=999ms)")).attemptLimit,
    ).toBe(2);
    expect(brainFailurePlan(new Error("fetch failed")).attemptLimit).toBe(2);
    expect(brainErrorMessage(new Error("fetch failed"))).toMatch(/处理出错了/);
  });
});

describe("isFastLane（控制/任务指令不排在大脑回合后面）", () => {
  const noTasks = { awaiting: 0, active: false, interrupted: 0 };

  it("控制指令走快车道", () => {
    for (const t of [
      "帮助",
      "AI",
      "切换大脑 opencode",
      "新会话",
      "会话列表",
      "加载 github",
      "交接",
    ])
      expect(isFastLane(t, noTasks), t).toBe(true);
  });

  it("任务指令走快车道（派发 / 列表 / 结束 / 按编号回话 / 明确寻址）", () => {
    for (const t of [
      "任务列表",
      "结束任务 2",
      "任务：写周报",
      "任务 kiro：写周报",
      "> 继续",
      "#2 继续",
      "/reply 2 继续",
    ])
      expect(isFastLane(t, noTasks), t).toBe(true);
  });

  it("「继续」类短句只在确实有可续跑任务时才走快车道", () => {
    expect(isFastLane("继续", noTasks)).toBe(false);
    expect(isFastLane("继续", { awaiting: 1, active: true, interrupted: 0 })).toBe(true);
    expect(isFastLane("继续", { awaiting: 0, active: false, interrupted: 1 })).toBe(true);
    // 有活跃任务时不去抢已中断的那条（与 shouldResumeTask 同一口径）
    expect(isFastLane("继续", { awaiting: 0, active: true, interrupted: 1 })).toBe(false);
  });

  it("普通消息与「问大脑」逃逸仍走大脑队列", () => {
    for (const t of ["你好", "帮我写个脚本", "问大脑 任务列表", "问大脑 #2 继续", "  "])
      expect(isFastLane(t, noTasks), t).toBe(false);
  });
});
