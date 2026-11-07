import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// 只替换 execFileSync：安装流程会调 schtasks / reg / powershell，测试里全部走假实现。
vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

import { execFileSync } from "node:child_process";
import { installWindowsAutostart } from "./windows-autostart.js";

const execMock = execFileSync as unknown as Mock;

function calls(): string[] {
  return execMock.mock.calls.map(
    ([cmd, args]) => `${String(cmd)} ${((args as string[] | undefined) ?? []).join(" ")}`,
  );
}

describe("installWindowsAutostart", () => {
  beforeEach(() => {
    execMock.mockReset();
    execMock.mockImplementation(() => Buffer.from(""));
  });

  it("安装计划任务前先清掉旧任务与 Run 键，避免登录时启动两次", () => {
    expect(installWindowsAutostart("C:\\node.exe", "C:\\cli.js")).toBe("scheduled-task");

    const all = calls();
    // 先清 native 与 pm2 两种用途的计划任务和 Run 键
    expect(all[0]).toContain("schtasks /Delete /TN wemind-autostart /F");
    expect(all[1]).toContain("reg delete HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run");
    expect(all[1]).toContain("/v wemind-autostart /F");
    expect(all[2]).toContain("schtasks /Delete /TN wemind-autostart-pm2 /F");
    expect(all[3]).toContain("/v wemind-autostart-pm2 /F");
    // 再注册并确认新任务；登录触发条件绑定当前用户，避免多用户机器上任何用户登录都触发
    expect(all.some((c) => c.includes("New-ScheduledTaskTrigger -AtLogOn -User"))).toBe(true);
    expect(all.some((c) => c.includes("Register-ScheduledTask"))).toBe(true);
    expect(all.at(-1)).toContain("schtasks /Query /TN wemind-autostart");
  });

  it("计划任务创建失败时降级 Run 键；旧任务已在安装前清掉", () => {
    execMock.mockImplementation((cmd: string) => {
      if (String(cmd).toLowerCase().includes("powershell")) throw new Error("Access denied");
      return Buffer.from("");
    });

    expect(installWindowsAutostart("C:\\node.exe", "C:\\cli.js")).toBe("run-key");

    const all = calls();
    expect(all.some((c) => c.includes("schtasks /Delete /TN wemind-autostart /F"))).toBe(true);
    const runKey = all.find((c) => c.startsWith("reg add"));
    expect(runKey).toContain("/v wemind-autostart");
    expect(runKey).toContain('"C:\\node.exe" "C:\\cli.js" start --all');
  });

  it("PM2 模式用不同的任务名，动作带 --runner pm2", () => {
    expect(installWindowsAutostart("C:\\node.exe", "C:\\cli.js", undefined, "pm2")).toBe(
      "scheduled-task",
    );

    const register = calls().find((c) => c.includes("Register-ScheduledTask"));
    expect(register).toContain("wemind-autostart-pm2");
    expect(register).toContain("start --all --runner pm2");
  });
});
