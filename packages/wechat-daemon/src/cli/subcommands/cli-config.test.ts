import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * CLI 配置子命令：只验「写文件前的边界」，不真起编辑器/daemon。
 * core 的 WEMIND_ROOT 是模块加载时定死的，所以要先设好 WEMIND_HOME 再 vi.resetModules() 动态 import。
 */
const KEY = "acc";
let home = "";
let dir = "";
let cmdConfig: typeof import("./cli-config.js").cmdConfig;
let cmdMcp: typeof import("./cli-config.js").cmdMcp;
let cmdEnv: typeof import("./cli-config.js").cmdEnv;
let cmdWorkspace: typeof import("./cli-config.js").cmdWorkspace;

const prev: Record<string, string | undefined> = {};
function keep(name: string, value: string | undefined): void {
  prev[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-cli-config-"));
  const realHome = path.join(home, "real-home");
  fs.mkdirSync(realHome, { recursive: true });
  keep("WEMIND_HOME", home);
  keep("WEMIND_BRAIN_REAL_HOME", realHome);
  // node --version <file> 一定退出 0，不依赖平台自带编辑器
  keep("VISUAL", `${process.execPath} --version`);
  keep("EDITOR", undefined);
  keep("WEMIND_HOME_MODE", undefined);
  keep("WEMIND_BRAIN", undefined);
  keep("WEMIND_MCP_CATALOG", undefined);
  fs.writeFileSync(
    path.join(home, "accounts.json"),
    JSON.stringify({
      default: KEY,
      accounts: {
        acc: { key: KEY, botId: "x", userId: "u", baseUrl: "", label: "acc", addedAt: 1 },
      },
    }),
    "utf-8",
  );
  vi.resetModules();
  ({ cmdConfig, cmdMcp, cmdEnv, cmdWorkspace } = await import("./cli-config.js"));
});

afterAll(() => {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  dir = path.join(home, KEY);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "brain.json"),
    JSON.stringify({
      agent: "kiro",
      presets: { kiro: { bin: process.execPath, args: ["--acp"] } },
    }),
    "utf-8",
  );
  delete process.env.WEMIND_HOME_MODE;
});

describe("config agent edit：不破坏非 JSON 配置", () => {
  it("不存在的 config.toml 不被预建成 {}（openEditor 直接拒绝）", async () => {
    const file = path.join(home, "real-home", "config.toml");
    fs.rmSync(file, { force: true });
    await expect(
      cmdConfig(["agent", "codex", "edit", "--file", "config.toml", "--key", KEY]),
    ).rejects.toThrow(/不会为非 JSON 格式预建空文件/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("show 报 unsupported，但也不写文件", async () => {
    const text = await cmdConfig(["agent", "codex", "show", "--file", "config.toml", "--key", KEY]);
    expect(text).toContain("格式：unsupported");
    expect(fs.existsSync(path.join(home, "real-home", "config.toml"))).toBe(false);
  });

  it("不存在的 .json 会预建 {} 再交给编辑器", async () => {
    const file = path.join(home, "real-home", "settings.json");
    fs.rmSync(file, { force: true });
    const out = await cmdConfig(["agent", "kiro", "edit", "--file", "settings.json", "--key", KEY]);
    expect(out).toContain("已关闭编辑器");
    expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual({});
  });
});

describe("takeOpt：空值 / 缺值 / 撞到下一个 flag 都拒绝", () => {
  it("--key 后面没有值", () => {
    expect(() => cmdEnv(["capture", "--key"])).toThrow(/--key 缺少参数值/);
  });

  it("--key 后面是空串", () => {
    expect(() => cmdEnv(["capture", "--key", ""])).toThrow(/--key 缺少参数值/);
  });

  it("--key 后面是另一个 flag", () => {
    expect(() => cmdEnv(["capture", "--key", "--file", "x"])).toThrow(/--key 缺少参数值/);
  });

  it("--file 同样受保护", () => {
    expect(() => cmdWorkspace(["show", "--file", "--role", "worker"])).toThrow(/--file 缺少参数值/);
  });
});

describe("env clear：不存在时如实回「不存在」", () => {
  it("clear 不存在的 env.json → 返回不存在", () => {
    expect(cmdEnv(["clear", "--key", KEY])).toContain("不存在");
  });

  it("capture 后 clear → 已删除", () => {
    cmdEnv(["capture", "--key", KEY]);
    expect(fs.existsSync(path.join(dir, "env.json"))).toBe(true);
    expect(cmdEnv(["clear", "--key", KEY])).toContain("已删除");
    expect(fs.existsSync(path.join(dir, "env.json"))).toBe(false);
  });
});

describe("config mcp disable：direct 下不写 overlay（不允许假成功）", () => {
  it("removeMcp 失败时原样回原因，且 overlay 文件不存在", () => {
    const text = cmdMcp(["disable", "demo", "--key", KEY]);
    expect(text).toMatch(/direct 模式/);
    expect(fs.existsSync(path.join(dir, "agent-overrides", "kiro.json"))).toBe(false);
  });
});
