import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ResolvedAgent } from "../brain-agents.js";
import { agentRuntime, mediaDirFor } from "./runtime.js";
import { readOverlay } from "./overlay.js";
import {
  captureEnvSnapshot,
  mergeEnvSnapshot,
  readEnvSnapshot,
  writeEnvSnapshot,
} from "./env-snapshot.js";
import { getSessionCwd, setSessionCwd } from "./session-cwd.js";
import {
  defaultWorkspacePath,
  loadWorkspaceConfig,
  resolveWorkspace,
  updateWorkspace,
  validateWorkspacePath,
  workspaceConfigPath,
} from "./workspace.js";
import { mutateConfigFile, setConfigPath, snapshotConfigFile } from "./agent-config-writer.js";
import { addMcp, catalogNames, loadActive } from "../managed/mcp-brain.js";
import { configFingerprint } from "./config-fingerprint.js";
import { homeModePath, normalizeHomeMode, readHomeMode, writeHomeMode } from "./home-mode.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wemind-config-"));
}

const oldMode = process.env.WEMIND_HOME_MODE;
beforeAll(() => {
  delete process.env.WEMIND_HOME_MODE;
});
afterAll(() => {
  if (oldMode === undefined) delete process.env.WEMIND_HOME_MODE;
  else process.env.WEMIND_HOME_MODE = oldMode;
});

function fakeAgent(realHome: string): ResolvedAgent {
  return {
    name: "kiro",
    bin: "kiro-cli",
    args: [],
    homeEnvVar: "KIRO_HOME",
    extraConfigFiles: [],
    shell: false,
    inherit: true,
    realHome,
    inheritDirs: [],
    inheritFiles: [],
    configSubdir: "",
    mcpFormat: "mcpServers",
    mcpConfigFile: "settings/mcp.json",
    catalogFile: "settings/mcp.json",
    env: {},
    envDefaults: {},
    credentialFiles: [],
    identityFiles: [],
    settingsDefaults: {},
    acpMcpServers: false,
    mcpDelivery: "config",
    known: true,
    available: true,
    binPath: null,
    requiresBins: [],
    binOverridden: false,
    requestedKey: "kiro",
    source: "auto",
  } as unknown as ResolvedAgent;
}

describe("workspace", () => {
  it("默认 brain/worker 工作区是账号目录下的默认路径（mode=default）", () => {
    const dir = tmp();
    expect(resolveWorkspace("brain", dir)).toMatchObject({
      mode: "default",
      path: defaultWorkspacePath("brain", dir),
    });
    expect(resolveWorkspace("worker", dir).path).toBe(defaultWorkspacePath("worker", dir));
    expect(loadWorkspaceConfig(dir).config.brain).toMatchObject({ mode: "default" });
  });

  it("旧值 mode=managed 按 default 处理（2026-11-14 改名，避免与 homeMode=managed 撞名）", () => {
    const dir = tmp();
    fs.writeFileSync(
      workspaceConfigPath(dir),
      JSON.stringify({ version: 1, brain: { mode: "managed" }, worker: { mode: "managed" } }),
    );
    expect(resolveWorkspace("brain", dir)).toMatchObject({
      mode: "default",
      path: defaultWorkspacePath("brain", dir),
    });
    expect(resolveWorkspace("brain", dir).problem).toBeUndefined();
  });

  it("external 必须是已存在目录；账号目录/家目录/Agent 配置目录被拒", () => {
    const dir = tmp();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-project-"));
    updateWorkspace("brain", project, dir);
    expect(resolveWorkspace("brain", dir)).toMatchObject({ mode: "external", path: project });
    expect(validateWorkspacePath(dir, "brain", dir)).toMatch(/账号目录/);
    expect(validateWorkspacePath(os.homedir(), "brain", dir)).toMatch(/家目录根/);
    expect(validateWorkspacePath(path.join(dir, "missing"), "brain", dir)).toMatch(/不存在/);
  });
});

describe("overlay", () => {
  it("拒绝疑似密钥键；旧的 config 段被忽略并报告", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "agent-overrides"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "agent-overrides", "kiro.json"),
      JSON.stringify({
        version: 1,
        config: { "settings/cli.json": { model: "x" } },
        mcp: { extra: { demo: { command: "x", env: { API_KEY: "secret" } } } },
      }),
    );
    const problems = readOverlay("kiro", dir).problems.join(" ");
    expect(problems).toMatch(/overlay\.config 已不再支持/);
    expect(problems).toMatch(/疑似密钥/);
  });
});

describe("env snapshot", () => {
  it("只保留白名单，密钥类键丢弃；合并时当前环境优先、快照兜底", () => {
    const snap = captureEnvSnapshot({
      PATH: "/bin",
      LANG: "zh_CN.UTF-8",
      MY_API_KEY: "secret",
      HTTPS_PROXY: "http://proxy",
    });
    expect(snap.keys).toEqual({ PATH: "/bin", LANG: "zh_CN.UTF-8", HTTPS_PROXY: "http://proxy" });
    expect(mergeEnvSnapshot({ PATH: "/old", HOME: "/home" }, snap.keys)).toMatchObject({
      PATH: "/old",
      HOME: "/home",
      LANG: "zh_CN.UTF-8",
      HTTPS_PROXY: "http://proxy",
    });
    // 当前环境没定义的键才用快照（autostart 拉起时 PATH 不完整的场景）
    expect(mergeEnvSnapshot({ HOME: "/home" }, snap.keys)).toMatchObject({ PATH: "/bin" });
  });

  it("读回时再次过滤未知/密钥键", () => {
    const dir = tmp();
    writeEnvSnapshot({ version: 1, capturedAt: 1, keys: { PATH: "/x", TOKEN: "t" } }, dir);
    expect(readEnvSnapshot(dir)).toEqual({ PATH: "/x" });
  });
});

describe("session cwd 与配置写入", () => {
  it("session cwd 按 agent+sessionId 持久化", () => {
    const dir = tmp();
    setSessionCwd("kiro", "s1", "/work", dir);
    expect(getSessionCwd("kiro", "s1", dir)).toBe("/work");
  });

  it("配置写入前备份，unset 删除键", () => {
    const dir = tmp();
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ model: "a", nested: { x: 1 } }));
    const r = mutateConfigFile(file, "nested.x", 2);
    expect(r.backup).toBeTruthy();
    expect(JSON.parse(fs.readFileSync(file, "utf-8")).nested.x).toBe(2);
    mutateConfigFile(file, "nested.x", undefined);
    expect(JSON.parse(fs.readFileSync(file, "utf-8")).nested.x).toBeUndefined();
  });

  it("setConfigPath 支持数组下标", () => {
    expect(setConfigPath({ a: [1, 2] }, "a[1]", 3)).toEqual({ a: [1, 3] });
  });

  it("写真实配置前校验快照：终端侧刚改过就拒绝覆盖", () => {
    const dir = tmp();
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ model: "a" }));
    const snapshot = snapshotConfigFile(file);
    fs.writeFileSync(file, JSON.stringify({ model: "terminal" }));
    expect(() => mutateConfigFile(file, "model", "wechat", { expected: snapshot })).toThrow(
      /读取后被其它程序修改/,
    );
    expect(JSON.parse(fs.readFileSync(file, "utf-8")).model).toBe("terminal");
  });

  it("未显式传 expected 时，读后终端侧改文件同样拒绝覆盖", () => {
    const dir = tmp();
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ model: "a" }));
    const realRead = fs.readFileSync.bind(fs);
    let fileReads = 0;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((
      target: fs.PathOrFileDescriptor,
      options?: unknown,
    ) => {
      const value = realRead(target, options as never);
      if (path.resolve(String(target)) === path.resolve(file)) {
        fileReads++;
        // 第二次读取是 readConfigObject；读完立刻模拟终端侧保存新配置。
        if (fileReads === 2) fs.writeFileSync(file, JSON.stringify({ model: "terminal" }));
      }
      return value;
    }) as typeof fs.readFileSync);
    try {
      expect(() => mutateConfigFile(file, "model", "wechat")).toThrow(/读取后被其它程序修改/);
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(fs.readFileSync(file, "utf-8")).model).toBe("terminal");
  });

  it("含注释的 JSONC 拒绝命令行写入，避免静默丢注释", () => {
    const dir = tmp();
    const file = path.join(dir, "settings.jsonc");
    fs.writeFileSync(file, '{\n  // keep me\n  "model": "a"\n}\n');
    expect(() => mutateConfigFile(file, "model", "b")).toThrow(/含注释/);
    expect(fs.readFileSync(file, "utf-8")).toContain("// keep me");
  });
});

describe("MCP 激活集（managed）", () => {
  it("按账号目录隔离，不共用全局 brain-mcps.json", () => {
    const accountA = tmp();
    const accountB = tmp();
    const realHome = path.join(accountA, "real");
    fs.mkdirSync(path.join(realHome, "settings"), { recursive: true });
    fs.writeFileSync(
      path.join(realHome, "settings", "mcp.json"),
      JSON.stringify({ mcpServers: { demo: { command: "demo-server" } } }),
    );
    const ag = fakeAgent(realHome);

    expect(catalogNames(ag, accountA)).toContain("demo");
    process.env.WEMIND_HOME_MODE = "managed";
    try {
      expect(addMcp("demo", ag, accountA).ok).toBe(true);
    } finally {
      delete process.env.WEMIND_HOME_MODE;
    }
    expect(loadActive(ag.name, accountA)).toEqual(["demo"]);
    expect(loadActive(ag.name, accountB)).toEqual([]);
  });
});

describe("configFingerprint", () => {
  it("真实配置变化与 overlay 变化都会改变指纹", () => {
    const dir = tmp();
    const realHome = path.join(dir, "real");
    fs.mkdirSync(path.join(realHome, "settings"), { recursive: true });
    const settings = path.join(realHome, "settings", "mcp.json");
    fs.writeFileSync(settings, JSON.stringify({ mcpServers: {} }));
    const ag = fakeAgent(realHome);
    const rt = agentRuntime("brain", ag, dir);

    const before = configFingerprint(ag, rt, dir);
    fs.writeFileSync(settings, JSON.stringify({ mcpServers: { demo: { command: "x" } } }));
    const afterReal = configFingerprint(ag, rt, dir);
    expect(afterReal).not.toBe(before);

    fs.mkdirSync(path.join(dir, "agent-overrides"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "agent-overrides", "kiro.json"),
      JSON.stringify({ version: 1, mcp: { disable: ["demo"] } }),
    );
    const afterOverlay = configFingerprint(ag, rt, dir);
    expect(afterOverlay).not.toBe(afterReal);
  });
});

describe("homeMode：direct / managed", () => {
  function withoutEnv<T>(fn: () => T): T {
    const saved = process.env.WEMIND_HOME_MODE;
    delete process.env.WEMIND_HOME_MODE;
    try {
      return fn();
    } finally {
      if (saved === undefined) delete process.env.WEMIND_HOME_MODE;
      else process.env.WEMIND_HOME_MODE = saved;
    }
  }

  it("缺省 direct；无法识别的值一律回落到 direct", () => {
    const dir = tmp();
    withoutEnv(() => {
      expect(readHomeMode(dir)).toBe("direct");
      for (const unknown of ["legacy-a", "legacy-b", "legacy-c"]) {
        fs.writeFileSync(homeModePath(dir), JSON.stringify({ version: 1, homeMode: unknown }));
        expect(readHomeMode(dir)).toBe("direct");
      }
      fs.writeFileSync(homeModePath(dir), JSON.stringify({ version: 1, homeMode: "managed" }));
      expect(readHomeMode(dir)).toBe("managed");
    });
    expect(normalizeHomeMode("legacy-a")).toBeNull();
    expect(normalizeHomeMode("legacy-b")).toBeNull();
    expect(normalizeHomeMode("legacy-c")).toBeNull();
    expect(normalizeHomeMode("direct")).toBe("direct");
    expect(normalizeHomeMode("managed")).toBe("managed");
    expect(normalizeHomeMode("nope")).toBeNull();
    withoutEnv(() => writeHomeMode("managed", dir));
    expect(JSON.parse(fs.readFileSync(homeModePath(dir), "utf-8")).homeMode).toBe("managed");
  });

  it("旧值 sandbox 按 managed 处理（2026-11-14 改名，老账号不被静默降级成 direct）", () => {
    const dir = tmp();
    withoutEnv(() => {
      fs.writeFileSync(homeModePath(dir), JSON.stringify({ version: 1, homeMode: "sandbox" }));
      expect(readHomeMode(dir)).toBe("managed");
    });
    expect(normalizeHomeMode("sandbox")).toBe("managed");
    expect(normalizeHomeMode(" SANDBOX ")).toBe("managed");
    process.env.WEMIND_HOME_MODE = "sandbox";
    try {
      expect(readHomeMode(dir)).toBe("managed");
    } finally {
      delete process.env.WEMIND_HOME_MODE;
    }
  });

  it("direct 直接使用真实配置目录，不生成任何副本", () => {
    const dir = tmp();
    const realHome = path.join(dir, "real");
    fs.mkdirSync(realHome, { recursive: true });
    const rt = withoutEnv(() => agentRuntime("brain", fakeAgent(realHome), dir));
    expect(rt).toMatchObject({ mode: "direct", home: realHome, configDir: realHome });
    expect(fs.existsSync(path.join(dir, "brain-home"))).toBe(false);
  });

  it("direct 不改真实配置，overlay 只保留 mcp 段", () => {
    const dir = tmp();
    const realHome = path.join(dir, "real");
    fs.mkdirSync(realHome, { recursive: true });
    fs.writeFileSync(path.join(realHome, "settings.json"), '{"model":"terminal"}');
    fs.mkdirSync(path.join(dir, "agent-overrides"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "agent-overrides", "kiro.json"),
      JSON.stringify({ version: 1, mcp: { disable: ["demo"] } }),
    );
    const rt = withoutEnv(() => agentRuntime("brain", fakeAgent(realHome), dir));
    expect(rt.overlay).toEqual({ version: 1, mcp: { disable: ["demo"] } });
    expect(fs.readFileSync(path.join(realHome, "settings.json"), "utf-8")).toBe(
      '{"model":"terminal"}',
    );
  });

  it("direct 下加载/卸载 MCP 直接拒绝，不写激活集", () => {
    const dir = tmp();
    const realHome = path.join(dir, "real");
    fs.mkdirSync(realHome, { recursive: true });
    const ag = fakeAgent(realHome);
    const added = withoutEnv(() => addMcp("demo", ag, dir));
    expect(added.ok).toBe(false);
    expect(added.text).toMatch(/direct 模式/);
    expect(loadActive("kiro", dir)).toEqual([]);
  });

  it("direct 的入站媒体在账号目录；managed 在副本目录", () => {
    const dir = tmp();
    expect(mediaDirFor("brain", "direct", dir)).toBe(path.join(dir, "media", "inbound"));
    expect(mediaDirFor("worker", "managed", dir)).toBe(
      path.join(dir, "worker-home", "media", "inbound"),
    );
  });
});
