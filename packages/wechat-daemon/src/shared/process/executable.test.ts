import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { findOnPathAny, isShellScriptPath, locateExecutable } from "./executable.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function binDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-exe-test-"));
  roots.push(root);
  return root;
}

describe("Windows 裸名解析", () => {
  it("按 PATH + PATHEXT 找到 npm shim，而不是只找 .exe", () => {
    const dir = binDir();
    const shim = path.join(dir, "probe-agent.cmd");
    fs.writeFileSync(shim, "@echo off\r\n", "utf-8");
    const env = {
      PATH: dir,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    };

    expect(findOnPathAny("probe-agent", { platform: "win32", env })).toBe(shim);
    expect(locateExecutable("probe-agent", { platform: "win32", env })).toBe(shim);
    expect(isShellScriptPath(shim, "win32")).toBe(true);
  });

  it("显式扩展名不重复拼接，且无扩展名路径也会按 PATHEXT 补全", () => {
    const dir = binDir();
    fs.writeFileSync(path.join(dir, "agent.exe"), "", "utf-8");
    const env = {
      PATH: dir,
      PATHEXT: ".EXE;.CMD",
    };
    expect(locateExecutable("agent.exe", { platform: "win32", env })).toBe(
      path.join(dir, "agent.exe"),
    );
    expect(locateExecutable(path.join(dir, "agent"), { platform: "win32", env })).toBe(
      path.join(dir, "agent.exe"),
    );
  });
});
