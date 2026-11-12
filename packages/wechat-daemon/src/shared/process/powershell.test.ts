import { describe, expect, it, vi } from "vitest";

import { resolvePowerShell, type PowerShellSpawn } from "./powershell.js";

const FIXED = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

const exists = (paths: string[]) => (p: string) => paths.includes(p);
const okSpawn = (status = 0): PowerShellSpawn => vi.fn(() => ({ status }));

describe("resolvePowerShell（5.1 优先，回退 pwsh）", () => {
  it("非 Windows → 不可用并说明原因", () => {
    const r = resolvePowerShell({ platform: "linux" });
    expect(r.ok).toBe(false);
    expect(r.source).toBe("none");
    expect(r.error).toMatch(/只在 Windows/);
  });

  it("系统自带 5.1 存在 → 用固定路径，不探测 pwsh", () => {
    const spawn = okSpawn();
    const r = resolvePowerShell({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      existsSync: exists([FIXED]),
      spawnSync: spawn,
    });
    expect(r).toEqual({ ok: true, exe: FIXED, source: "windows-powershell", error: "" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("5.1 缺失但 pwsh 能跑 → 用 pwsh", () => {
    const r = resolvePowerShell({
      platform: "win32",
      existsSync: () => false,
      spawnSync: okSpawn(0),
    });
    expect(r.ok).toBe(true);
    expect(r.exe).toBe("pwsh");
    expect(r.source).toBe("pwsh");
  });

  it("5.1 与 pwsh 都不可用 → ok=false，错误里带两边的排查信息", () => {
    const r = resolvePowerShell({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      existsSync: () => false,
      spawnSync: okSpawn(1),
    });
    expect(r.ok).toBe(false);
    expect(r.source).toBe("none");
    expect(r.error).toContain(FIXED);
    expect(r.error).toMatch(/pwsh/);
  });

  it("探测 pwsh 抛错（坏安装/权限）→ 同样降级为不可用", () => {
    const spawn: PowerShellSpawn = () => {
      throw new Error("spawn EACCES");
    };
    const r = resolvePowerShell({ platform: "win32", existsSync: () => false, spawnSync: spawn });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/EACCES/);
  });

  it("尊重 SystemRoot 覆盖的固定路径", () => {
    const root = "D:\\Win";
    const fixed = "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const r = resolvePowerShell({
      platform: "win32",
      env: { SystemRoot: root },
      existsSync: exists([fixed]),
      spawnSync: okSpawn(),
    });
    expect(r.exe).toBe(fixed);
    expect(r.source).toBe("windows-powershell");
  });
});
