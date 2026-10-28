import { describe, it, expect } from "vitest";

import {
  COMMAND_SPECS,
  OWNER_ONLY_KINDS,
  TASK_COMMAND_SPECS,
  isOwnerOnly,
  parseChatCommand,
  parseTaskCommand,
  renderHelp,
} from "./chat-commands.js";

describe("会话指令", () => {
  it("新会话：裸 / 带名字 / 旧中文别名等价", () => {
    expect(parseChatCommand("新会话")).toEqual({ kind: "new" });
    expect(parseChatCommand("新会话 项目A")).toEqual({ kind: "new", name: "项目A" });
    expect(parseChatCommand("/new")).toEqual({ kind: "new" });
    expect(parseChatCommand("/new 项目A")).toEqual({ kind: "new", name: "项目A" });
    expect(parseChatCommand("重置")).toEqual({ kind: "new" });
    expect(parseChatCommand("清空上下文")).toEqual({ kind: "new" });
  });

  it("会话列表：分页三种写法", () => {
    expect(parseChatCommand("会话列表")).toEqual({ kind: "sessions" });
    expect(parseChatCommand("会话列表 2")).toEqual({ kind: "sessions", page: 2 });
    expect(parseChatCommand("会话列表 第2页")).toEqual({ kind: "sessions", page: 2 });
    expect(parseChatCommand("/sessions")).toEqual({ kind: "sessions" });
    expect(parseChatCommand("/sessions 3")).toEqual({ kind: "sessions", page: 3 });
  });

  it("恢复 / 重命名 / 删除：序号、名字、id 前缀都能当引用", () => {
    expect(parseChatCommand("恢复会话 3")).toEqual({ kind: "resume", ref: "3" });
    expect(parseChatCommand("恢复会话 项目A")).toEqual({ kind: "resume", ref: "项目A" });
    expect(parseChatCommand("/resume ses_ab1")).toEqual({ kind: "resume", ref: "ses_ab1" });
    expect(parseChatCommand("重命名会话 3 项目B")).toEqual({
      kind: "rename",
      ref: "3",
      name: "项目B",
    });
    expect(parseChatCommand("/rename 项目A 项目B")).toEqual({
      kind: "rename",
      ref: "项目A",
      name: "项目B",
    });
    expect(parseChatCommand("删除会话 3")).toEqual({ kind: "delete", ref: "3" });
    expect(parseChatCommand("/delete 旧会话")).toEqual({ kind: "delete", ref: "旧会话" });
  });

  it("恢复会话带空格的旧名字（引用取整串）", () => {
    expect(parseChatCommand("恢复会话 项目 A 的会话")).toEqual({
      kind: "resume",
      ref: "项目 A 的会话",
    });
  });
});

describe("大脑指令", () => {
  it("/ai 家族与中文等价，无参 = 看当前", () => {
    expect(parseChatCommand("/ai")).toEqual({ kind: "ai" });
    expect(parseChatCommand("AI")).toEqual({ kind: "ai" });
    expect(parseChatCommand("AI 列表")).toEqual({ kind: "ai" });
    expect(parseChatCommand("切换大脑")).toEqual({ kind: "brain" });
    expect(parseChatCommand("切换大脑 opencode")).toEqual({ kind: "brain", target: "opencode" });
    expect(parseChatCommand("/brain deepseek")).toEqual({ kind: "brain", target: "deepseek" });
    expect(parseChatCommand("/ai brain auto")).toEqual({ kind: "brain", target: "auto" });
    expect(parseChatCommand("AI 大脑 opencode")).toEqual({ kind: "brain", target: "opencode" });
  });

  it("任务大脑：不与「切换大脑」互串", () => {
    expect(parseChatCommand("切换任务大脑")).toEqual({ kind: "workerBrain" });
    expect(parseChatCommand("切换任务大脑 opencode")).toEqual({
      kind: "workerBrain",
      target: "opencode",
    });
    expect(parseChatCommand("/worker kiro")).toEqual({ kind: "workerBrain", target: "kiro" });
    expect(parseChatCommand("/ai task kiro")).toEqual({ kind: "workerBrain", target: "kiro" });
  });

  it("交接 / 帮助", () => {
    expect(parseChatCommand("交接")).toEqual({ kind: "handoff" });
    expect(parseChatCommand("/handoff")).toEqual({ kind: "handoff" });
    expect(parseChatCommand("帮助")).toEqual({ kind: "help" });
    expect(parseChatCommand("/help")).toEqual({ kind: "help" });
  });

  it("owner-only 判定与指令表一致", () => {
    expect(isOwnerOnly({ kind: "brain" })).toBe(true);
    expect(isOwnerOnly({ kind: "handoff" })).toBe(true);
    expect(isOwnerOnly({ kind: "new" })).toBe(false);
    for (const s of COMMAND_SPECS) {
      const sample = s.match(
        // 用一个必定命中的样例跑一遍，确认表里标的 ownerOnly 与集合一致
        [
          "mcp",
          "加载 x",
          "卸载 x",
          "新会话",
          "会话列表",
          "恢复会话 1",
          "重命名会话 1 x",
          "删除会话 1",
          "AI",
          "切换大脑",
          "切换任务大脑",
          "交接",
          "帮助",
        ][COMMAND_SPECS.indexOf(s)],
      );
      expect(sample).not.toBeNull();
      expect(!!s.ownerOnly).toBe(OWNER_ONLY_KINDS.has(sample!.kind));
    }
  });
});

describe("MCP 指令（原样保留）", () => {
  it("列出 / 加载 / 卸载", () => {
    expect(parseChatCommand("mcp")).toEqual({ kind: "list" });
    expect(parseChatCommand("/mcp")).toEqual({ kind: "list" });
    expect(parseChatCommand("加载 foo")).toEqual({ kind: "add", name: "foo" });
    expect(parseChatCommand("卸载 foo")).toEqual({ kind: "remove", name: "foo" });
  });
});

describe("任务指令", () => {
  it("派发：冒号形式 + > 别名（沿用旧写法）", () => {
    expect(parseTaskCommand("任务：写个脚本")).toEqual({ kind: "toWorker", text: "写个脚本" });
    expect(parseTaskCommand("task: do it")).toEqual({ kind: "toWorker", text: "do it" });
    expect(parseTaskCommand("> 继续干")).toEqual({ kind: "toWorker", text: "继续干" });
  });

  it("指定 agent：冒号前必须是已知预设名", () => {
    expect(parseTaskCommand("任务 kiro：写个脚本")).toEqual({
      kind: "toWorker",
      text: "写个脚本",
      agentToken: "kiro",
    });
    expect(parseTaskCommand("任务 auto:跑测试")).toEqual({
      kind: "toWorker",
      text: "跑测试",
      agentToken: "auto",
    });
    expect(parseTaskCommand("/task opencode 修一下构建")).toEqual({
      kind: "toWorker",
      text: "修一下构建",
      agentToken: "opencode",
    });
  });

  it("★ 冒号前不是预设名 → 整串都是正文（不能误判成指定 agent）", () => {
    expect(parseTaskCommand("任务 明天：去买菜")).toEqual({
      kind: "toWorker",
      text: "明天：去买菜",
    });
    expect(parseTaskCommand("> nav: 去某地")).toEqual({ kind: "toWorker", text: "nav: 去某地" });
    expect(parseTaskCommand("/task 明天 去买菜")).toEqual({
      kind: "toWorker",
      text: "明天 去买菜",
    });
  });

  it("编号寻址：只认纯数字的 # / /reply（半角全角都收）", () => {
    expect(parseTaskCommand("#2 改成用 vitest")).toEqual({
      kind: "reply",
      id: 2,
      text: "改成用 vitest",
    });
    expect(parseTaskCommand("＃2 改成用 vitest")).toEqual({
      kind: "reply",
      id: 2,
      text: "改成用 vitest",
    });
    expect(parseTaskCommand("/reply 3 继续")).toEqual({ kind: "reply", id: 3, text: "继续" });
    expect(parseTaskCommand("#abc 你好")).toBeNull();
    expect(parseTaskCommand("# 你好")).toBeNull();
    // 「1 号文件」不是给 1 号任务回话
    expect(parseTaskCommand("#1 号文件在哪")).toBeNull();
  });

  it("任务列表 / 结束任务（含编号与全部）", () => {
    expect(parseTaskCommand("任务列表")).toEqual({ kind: "tasks" });
    expect(parseTaskCommand("/tasks")).toEqual({ kind: "tasks" });
    expect(parseTaskCommand("结束任务")).toEqual({ kind: "stop" });
    expect(parseTaskCommand("/stop")).toEqual({ kind: "stop" });
    expect(parseTaskCommand("结束任务 2")).toEqual({ kind: "stop", id: 2 });
    expect(parseTaskCommand("/stop 3")).toEqual({ kind: "stop", id: 3 });
    expect(parseTaskCommand("结束全部任务")).toEqual({ kind: "stop", id: "all" });
    expect(parseTaskCommand("/stop all")).toEqual({ kind: "stop", id: "all" });
  });

  it("全部子模式都在表里（帮助不会漏项）", () => {
    const ids = TASK_COMMAND_SPECS.map((s) => s.id);
    expect(ids).toEqual(["task.dispatch", "task.reply", "task.list", "task.stop"]);
  });
});

describe("★ 负例：普通消息绝不能被当成指令", () => {
  const normal = [
    "你好",
    "帮我写个脚本",
    "mcp 是什么",
    "任务很重要",
    "任务 是啥意思",
    "帮助我写代码",
    "指令集是什么",
    "我对 AI 的看法",
    "AI 是什么",
    "新会话是什么意思",
    "会话列表怎么看",
    "切换大脑的想法",
    "恢复会话怎么用",
    "#1 号文件在哪",
  ];
  it("parseChatCommand 全部 null", () => {
    for (const t of normal) expect(parseChatCommand(t), t).toBeNull();
  });
  it("parseTaskCommand 全部 null", () => {
    for (const t of normal) expect(parseTaskCommand(t), t).toBeNull();
  });
});

describe("renderHelp：按角色裁剪", () => {
  it("owner 看得到切脑/交接，普通用户看不到", () => {
    const owner = renderHelp("owner");
    expect(owner).toContain("切换大脑");
    expect(owner).toContain("交接");
    expect(owner).toContain("新会话");
    expect(owner).toContain("任务");
    const user = renderHelp("user");
    expect(user).not.toContain("切换大脑 [预设");
    expect(user).not.toContain("生成当前会话摘要");
    expect(user).toContain("新会话");
    expect(user).toContain("仅账号本人可用");
  });

  it("CLI 形态列 CLI 命令", () => {
    const cli = renderHelp("owner", "cli");
    expect(cli).toContain("wemind session resume <ref>");
    expect(cli).toContain("wemind task-list");
  });
});
