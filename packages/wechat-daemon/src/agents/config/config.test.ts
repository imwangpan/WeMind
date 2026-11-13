import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ResolvedAgent } from "../brain-agents.js";
import { agentRuntime, mediaDirFor, resetViewFallback } from "./runtime.js";
import { applyOverlayToView, overrideRelPaths, viewRoot } from "./config-view.js";
import { applyPatch, overlayPathProblems, readOverlay, type AgentOverlay } from "./overlay.js";
import {
  captureEnvSnapshot,
  mergeEnvSnapshot,
  readEnvSnapshot,
  writeEnvSnapshot,
} from "./env-snapshot.js";
import { getSessionCwd, setSessionCwd } from "./session-cwd.js";
import {
  defaultWorkspacePath,
  resolveWorkspace,
  updateWorkspace,
  validateWorkspacePath,
} from "./workspace.js";
import { mutateConfigFile, setConfigPath, snapshotConfigFile } from "./agent-config-writer.js";
import { addMcp, catalogNames, loadActive } from "../sandbox/mcp-sandbox.js";
import { configFingerprint } from "./config-fingerprint.js";
import { homeModePath, normalizeHomeMode, readHomeMode, writeHomeMode } from "./home-mode.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wemind-config-"));
}

const oldMode = process.env.WEMIND_HOME_MODE;
beforeAll(() => {
  process.env.WEMIND_HOME_MODE = "view";
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
    settingsStrip: [],
    settingsDefaults: {},
    mcpViaAcp: false,
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
  it("默认 brain/worker 工作区是账号目录下的 managed 路径", () => {
    const dir = tmp();
    expect(resolveWorkspace("brain", dir)).toMatchObject({
      mode: "managed",
      path: defaultWorkspacePath("brain", dir),
    });
    expect(resolveWorkspace("worker", dir).path).toBe(defaultWorkspacePath("worker", dir));
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
  it("深合并：对象递归、数组整段替换、null 删除键", () => {
    expect(
      applyPatch(
        { a: { x: 1, y: 2 }, list: [1, 2], keep: true },
        { a: { y: null, z: 3 }, list: [9], keep: true },
      ),
    ).toEqual({ a: { x: 1, z: 3 }, list: [9], keep: true });
  });

  it("拒绝疑似密钥键与越界路径", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "agent-overrides"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "agent-overrides", "kiro.json"),
      JSON.stringify({
        version: 1,
        config: { "settings/cli.json": { apiKey: "x" } },
      }),
    );
    expect(readOverlay("kiro", dir).problems.join(" ")).toMatch(/疑似密钥/);
    expect(
      overlayPathProblems(path.join(dir, "real"), {
        version: 1,
        config: { "../../outside.json": { a: 1 } },
      }),
    ).toHaveLength(1);
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

describe("view config view", () => {
  it("overlay 只改视图，不改真实文件", () => {
    const dir = tmp();
    const realHome = path.join(dir, "real");
    fs.mkdirSync(path.join(realHome, "settings"), { recursive: true });
    const realFile = path.join(realHome, "settings", "cli.json");
    fs.writeFileSync(realFile, JSON.stringify({ model: "real", nested: { x: 1 } }));
    const ag = fakeAgent(realHome);
    const overlay = {
      version: 1 as const,
      config: { "settings/cli.json": { model: "wechat" } },
    };
    const rt = agentRuntime("brain", ag, dir);
    expect(rt.view).toBeTruthy();
    applyOverlayToView(rt.view!, ag, overlay as AgentOverlay);
    expect(JSON.parse(fs.readFileSync(realFile, "utf-8")).model).toBe("real");
    expect(
      JSON.parse(fs.readFileSync(path.join(rt.configDir, "settings", "cli.json"), "utf-8")).model,
    ).toBe("wechat");
  });

  it("configSubdir 非空时 manifest 记录 root 相对路径，重建能清理旧链接", () => {
    const dir = tmp();
    const realHome = path.join(dir, "real");
    fs.mkdirSync(realHome, { recursive: true });
    fs.writeFileSync(path.join(realHome, "settings.json"), "{}");
    const ag = { ...fakeAgent(realHome), configSubdir: ".gemini" };

    const rt = agentRuntime("brain", ag, dir);
    const viewFile = path.join(rt.configDir, "settings.json");
    expect(fs.existsSync(viewFile)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(rt.home, ".wemind-view.json"), "utf-8"));
    expect(manifest.links).toContain(path.join(".gemini", "settings.json"));

    fs.rmSync(path.join(realHome, "settings.json"));
    agentRuntime("brain", ag, dir);
    expect(fs.existsSync(viewFile)).toBe(false);
    // 旧实现会把清单记成 `settings.json`，清理 root/settings.json，留下旧链接。
    expect(fs.existsSync(path.join(rt.home, "settings.json"))).toBe(false);
  });

  it("目录链接不可用时复制回退，源目录消失后重建不误删副本", () => {
    const dir = tmp();
    const realHome = path.join(dir, "real");
    fs.mkdirSync(path.join(realHome, "skills", "demo"), { recursive: true });
    fs.writeFileSync(path.join(realHome, "skills", "demo", "SKILL.md"), "demo\n");
    const ag = fakeAgent(realHome);
    const spy = vi.spyOn(fs, "symlinkSync").mockImplementation(() => {
      throw new Error("EPERM: symlink denied");
    });
    try {
      const rt = agentRuntime("brain", ag, dir);
      const viewSkill = path.join(rt.configDir, "skills", "demo", "SKILL.md");
      expect(fs.readFileSync(viewSkill, "utf-8")).toBe("demo\n");
      expect(fs.lstatSync(path.join(rt.configDir, "skills")).isSymbolicLink()).toBe(false);
      const manifest = JSON.parse(
        fs.readFileSync(path.join(rt.home, ".wemind-view.json"), "utf-8"),
      );
      expect(manifest.links).toContain("skills");

      fs.rmSync(path.join(realHome, "skills"), { recursive: true, force: true });
      agentRuntime("brain", ag, dir);
      // 复制回退不是双向同步；清理阶段只删链接/文件，不能把已有副本当垃圾删掉。
      expect(fs.existsSync(viewSkill)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("kiro v3 的 permissions.yaml 生成在视图里，不穿透真实目录", () => {
    const dir = tmp();
    const realHome = path.join(dir, "real");
    fs.mkdirSync(path.join(realHome, "settings"), { recursive: true });
    const realPermissions = path.join(realHome, "settings", "permissions.yaml");
    fs.writeFileSync(realPermissions, "real\n");
    const ag = { ...fakeAgent(realHome), kiroV3: true };

    const rt = agentRuntime("brain", ag, dir);
    const viewSettings = path.join(rt.configDir, "settings");
    const viewPermissions = path.join(viewSettings, "permissions.yaml");
    expect(fs.lstatSync(viewSettings).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(viewPermissions, "utf-8")).toBe("real\n");

    fs.writeFileSync(viewPermissions, "view\n");
    expect(fs.readFileSync(realPermissions, "utf-8")).toBe("real\n");
  });

  it("MCP 激活集按账号目录隔离，不共用全局 brain-mcps.json", () => {
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
    expect(addMcp("demo", ag, accountA).ok).toBe(true);
    expect(loadActive(ag.name, accountA)).toEqual(["demo"]);
    expect(loadActive(ag.name, accountB)).toEqual([]);
  });
});

describe("override 路径归一化", () => {
  it("预设里的正斜杠路径要归一成平台分隔符，否则父目录会被整体链接", () => {
    const dir = tmp();
    const ag = fakeAgent(path.join(dir, "real"));
    expect(overrideRelPaths(ag, { version: 1 })).toContain(path.join("settings", "mcp.json"));
  });

  it("生成 MCP 文件时不会穿透到真实 settings 目录", () => {
    const dir = tmp();
    const realHome = path.join(dir, "real");
    const realSettings = path.join(realHome, "settings");
    fs.mkdirSync(realSettings, { recursive: true });
    const realMcp = path.join(realSettings, "mcp.json");
    fs.writeFileSync(realMcp, '{"mcpServers":{"user":{}}}');
    const ag = fakeAgent(realHome);

    const rt = agentRuntime("brain", ag, dir);
    expect(fs.lstatSync(path.join(rt.configDir, "settings")).isSymbolicLink()).toBe(false);
    fs.writeFileSync(path.join(rt.configDir, "settings", "mcp.json"), '{"mcpServers":{}}');
    expect(fs.readFileSync(realMcp, "utf-8")).toBe('{"mcpServers":{"user":{}}}');
  });

  it("上次构建留下的父目录 junction 会在 override 路径断开，改为真实目录", () => {
    const dir = tmp();
    const realHome = path.join(dir, "real");
    const realSettings = path.join(realHome, "settings");
    fs.mkdirSync(realSettings, { recursive: true });
    const realMcp = path.join(realSettings, "mcp.json");
    fs.writeFileSync(realMcp, '{"mcpServers":{"user":{}}}');
    fs.writeFileSync(path.join(realSettings, "other.json"), '{"user":true}');

    // 模拟旧版本构建结果：整个 settings/ 是指向真实目录的 junction，清单也把它当成链接。
    const root = viewRoot("brain", "kiro", dir);
    const viewSettings = path.join(root, "settings");
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync(realSettings, viewSettings, process.platform === "win32" ? "junction" : "dir");
    fs.writeFileSync(
      path.join(root, ".wemind-view.json"),
      JSON.stringify({ version: 1, agent: "kiro", links: ["settings"], generated: [] }),
    );

    const rt = agentRuntime("brain", fakeAgent(realHome), dir);
    expect(fs.lstatSync(path.join(rt.configDir, "settings")).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(rt.configDir, "settings", "other.json"))).toBe(true);

    fs.writeFileSync(path.join(rt.configDir, "settings", "mcp.json"), '{"mcpServers":{}}');
    expect(fs.readFileSync(realMcp, "utf-8")).toBe('{"mcpServers":{"user":{}}}');
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

    const before = configFingerprint(ag, dir);
    fs.writeFileSync(settings, JSON.stringify({ mcpServers: { demo: { command: "x" } } }));
    const afterReal = configFingerprint(ag, dir);
    expect(afterReal).not.toBe(before);

    fs.mkdirSync(path.join(dir, "agent-overrides"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "agent-overrides", "kiro.json"),
      JSON.stringify({ version: 1, config: { "settings/mcp.json": { model: "x" } } }),
    );
    const afterOverlay = configFingerprint(ag, dir);
    expect(afterOverlay).not.toBe(afterReal);
  });
});

describe("homeMode：view / direct / sandbox", () => {
  beforeEach(() => resetViewFallback());

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

  it("缺省与旧值都规范化为 view", () => {
    const dir = tmp();
    withoutEnv(() => {
      expect(readHomeMode(dir)).toBe("view");
      fs.writeFileSync(homeModePath(dir), JSON.stringify({ version: 1, homeMode: "real" }));
      expect(readHomeMode(dir)).toBe("view");
      fs.writeFileSync(homeModePath(dir), JSON.stringify({ version: 1, homeMode: "mirror" }));
      expect(readHomeMode(dir)).toBe("view");
      fs.writeFileSync(homeModePath(dir), JSON.stringify({ version: 1, homeMode: "direct" }));
      expect(readHomeMode(dir)).toBe("direct");
    });
    expect(normalizeHomeMode("real")).toBe("view");
    expect(normalizeHomeMode("mirror")).toBe("view");
    expect(normalizeHomeMode("view")).toBe("view");
    expect(normalizeHomeMode("sandbox")).toBe("sandbox");
    expect(normalizeHomeMode("nope")).toBeNull();
    withoutEnv(() => writeHomeMode("view", dir));
    expect(JSON.parse(fs.readFileSync(homeModePath(dir), "utf-8")).homeMode).toBe("view");
  });

  it("direct 不生成视图，直接使用真实配置目录", () => {
    const dir = tmp();
    const realHome = path.join(dir, "real");
    fs.mkdirSync(realHome, { recursive: true });
    withoutEnv(() => writeHomeMode("direct", dir));
    const rt = withoutEnv(() => agentRuntime("brain", fakeAgent(realHome), dir));
    expect(rt).toMatchObject({
      mode: "direct",
      requestedMode: "direct",
      home: realHome,
      configDir: realHome,
    });
    expect(rt.view).toBeUndefined();
    expect(fs.existsSync(path.join(dir, "agent-view"))).toBe(false);
  });

  it("view 在真实配置目录不存在时降级 direct，且不改 runtime.json", () => {
    const dir = tmp();
    const realHome = path.join(dir, "missing");
    const rt = agentRuntime("brain", fakeAgent(realHome), dir);
    expect(rt.mode).toBe("direct");
    expect(rt.requestedMode).toBe("view");
    expect(rt.fallbackReason).toMatch(/不存在/);
    expect(rt.view).toBeUndefined();
    expect(fs.existsSync(path.join(dir, "agent-view"))).toBe(false);
    expect(readHomeMode(dir)).toBe("view");
  });

  it("view 建视图抛错时降级 direct（本次运行）", () => {
    const dir = tmp();
    const realHome = path.join(dir, "real");
    fs.mkdirSync(realHome, { recursive: true });
    const realMkdir = fs.mkdirSync.bind(fs);
    const spy = vi.spyOn(fs, "mkdirSync").mockImplementation(((p: fs.PathLike, o?: any) => {
      if (String(p).includes(`${path.sep}agent-view`)) throw new Error("EPERM: denied");
      return realMkdir(p as never, o as never);
    }) as typeof fs.mkdirSync);
    try {
      const rt = agentRuntime("brain", fakeAgent(realHome), dir);
      expect(rt.mode).toBe("direct");
      expect(rt.requestedMode).toBe("view");
      expect(rt.fallbackReason).toMatch(/构建配置视图失败/);
      expect(rt.configDir).toBe(realHome);
    } finally {
      spy.mockRestore();
    }
    expect(readHomeMode(dir)).toBe("view");
  });

  it("view 降级成功一次后，本次进程内不再重复尝试建视图", () => {
    const dir = tmp();
    const realHome = path.join(dir, "real");
    fs.mkdirSync(realHome, { recursive: true });
    const realMkdir = fs.mkdirSync.bind(fs);
    const spy = vi.spyOn(fs, "mkdirSync").mockImplementation(((p: fs.PathLike, o?: any) => {
      if (String(p).includes(`${path.sep}agent-view`)) throw new Error("EPERM: denied");
      return realMkdir(p as never, o as never);
    }) as typeof fs.mkdirSync);
    const first = agentRuntime("brain", fakeAgent(realHome), dir);
    expect(first.mode).toBe("direct");
    try {
      spy.mockClear();
      const second = agentRuntime("brain", fakeAgent(realHome), dir);
      expect(second.mode).toBe("direct");
      expect(second.fallbackReason).toBe(first.fallbackReason);
      // 复用的是缓存结论，不会再尝试创建 agent-view（工作区目录的 mkdir 不算）。
      expect(spy.mock.calls.some(([p]) => String(p).includes("agent-view"))).toBe(false);
    } finally {
      spy.mockRestore();
    }
    // 显式 reload 会清掉缓存，下一次重新尝试 view；真实目录已恢复可建视图。
    resetViewFallback("brain");
    expect(agentRuntime("brain", fakeAgent(realHome), dir).mode).toBe("view");
  });

  it("direct 忽略 overlay，不写任何视图文件", () => {
    const dir = tmp();
    const realHome = path.join(dir, "real");
    fs.mkdirSync(realHome, { recursive: true });
    fs.writeFileSync(path.join(realHome, "settings.json"), '{"model":"terminal"}');
    fs.mkdirSync(path.join(dir, "agent-overrides"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "agent-overrides", "kiro.json"),
      JSON.stringify({ version: 1, config: { "settings.json": { model: "wechat" } } }),
    );
    withoutEnv(() => writeHomeMode("direct", dir));
    const rt = withoutEnv(() => agentRuntime("brain", fakeAgent(realHome), dir));
    expect(rt.overlay).toEqual({ version: 1 });
    expect(fs.readFileSync(path.join(realHome, "settings.json"), "utf-8")).toBe(
      '{"model":"terminal"}',
    );
    expect(fs.existsSync(path.join(dir, "agent-view"))).toBe(false);
  });

  it("direct 下配置指纹为空（没有 WeMind 生成的视图要跟随）", () => {
    const dir = tmp();
    const realHome = path.join(dir, "real");
    fs.mkdirSync(path.join(realHome, "settings"), { recursive: true });
    fs.writeFileSync(path.join(realHome, "settings", "mcp.json"), "{}");
    withoutEnv(() => writeHomeMode("direct", dir));
    expect(withoutEnv(() => configFingerprint(fakeAgent(realHome), dir))).toBe("");
  });

  it("direct 下加载/卸载 MCP 直接拒绝，不写激活集", () => {
    const dir = tmp();
    const realHome = path.join(dir, "real");
    fs.mkdirSync(realHome, { recursive: true });
    withoutEnv(() => writeHomeMode("direct", dir));
    const ag = fakeAgent(realHome);
    const added = withoutEnv(() => addMcp("demo", ag, dir));
    expect(added.ok).toBe(false);
    expect(added.text).toMatch(/direct 模式/);
    expect(loadActive("kiro", dir)).toEqual([]);
  });

  it("view / direct 的入站媒体都在账号目录", () => {
    const dir = tmp();
    expect(mediaDirFor("brain", "view", dir)).toBe(path.join(dir, "media", "inbound"));
    expect(mediaDirFor("worker", "direct", dir)).toBe(path.join(dir, "media", "inbound"));
  });
});
