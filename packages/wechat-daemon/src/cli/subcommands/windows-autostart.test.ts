import { describe, it, expect } from "vitest";
import { windowsAutostartArgs, windowsAutostartCommand } from "./windows-autostart.js";

describe("windowsAutostartCommand", () => {
  const node = "C:\\Program Files\\nodejs\\node.exe";
  const cli = "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@wemind\\cli\\dist\\cli.js";

  it("默认启动全部账号", () => {
    expect(windowsAutostartCommand(node, cli)).toBe(`"${node}" "${cli}" start --all`);
  });

  it("指定账号时逐个列出 key（不触发安装动作）", () => {
    expect(windowsAutostartCommand(node, cli, ["aaa111"])).toBe(`"${node}" "${cli}" start aaa111`);
    expect(windowsAutostartCommand(node, cli, ["aaa111", "bbb222"])).toBe(
      `"${node}" "${cli}" start aaa111 bbb222`,
    );
  });

  it("空数组等同全部", () => {
    expect(windowsAutostartCommand(node, cli, [])).toBe(`"${node}" "${cli}" start --all`);
  });

  it("执行的是 start 而不是 autostart install（避免登录时递归安装）", () => {
    expect(windowsAutostartCommand(node, cli)).not.toContain("autostart");
  });

  it("PM2 模式：触发命令带 --runner pm2（Windows 的 pm2 resurrect 替代）", () => {
    expect(windowsAutostartCommand(node, cli, undefined, "pm2")).toBe(
      `"${node}" "${cli}" start --all --runner pm2`,
    );
    expect(windowsAutostartCommand(node, cli, ["aaa111"], "pm2")).toBe(
      `"${node}" "${cli}" start aaa111 --runner pm2`,
    );
  });

  it("非 pm2 的 runner 不追加参数", () => {
    expect(windowsAutostartCommand(node, cli, undefined, "builtin")).toBe(
      `"${node}" "${cli}" start --all`,
    );
  });
});

describe("windowsAutostartArgs（计划任务 -Argument，不含 node 路径）", () => {
  const cli = "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@wemind\\cli\\dist\\cli.js";

  it("默认全部账号", () => {
    expect(windowsAutostartArgs(cli)).toBe(`"${cli}" start --all`);
  });

  it("指定账号", () => {
    expect(windowsAutostartArgs(cli, ["aaa111", "bbb222"])).toBe(`"${cli}" start aaa111 bbb222`);
  });

  it("空数组等同全部", () => {
    expect(windowsAutostartArgs(cli, [])).toBe(`"${cli}" start --all`);
  });

  it("PM2 模式追加 --runner pm2", () => {
    expect(windowsAutostartArgs(cli, undefined, "pm2")).toBe(`"${cli}" start --all --runner pm2`);
  });
});
