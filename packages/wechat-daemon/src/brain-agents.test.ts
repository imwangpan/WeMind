import { describe, it, expect, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveAgent, agentProblem, AUTO_PROBE_ORDER } from "./brain-agents.js";
import {
  presetAvailable,
  presetNames,
  resolveAgentFor,
  resolvePresetByName,
} from "./brain-agents.js";

const VARS = [
  "WEMIND_BRAIN",
  "WEMIND_WORKER_BRAIN",
  "WEMIND_BRAIN_BIN",
  "WEMIND_BRAIN_ARGS",
  "WEMIND_BRAIN_SHELL",
  "WEMIND_BRAIN_HOME_ENV",
  "WEMIND_BRAIN_INHERIT",
  "WEMIND_BRAIN_REAL_HOME",
  "WEMIND_BRAIN_INHERIT_DIRS",
  "KIRO_CLI_BIN",
];

const saved: Record<string, string | undefined> = {};
for (const v of VARS) saved[v] = process.env[v];
const savedPath = process.env.PATH;

// 默认模型会从真实 `~/.dsh` 的 profile 读（deepseek 的 realProfile）：测试必须指向空 home，
// 否则结果随开发机日常 dsh 的配置变化。要测「跟随真实 profile」的用例再显式指到 fixture。
const emptyRealHome = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-brain-nohome-"));
function clearVars() {
  for (const v of VARS) delete process.env[v];
  process.env.WEMIND_BRAIN_REAL_HOME = emptyRealHome;
}

afterEach(() => {
  clearVars();
  for (const v of VARS) if (saved[v] !== undefined) process.env[v] = saved[v];
  if (savedPath !== undefined) process.env.PATH = savedPath;
});

// 独立临时目录，用于「伪造 PATH」验证 auto 探测（不依赖宿主机的真实安装）。
const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-brain-test-"));
const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-brain-empty-"));
// 伪造一份真实 dsh home：profiles/acp 的用户层带 agent-default-model（与桌面端写进去的形状一致）
const profileHome = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-brain-profile-"));
fs.mkdirSync(path.join(profileHome, "profiles", "acp"), { recursive: true });
fs.writeFileSync(
  path.join(profileHome, "profiles", "acp", "cordis.patch.yml"),
  [
    "- id: llm-pi-ai # magpie",
    "  config:",
    "    providers:",
    "      magpie: {}",
    "- id: agent-default-model # magpie",
    "  config:",
    "    provider: magpie",
    '    model: "auto/deepseek-v4.1-flash"',
    "",
  ].join("\n"),
);
afterAll(() => {
  fs.rmSync(fakeBin, { recursive: true, force: true });
  fs.rmSync(emptyBin, { recursive: true, force: true });
  fs.rmSync(emptyRealHome, { recursive: true, force: true });
  fs.rmSync(profileHome, { recursive: true, force: true });
  if (saved.WEMIND_BRAIN_REAL_HOME === undefined) delete process.env.WEMIND_BRAIN_REAL_HOME;
});

describe("resolveAgent agent", () => {
  it("显式 kiro：沿用 kiro 约定（沙箱根 / settings/mcp.json / 格式 kiro）", () => {
    clearVars();
    process.env.WEMIND_BRAIN = "kiro";
    const ag = resolveAgent();
    expect(ag.name).toBe("kiro");
    expect(ag.homeEnvVar).toBe("KIRO_HOME");
    expect(ag.configSubdir).toBe("");
    expect(ag.mcpFormat).toBe("kiro");
    expect(ag.mcpConfigFile).toBe("settings/mcp.json");
    expect(ag.catalogFile).toBe("settings/mcp.json");
    expect(ag.shell).toBe(false);
    expect(ag.env).toEqual({});
    expect(ag.requestedKey).toBe("kiro");
    expect(ag.source).toBe("env");
    expect(ag.known).toBe(true);
  });

  it("opencode：XDG_CONFIG_HOME 隔离 + opencode.json / mcp.servers + 目录与单文件继承", () => {
    clearVars();
    process.env.WEMIND_BRAIN = "opencode";
    const ag = resolveAgent();
    expect(ag.name).toBe("opencode");
    expect(ag.args).toEqual(["acp"]);
    expect(ag.shell).toBe(true); // Windows shim 需经 shell
    expect(ag.homeEnvVar).toBe("XDG_CONFIG_HOME"); // 替换 global，实现隔离
    expect(ag.configSubdir).toBe("opencode"); // 配置落在 <沙箱>/opencode/
    expect(ag.mcpFormat).toBe("opencode");
    expect(ag.mcpConfigFile).toBe("opencode.json");
    expect(ag.catalogFile).toBe("opencode.json");
    expect(ag.inheritDirs).toEqual(["skills", "agents", "commands"]);
    expect(ag.inheritFiles).toEqual(["AGENTS.md"]);
    expect(ag.env).toEqual({ OPENCODE_DISABLE_PROJECT_CONFIG: "1" });
  });

  it("deepseek：dsh.cmd + DSH_HOME + resume/model/images=false", () => {
    clearVars();
    process.env.WEMIND_BRAIN = "deepseek";
    const ag = resolveAgent();
    expect(ag.name).toBe("deepseek");
    expect(ag.bin).toBe(process.platform === "win32" ? "dsh.cmd" : "dsh");
    expect(ag.args).toEqual(["--profile", "acp"]);
    expect(ag.shell).toBe(true);
    expect(ag.homeEnvVar).toBe("DSH_HOME");
    expect(ag.restore).toBe("resume");
    expect(ag.firstFrameMs).toBe(60_000);
    expect(ag.heartbeatMs).toBe(60_000);
    expect(ag.images).toBe(false);
    expect(ag.credentialFiles).toEqual([".credentials.yaml"]);
    expect(ag.model).toBe('["deepseek-account","deepseek-flash"]');
    expect(ag.mcpViaAcp).toBe(true); // MCP 走 session/new|resume 的 mcpServers，不写文件
  });

  it("模型可覆盖：presets[agent 名].model 优先于预设值（切走再切回也还在）", () => {
    clearVars();
    process.env.WEMIND_BRAIN = "deepseek";
    const cfg = {
      agent: "opencode",
      presets: { deepseek: { model: '["deepseek-account","deepseek-v4-pro"]' } },
    };
    expect(resolveAgent(cfg).model).toBe('["deepseek-account","deepseek-v4-pro"]');
  });

  it("模型写 auto/default：真实 profile 读不到时不下发（跟随 agent 自己的默认）", () => {
    clearVars();
    process.env.WEMIND_BRAIN = "deepseek";
    expect(resolveAgent({ agent: "deepseek", model: "auto" }).model).toBeUndefined();
    expect(resolveAgent({ agent: "deepseek", model: "default" }).model).toBeUndefined();
  });

  it("默认模型跟随真实 profile 的 agent-default-model（ACP 桥不读那个键，值由 WeMind 补进沙箱并下发）", () => {
    clearVars();
    process.env.WEMIND_BRAIN = "deepseek";
    process.env.WEMIND_BRAIN_REAL_HOME = profileHome;
    const derived = '["magpie","auto/deepseek-v4.1-flash"]';
    expect(resolveAgent().model).toBe(derived); // 没写 = 跟随
    expect(resolveAgent({ agent: "deepseek", model: "auto" }).model).toBe(derived); // auto = 跟随
    // 显式值优先于真实 profile
    expect(
      resolveAgent({ agent: "deepseek", model: '["deepseek-account","deepseek-v4-pro"]' }).model,
    ).toBe('["deepseek-account","deepseek-v4-pro"]');
    // 关掉继承 = 不读真实 home → 回退预设值
    process.env.WEMIND_BRAIN_INHERIT = "0";
    expect(resolveAgent().model).toBe('["deepseek-account","deepseek-flash"]');
  });

  it("真实 profile 读不到时：没写用预设值兜底，auto 不下发", () => {
    clearVars();
    process.env.WEMIND_BRAIN = "deepseek"; // clearVars 已把 REAL_HOME 指到空目录
    expect(resolveAgent().model).toBe('["deepseek-account","deepseek-flash"]');
    expect(resolveAgent({ agent: "deepseek", model: "auto" }).model).toBeUndefined();
  });

  it("qoder：原生 qodercli + QODER_CONFIG_DIR 沙箱 + settings.json + 凭据/标识文件", () => {
    clearVars();
    process.env.WEMIND_BRAIN = "qoder";
    const ag = resolveAgent();
    expect(ag.name).toBe("qoder");
    expect(ag.bin).toMatch(/qodercli(\.exe)?$/); // 原生二进制，直接起（不走 qoder 分发器）
    expect(ag.args).toEqual(["--acp", "--yolo"]);
    expect(ag.shell).toBe(false); // 原生 .exe/.bin，不走 shell
    expect(ag.homeEnvVar).toBeUndefined(); // 用 env 指到「配置目录」本身，而非沙箱根
    expect(ag.env.QODER_CONFIG_DIR).toMatch(/^%HOME%[\\/]qoder$/);
    expect(ag.configSubdir).toBe("qoder");
    expect(ag.mcpFormat).toBe("kiro"); // 键名同为 mcpServers
    expect(ag.mcpConfigFile).toBe("settings.json");
    expect(ag.catalogFile).toBe("settings.json");
    expect(ag.settingsBase).toBe("settings.json");
    expect(ag.credentialFiles).toEqual([".auth/user"]);
    expect(ag.identityFiles).toEqual([".auth/machine_id"]);
    expect(ag.inheritDirs).toEqual(["memory", "skills", "agents", "commands"]);
    expect(ag.inheritFiles).toEqual(["AGENTS.md"]);
    expect(ag.mcpViaAcp).toBe(false);
  });

  it("kiro/opencode：mcpViaAcp 默认 false（仍走沙箱配置文件）", () => {
    clearVars();
    process.env.WEMIND_BRAIN = "kiro";
    expect(resolveAgent().mcpViaAcp).toBe(false);
    process.env.WEMIND_BRAIN = "opencode";
    expect(resolveAgent().mcpViaAcp).toBe(false);
  });

  it("环境变量可覆盖继承目录清单", () => {
    clearVars();
    process.env.WEMIND_BRAIN = "opencode";
    process.env.WEMIND_BRAIN_INHERIT_DIRS = "skills,foo";
    expect(resolveAgent().inheritDirs).toEqual(["skills", "foo"]);
  });
});

describe("resolveAgent 选择来源与优先级", () => {
  it("brain.json（cfg）可选中 agent，来源 file", () => {
    clearVars();
    const ag = resolveAgent({ agent: "opencode" });
    expect(ag.name).toBe("opencode");
    expect(ag.requestedKey).toBe("opencode");
    expect(ag.source).toBe("file");
  });

  it("环境变量覆盖 brain.json（source=env）", () => {
    clearVars();
    process.env.WEMIND_BRAIN = "kiro";
    const ag = resolveAgent({ agent: "opencode" });
    expect(ag.name).toBe("kiro");
    expect(ag.source).toBe("env");
  });

  it("brain.json 的 bin/args 覆盖 agent 细节", () => {
    clearVars();
    const ag = resolveAgent({
      agent: "opencode",
      bin: "/opt/oc",
      args: ["acp", "--x"],
      homeEnvVar: "OC_HOME",
    });
    expect(ag.bin).toBe("/opt/oc");
    expect(ag.args).toEqual(["acp", "--x"]);
    expect(ag.homeEnvVar).toBe("OC_HOME");
  });

  it("环境变量切到别的 agent 时，不再沿用 brain.json 里旧 agent 的 bin/args/shell", () => {
    clearVars();
    process.env.WEMIND_BRAIN = "qoder";
    const ag = resolveAgent({
      agent: "deepseek",
      bin: "C:\\dsh\\dsh.cmd",
      args: ["--profile", "acp"],
      shell: true,
    });
    expect(ag.name).toBe("qoder");
    expect(ag.bin).toMatch(/qodercli(\.exe)?$/);
    expect(ag.args).toEqual(["--acp", "--yolo"]);
    expect(ag.shell).toBe(false);
  });

  it("未知 agent：不再静默回退 kiro，known=false 且 agentProblem 报错", () => {
    clearVars();
    process.env.WEMIND_BRAIN = "opencod"; // 拼错
    const ag = resolveAgent();
    expect(ag.known).toBe(false);
    expect(agentProblem(ag)).toMatch(/未知 agent/);
  });
});

describe("resolveAgent auto 探测", () => {
  it("选中 PATH 上第一个可用的 agent（伪造 opencode）", () => {
    clearVars();
    fs.writeFileSync(path.join(fakeBin, "opencode"), "");
    process.env.PATH = fakeBin;
    const ag = resolveAgent();
    expect(ag.requestedKey).toBe("auto");
    expect(ag.source).toBe("auto");
    expect(ag.name).toBe("opencode");
    expect(ag.available).toBe(true);
    expect(agentProblem(ag)).toBeNull();
  });

  it("一个都探测不到 → available=false，并给出明确说明", () => {
    clearVars();
    process.env.PATH = emptyBin;
    const ag = resolveAgent();
    expect(ag.requestedKey).toBe("auto");
    expect(ag.available).toBe(false);
    expect(agentProblem(ag)).toMatch(/自动探测/);
  });

  it("显式指定但二进制缺失 → available=false，提示安装/切换", () => {
    clearVars();
    process.env.WEMIND_BRAIN = "kiro";
    process.env.PATH = emptyBin;
    const ag = resolveAgent();
    expect(ag.available).toBe(false);
    expect(agentProblem(ag)).toMatch(/找不到大脑/);
  });

  it("auto 探测把 qoder 排在最后，不影响老用户", () => {
    expect(AUTO_PROBE_ORDER[AUTO_PROBE_ORDER.length - 1]).toBe("qoder");
    expect(AUTO_PROBE_ORDER.indexOf("qoder")).toBeGreaterThan(AUTO_PROBE_ORDER.indexOf("deepseek"));
  });
});

describe("resolveAgentFor（对话大脑 / 任务 worker 两个角色）", () => {
  it("未设 worker 段 → worker 回落到顶层（拆分角色之前的行为）", () => {
    clearVars();
    const cfg = { agent: "opencode" };
    expect(resolveAgentFor(cfg, "worker").name).toBe("opencode");
    expect(resolveAgentFor(cfg, "worker").source).toBe("file");
    expect(resolveAgentFor(cfg, "brain").name).toBe("opencode");
  });

  it("worker 段优先于顶层；两个角色互不影响", () => {
    clearVars();
    const cfg = { agent: "kiro", worker: { agent: "opencode" } };
    expect(resolveAgentFor(cfg, "brain").name).toBe("kiro");
    expect(resolveAgentFor(cfg, "worker").name).toBe("opencode");
  });

  it("WEMIND_WORKER_BRAIN 只影响 worker；未设时回落 WEMIND_BRAIN", () => {
    clearVars();
    process.env.WEMIND_BRAIN = "kiro";
    process.env.WEMIND_WORKER_BRAIN = "qoder";
    expect(resolveAgentFor({ agent: "opencode" }, "brain").name).toBe("kiro");
    expect(resolveAgentFor({ agent: "opencode" }, "worker").name).toBe("qoder");
    delete process.env.WEMIND_WORKER_BRAIN;
    expect(resolveAgentFor({ agent: "opencode" }, "worker").name).toBe("kiro");
  });

  it("worker 段的 bin/args 只作用于 worker，且不会串给别的 agent", () => {
    clearVars();
    const cfg = {
      agent: "kiro",
      worker: { agent: "opencode", bin: "/opt/oc", args: ["acp", "--z"] },
    };
    const w = resolveAgentFor(cfg, "worker");
    expect(w.bin).toBe("/opt/oc");
    expect(w.args).toEqual(["acp", "--z"]);
    expect(resolveAgentFor(cfg, "brain").bin).not.toBe("/opt/oc");
  });

  it("env 切到别的 agent 时，worker 段的 bin/args 也不沿用", () => {
    clearVars();
    process.env.WEMIND_WORKER_BRAIN = "qoder";
    const cfg = { agent: "kiro", worker: { agent: "deepseek", bin: "C:\\dsh\\dsh.cmd" } };
    const w = resolveAgentFor(cfg, "worker");
    expect(w.name).toBe("qoder");
    expect(w.bin).toMatch(/qodercli(\.exe)?$/);
  });
});

describe("presets 段与 resolvePresetByName（命令驱动的切换）", () => {
  it("全部 agent 名可见（帮助/报错都靠它）", () => {
    const names = presetNames();
    expect(names).toContain("kiro");
    expect(names).toContain("deepseek");
    expect(names).toContain("opencode");
    expect(names).not.toContain("auto"); // auto 只是「自动探测」开关，不是 agent，不进列表
  });

  it("无视 WEMIND_BRAIN*：命令点名 opencode 就是 opencode", () => {
    clearVars();
    process.env.WEMIND_BRAIN = "kiro";
    process.env.WEMIND_WORKER_BRAIN = "qoder";
    // 不能依赖宿主机装了 opencode（CI 的 ubuntu runner 上没有）：伪造 PATH
    fs.writeFileSync(path.join(fakeBin, "opencode"), "");
    process.env.PATH = fakeBin;
    const r = resolvePresetByName("opencode");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.agent.name).toBe("opencode");
      expect(r.agent.source).toBe("file");
      expect(r.agent.requestedKey).toBe("opencode");
    }
  });

  it("未知 agent / 空名字 → ok:false，带上可选清单", () => {
    clearVars();
    const bad = resolvePresetByName("opencod");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.problem).toMatch(/未知 agent/);
    const empty = resolvePresetByName("  ");
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.problem).toMatch(/需要指定 agent 名/);
  });

  it("二进制找不到 → ok:false + 可读原因（不 spawn）", () => {
    clearVars();
    process.env.PATH = emptyBin;
    const r = resolvePresetByName("kiro");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toMatch(/找不到/);
  });

  it("auto：命令里显式 auto 也走探测", () => {
    clearVars();
    fs.writeFileSync(path.join(fakeBin, "opencode"), "");
    process.env.PATH = fakeBin;
    const r = resolvePresetByName("auto");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent.name).toBe("opencode");
  });

  it("★ 切走再切回不丢 --bin：presets[deepseek] 里的绝对路径仍被采用", () => {
    clearVars();
    process.env.PATH = emptyBin; // PATH 上没有 dsh，只能靠 presets 段
    const dsh = path.join(fakeBin, "dsh2.cmd");
    fs.writeFileSync(dsh, "");
    const cfg = { agent: "opencode", presets: { deepseek: { bin: dsh } } };
    expect(presetAvailable("deepseek")).toBe(false);
    expect(presetAvailable("deepseek", cfg)).toBe(true); // auto 探测也会算上它
    const r = resolvePresetByName("deepseek", cfg);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.agent.bin).toBe(dsh);
      expect(r.agent.available).toBe(true);
    }
  });

  it("不属于目标的顶层覆盖不会被沿用（切到别的 agent 时不拿旧 bin 去起）", () => {
    clearVars();
    fs.writeFileSync(path.join(fakeBin, "opencode"), ""); // 同上：不依赖宿主机装没装
    process.env.PATH = fakeBin;
    const cfg = { agent: "deepseek", bin: "C:\\dsh\\dsh.cmd", args: ["--profile", "acp"] };
    const r = resolvePresetByName("opencode", cfg);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.agent.args).toEqual(["acp"]);
      expect(r.agent.bin).not.toBe("C:\\dsh\\dsh.cmd");
    }
  });

  it("模型覆盖跟着切换走：presets 里的 model 生效，顶层显式 auto 压过预设值", () => {
    clearVars();
    process.env.PATH = emptyBin; // PATH 上没有 dsh，只能靠 presets 段
    const dsh = path.join(fakeBin, "dsh-model.cmd");
    fs.writeFileSync(dsh, "");
    const pro = '["deepseek-account","deepseek-v4-pro"]';
    // 目标 agent 不是顶层那个 → 用 presets[deepseek].model
    const r = resolvePresetByName("deepseek", {
      agent: "opencode",
      presets: { deepseek: { bin: dsh, model: pro } },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent.model).toBe(pro);
    // 顶层（写入磁盘那个 agent）的显式 auto 优先：不指定，跟随 agent 默认
    const r2 = resolvePresetByName("deepseek", {
      agent: "deepseek",
      model: "auto",
      presets: { deepseek: { bin: dsh, model: pro } },
    });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.agent.model).toBeUndefined();
  });
});
