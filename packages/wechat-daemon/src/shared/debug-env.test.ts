import { describe, it, expect } from "vitest";

import { stripVscodeDebugEnv } from "./debug-env.js";

// 本机实测的形状（2026-10-29）：VS Code「智能自动附加」注入，bootloader 在 workspaceStorage 下。
const VSCODE_NODE_OPTIONS =
  "--require c:/Users/x/AppData/Roaming/Code/User/workspaceStorage/01a52/ms-vscode.js-debug/bootloader.js";
const VSCODE_INSPECTOR =
  ':::{"inspectorIpc":"\\\\\\\\.\\\\pipe\\\\node-cdp.1-0.sock.deferred","deferredMode":true,"autoAttachMode":"smart"}';

describe("stripVscodeDebugEnv（脱离式 spawn 前净化环境）", () => {
  it("典型 VS Code 注入：NODE_OPTIONS 与 VSCODE_INSPECTOR_OPTIONS 都摘掉", () => {
    const out = stripVscodeDebugEnv({
      NODE_OPTIONS: VSCODE_NODE_OPTIONS,
      VSCODE_INSPECTOR_OPTIONS: VSCODE_INSPECTOR,
      PATH: "/usr/bin",
    });
    expect(out.NODE_OPTIONS).toBeUndefined();
    expect(out.VSCODE_INSPECTOR_OPTIONS).toBeUndefined();
    expect(out.PATH).toBe("/usr/bin");
  });

  it("用户自己的 NODE_OPTIONS 原样保留（不是万能的 NODE_OPTIONS 清除器）", () => {
    const out = stripVscodeDebugEnv({ NODE_OPTIONS: "--max-old-space-size=4096" });
    expect(out.NODE_OPTIONS).toBe("--max-old-space-size=4096");
  });

  it("混合时只摘 --require 那一段，其它参数留下", () => {
    const out = stripVscodeDebugEnv({
      NODE_OPTIONS: `--max-old-space-size=4096 ${VSCODE_NODE_OPTIONS} --trace-warnings`,
      VSCODE_INSPECTOR_OPTIONS: VSCODE_INSPECTOR,
    });
    expect(out.NODE_OPTIONS).toBe("--max-old-space-size=4096 --trace-warnings");
  });

  it("先后顺序无关，`--require=` 写法也认", () => {
    const out = stripVscodeDebugEnv({
      NODE_OPTIONS: `--require=c:/x/ms-vscode.js-debug/bootloader.js --no-warnings`,
    });
    expect(out.NODE_OPTIONS).toBe("--no-warnings");
  });

  it("带引号的路径（含空格）也摘得掉", () => {
    const out = stripVscodeDebugEnv({
      NODE_OPTIONS: `--require "C:\\Program Files\\VSCode\\ms-vscode.js-debug\\bootloader.js"`,
    });
    expect(out.NODE_OPTIONS).toBeUndefined();
  });

  it("路径里没有 ms-vscode.js-debug 的 bootloader 不动（可能是用户自己的）", () => {
    const opts = "--require C:\\tools\\my-bootloader.js";
    expect(stripVscodeDebugEnv({ NODE_OPTIONS: opts }).NODE_OPTIONS).toBe(opts);
  });

  it("不修改入参；返回的是拷贝", () => {
    const env: NodeJS.ProcessEnv = {
      NODE_OPTIONS: VSCODE_NODE_OPTIONS,
      VSCODE_INSPECTOR_OPTIONS: VSCODE_INSPECTOR,
    };
    const out = stripVscodeDebugEnv(env);
    expect(env.NODE_OPTIONS).toBe(VSCODE_NODE_OPTIONS);
    expect(env.VSCODE_INSPECTOR_OPTIONS).toBe(VSCODE_INSPECTOR);
    out.PATH = "/changed";
    expect(env.PATH).toBeUndefined();
  });
});
