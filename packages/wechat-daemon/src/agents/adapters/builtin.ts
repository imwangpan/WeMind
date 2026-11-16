/**
 * 内置 adapter：把原先写死在核心里的 per-agent 逻辑按 hook 收拢。
 *
 * 这里允许出现 agent 名——它是「内置适配知识」的唯一位置（外加 definitions/*.json）。
 * 核心解析、副本、MCP、指纹、附件与提示只按 hook 分派，不再按 agent 名分支。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentAdapter } from "../agent-adapter.js";
import { clineCredentialEnv } from "../cline-credentials.js";
import {
  acpModelHint,
  acpOverrideHint,
  copyProfilePatch,
  readProfileDefaultModel,
  stripWechatMcpEntries,
} from "../profile-model.js";
import { copyFileIndependent } from "../managed/mcp-adapters.js";
import { parseJsonc } from "../managed/agent-mcp.js";
import { writeJsonAtomic, writeFileAtomic } from "../../shared/io/atomic-json.js";

function kiroEngineFromArgs(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--agent-engine=")) return args[i].split("=")[1];
    if (args[i] === "--agent-engine") return args[i + 1];
  }
  return undefined;
}

function kiroEngineFromSettings(realHome: string | undefined): string | undefined {
  if (!realHome) return undefined;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(realHome, "settings", "cli.json"), "utf-8"));
    const v = j?.["acp.agentEngine"];
    return typeof v === "string" ? v.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

const kiroMajorCache = new Map<string, number | null>();

/** `kiro-cli --version` 的主版本（只探一次；找不到/超时/解析失败都按 null，调用方回退 v2）。 */
function kiroCliMajor(binPath: string | null): number | null {
  if (!binPath) return null;
  if (kiroMajorCache.has(binPath)) return kiroMajorCache.get(binPath) ?? null;
  let major: number | null = null;
  try {
    const r = spawnSync(binPath, ["--version"], {
      encoding: "utf-8",
      timeout: 5_000,
      windowsHide: true,
    });
    const m = /(?:^|\s)(\d+)\.\d+\.\d+/.exec(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
    if (m) major = Number(m[1]);
  } catch {
    /* 找不到/超时：按未知处理 */
  }
  kiroMajorCache.set(binPath, major);
  return major;
}

function resolveKiroEngine(
  args: readonly string[],
  realHome: string | undefined,
  binPath: string | null,
): string {
  const fromArgs = kiroEngineFromArgs(args);
  if (fromArgs) return fromArgs.toLowerCase() === "v3" ? "v3" : "v2";
  const fromSettings = kiroEngineFromSettings(realHome);
  if (fromSettings) return fromSettings === "v3" ? "v3" : "v2";
  return (kiroCliMajor(binPath) ?? 0) >= 3 ? "v3" : "v2";
}

/** v3 拒绝 v2 专属的整会话信任参数；v3 的免审批改由 managed `settings/permissions.yaml` 承担。 */
function stripKiroV2TrustArgs(args: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--trust-all-tools" || a === "-a") continue;
    if (a === "--trust-tools") {
      i++;
      continue;
    }
    if (a.startsWith("--trust-tools=")) continue;
    kept.push(a);
  }
  return kept;
}

/** DSH 会话持久化目录（账号数据目录内，按角色分开）。 */
function dshSessionPatchFor(
  role: "brain" | "worker",
  dataDir: string,
): { file: string; root: string } {
  const dir = path.join(dataDir, "agent-sessions", "deepseek");
  return {
    file: path.join(dir, `session-root-${role}.patch.yml`),
    root: path.join(dir, role),
  };
}

/** managed 下继承 kiro 真实配置目录的 settings/*（MCP 必须由激活集/全量集权威生成）。 */
function inheritKiroSettings(realHome: string, targetConfigDir: string): void {
  const realSettings = path.join(realHome, "settings");
  const targetSettings = path.join(targetConfigDir, "settings");
  try {
    fs.mkdirSync(targetSettings, { recursive: true });
  } catch {
    /* ignore */
  }
  let names: string[] = [];
  try {
    names = fs.readdirSync(realSettings);
  } catch {
    /* 真实配置目录不存在：没有可继承的 settings */
  }
  for (const name of names) {
    if (name === "mcp.json") continue;
    try {
      const src = path.join(realSettings, name);
      if (fs.statSync(src).isFile()) copyFileIndependent(src, path.join(targetSettings, name));
    } catch {
      /* best-effort */
    }
  }
}

/** managed 下继承 opencode.json/jsonc 的非 MCP 设置（model/permission 等原样保留）。 */
function inheritOpencodeSettings(realHome: string, targetConfigDir: string): void {
  const src = ["opencode.json", "opencode.jsonc"]
    .map((name) => path.join(realHome, name))
    .find((file) => fs.existsSync(file));
  if (!src) return;
  let parsed: Record<string, unknown> | null = null;
  try {
    const raw = fs.readFileSync(src, "utf-8");
    parsed = src.endsWith(".jsonc")
      ? parseJsonc(raw)
      : (JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return;
  }
  if (!parsed) return;
  delete parsed.mcp; // MCP 由激活集/全量集权威覆盖
  writeJsonAtomic(path.join(targetConfigDir, "opencode.json"), parsed);
}

/** 副本 profile 文件里剔除微信 MCP 条目（真实文件不动）。 */
function stripManagedWechat(file: string): string[] {
  try {
    const { text, removed } = stripWechatMcpEntries(fs.readFileSync(file, "utf-8"));
    if (!removed.length) return [];
    writeFileAtomic(file, text);
    return removed;
  } catch {
    return [];
  }
}

const clineAdapter: AgentAdapter = {
  apiVersion: 1,
  env: {
    derive: ({ realHome, parentEnv }) => clineCredentialEnv(realHome, parentEnv),
  },
  hints: {
    autoProbe: 20,
    install: () =>
      '找不到 Cline CLI 的「cline.cmd」。安装：`npm i -g cline`（Node 20+），装完后重开终端；或用 `wemind brain set cline --bin "<...>\\cline.cmd"`',
    auth: ({ message }) =>
      /authentication required|authenticate|unauthorized|not authenticated/i.test(message)
        ? "Cline 的 ACP 只自动恢复 cline / cline-pass / openai-codex 三种登录；用自定义 provider（如 openai-compatible）时，请在启动 wemind 的环境里设置 CLINE_PROVIDER 与 CLINE_API_KEY（设置后重启一次 daemon）。"
        : undefined,
  },
};

const kiroAdapter: AgentAdapter = {
  apiVersion: 1,
  env: {
    binOverride: ({ parentEnv }) => parentEnv.KIRO_CLI_BIN?.trim(),
    binOverrideNames: ["KIRO_CLI_BIN"],
  },
  engine: {
    prepareArgs: ({ args, realHome, binPath }) => {
      const engine = resolveKiroEngine(args, realHome, binPath);
      if (engine !== "v3") return { args: [...args], engine };
      const next = stripKiroV2TrustArgs(args);
      if (!kiroEngineFromArgs(next)) next.push("--agent-engine", "v3");
      return { args: next, engine };
    },
  },
  spawn: {
    prepareManaged: ({ agent, configDir }) => {
      if (agent.engine !== "v3") return;
      try {
        const dst = path.join(configDir, "settings", "permissions.yaml");
        if (fs.existsSync(dst)) return;
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, "rules:\n  - capability: all\n    effect: allow\n", "utf-8");
      } catch {
        /* best-effort */
      }
    },
  },
  settings: {
    inherit: ({ realHome, targetConfigDir }) => inheritKiroSettings(realHome, targetConfigDir),
  },
  hints: { autoProbe: 60 },
};

const deepseekAdapter: AgentAdapter = {
  apiVersion: 1,
  profile: {
    readDefaultModel: (realHome, profile) => readProfileDefaultModel(realHome, profile),
    copyForManaged: ({ realHome, profile, targetHome, stripAllMcp }) =>
      copyProfilePatch(realHome, profile, targetHome, { stripAllMcp }),
    managedFiles: ({ base, agent }) =>
      agent.realProfile
        ? ["cordis.patch.yml", "cordis.yml"].map((name) =>
            path.join(base, "profiles", agent.realProfile!, name),
          )
        : [],
    stripManagedWechat,
    hints: (realHome, profile) => ({
      override: acpOverrideHint(realHome, profile),
      model: acpModelHint(realHome, profile),
    }),
  },
  spawn: {
    prepareArgs: ({ definition, role, dataDir, args, homeMode }) => {
      if (!definition.isolateSessions || homeMode !== "managed" || args.includes("--patch"))
        return { args };
      const sessionPatch = dshSessionPatchFor(role, dataDir);
      return { args: [...args, "--patch", sessionPatch.file], sessionPatch };
    },
    prepare: ({ agent }) => {
      const patch = agent.sessionPatch;
      if (!patch) return;
      try {
        fs.mkdirSync(patch.root, { recursive: true });
        fs.mkdirSync(path.dirname(patch.file), { recursive: true });
        // DSH 的 patch 是 YAML 列表；JSON.stringify 给双引号字符串，Windows 反斜杠也能正确转义。
        const body = `- id: session-persistence-jsonl\n  config:\n    root: ${JSON.stringify(patch.root)}\n`;
        if (!fs.existsSync(patch.file) || fs.readFileSync(patch.file, "utf-8") !== body)
          fs.writeFileSync(patch.file, body, "utf-8");
      } catch {
        /* best-effort：写不了就让 agent 自己报错（缺 --patch 文件比静默换目录更容易诊断） */
      }
    },
  },
  fingerprint: {
    extraFiles: ({ base, agent }) => {
      if (!agent.realProfile) return [];
      const dir = path.join(base, "profiles", agent.realProfile);
      try {
        return fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => path.join(dir, e.name));
      } catch {
        return [];
      }
    },
  },
  hints: {
    autoProbe: 50,
    install: () =>
      '找不到 DeepSeek 的「dsh.cmd」。桌面端通常有 dsh.cmd；把它的绝对路径传给 `wemind brain set deepseek --bin "<...>\\dsh.cmd"`',
  },
};

const opencodeAdapter: AgentAdapter = {
  apiVersion: 1,
  settings: {
    inherit: ({ realHome, targetConfigDir }) => inheritOpencodeSettings(realHome, targetConfigDir),
  },
  hints: { autoProbe: 10 },
};

const qoderAdapter: AgentAdapter = {
  apiVersion: 1,
  hints: {
    autoProbe: 30,
    install: () =>
      '找不到 Qoder CLI 的「qodercli.exe」。官方安装会放在 ~/.qoder/bin/qodercli/ 并加入 PATH；确认后重开终端，或 `wemind brain set qoder --bin "<...>\\qodercli.exe"`',
  },
};

const geminiAdapter: AgentAdapter = {
  apiVersion: 1,
  hints: { autoProbe: 40 },
};

const claudeCodeAdapter: AgentAdapter = {
  apiVersion: 1,
  fingerprint: {
    volatile: [
      ".claude.json",
      "history.jsonl",
      "todos.json",
      "statsig",
      "shell-snapshots",
      "projects",
    ],
  },
  paths: {
    sensitive: ({ agent }) => {
      const out: string[] = [];
      if (agent.realHome) out.push(path.join(agent.realHome, "settings.json"));
      out.push(path.join(os.homedir(), ".claude.json"));
      return out;
    },
  },
  hints: {
    install: () =>
      "`npm i -g @agentclientprotocol/claude-agent-acp`（装完得到 claude-agent-acp；Windows 上是 claude-agent-acp.cmd；**需 Node ≥22**）",
  },
};

const piAdapter: AgentAdapter = {
  apiVersion: 1,
  hints: {
    install: () =>
      "`npm i -g pi-acp`（装完得到 pi-acp；Windows 上是 pi-acp.cmd）；另需 `npm i -g @earendil-works/pi-coding-agent` 提供 pi 本体，并在终端里先登录/配好模型",
  },
};

const codexAdapter: AgentAdapter = {
  apiVersion: 1,
  hints: {
    install: () =>
      "`npm i -g @agentclientprotocol/codex-acp`（装完得到 codex-acp；Windows 上是 codex-acp.cmd）",
  },
};

export const BUILTIN_AGENT_ADAPTERS: Record<string, AgentAdapter> = {
  "builtin:cline-credentials": clineAdapter,
  "builtin:kiro": kiroAdapter,
  "builtin:deepseek": deepseekAdapter,
  "builtin:opencode": opencodeAdapter,
  "builtin:qoder": qoderAdapter,
  "builtin:gemini": geminiAdapter,
  "builtin:claude-code": claudeCodeAdapter,
  "builtin:pi": piAdapter,
  "builtin:codex": codexAdapter,
};

export function isBuiltinAdapterModule(module: string): boolean {
  return Object.hasOwn(BUILTIN_AGENT_ADAPTERS, module);
}
