/**
 * 内置 agent 定义注册表。
 *
 * 定义本体是 `definitions/*.json`（纯数据，可被文档守卫直接读取）；这个模块只做三件事：
 * 展开 `~`、按 `agent-definition.ts` 的契约校验、把仍需代码解释的 hook（adapter）挂到定义上。
 * 运行期零文件 IO：JSON 在构建期静态内联，发布包里不需要带 `definitions/` 目录。
 *
 * 名称与文件名必须一致（`kiro.json` 里的 `name` 就是 `kiro`）：`name` 同时是 brain.json 的键与
 * 微信指令里的名字，复制一份定义忘了改名会让两个 agent 抢同一个槽位。
 */
import os from "node:os";
import path from "node:path";

import {
  formatAgentDefinitionProblems,
  validateAgentDefinition,
  type AgentDefinition,
} from "./agent-definition.js";
import { clineCredentialEnv } from "./cline-credentials.js";
import claudeCode from "./definitions/claude-code.json" with { type: "json" };
import cline from "./definitions/cline.json" with { type: "json" };
import codex from "./definitions/codex.json" with { type: "json" };
import copilot from "./definitions/copilot.json" with { type: "json" };
import deepseek from "./definitions/deepseek.json" with { type: "json" };
import gemini from "./definitions/gemini.json" with { type: "json" };
import kiro from "./definitions/kiro.json" with { type: "json" };
import opencode from "./definitions/opencode.json" with { type: "json" };
import pi from "./definitions/pi.json" with { type: "json" };
import qoder from "./definitions/qoder.json" with { type: "json" };

/**
 * 内置预设 = 数据定义 + 代码 hook。
 * `credentialEnv` 是函数值，数据面表达不了；P3 会把这类 hook 正式收敛成 adapter 契约。
 */
export type AcpAgentPreset = AgentDefinition & {
  credentialEnv?: (
    realHome: string | undefined,
    parentEnv: NodeJS.ProcessEnv,
  ) => Record<string, string>;
};

/** 内置 adapter 注册表：`adapter.module` → 它提供的 hook。 */
const BUILTIN_ADAPTERS: Record<string, Pick<AcpAgentPreset, "credentialEnv">> = {
  "builtin:cline-credentials": { credentialEnv: clineCredentialEnv },
};

/**
 * 顺序即 CLI/微信帮助里的展示顺序（保持迁移前的顺序，避免用户看到的名字列表突然重排）。
 * 元组第一项是文件名，第二项是 JSON 内容。
 */
const RAW_DEFINITIONS: ReadonlyArray<readonly [string, unknown]> = [
  ["kiro", kiro],
  ["gemini", gemini],
  ["copilot", copilot],
  ["opencode", opencode],
  ["deepseek", deepseek],
  ["qoder", qoder],
  ["cline", cline],
  ["pi", pi],
  ["claude-code", claudeCode],
  ["codex", codex],
];

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function normalizeEnvPaths(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([k, v]) => [k, v.includes("%HOME%") ? path.normalize(v) : v]),
  );
}

/**
 * 只展开 `~`（绝对路径字段）。相对路径字段保持 JSON 里的 `/` 写法：
 * 下游统一用 `path.join`/`path.resolve` 拼接，两种分隔符等价；保留原写法让文档与报错更好读。
 */
function normalizeDefinition(def: AgentDefinition): AgentDefinition {
  const out: AgentDefinition = { ...def };
  if (out.realHome) out.realHome = expandHome(out.realHome);
  if (out.fallbackBinPaths) out.fallbackBinPaths = out.fallbackBinPaths.map((p) => expandHome(p));
  if (out.extraConfigFiles) out.extraConfigFiles = out.extraConfigFiles.map((p) => expandHome(p));
  if (out.env) out.env = normalizeEnvPaths(out.env);
  if (out.envDefaults) out.envDefaults = normalizeEnvPaths(out.envDefaults);
  return out;
}

function loadDefinition(file: string, raw: unknown): AgentDefinition {
  const result = validateAgentDefinition(raw);
  if (!result.ok)
    throw new Error(
      `内置 agent 定义 definitions/${file}.json 不合法：\n${formatAgentDefinitionProblems(
        result.problems,
      )
        .map((p) => `  - ${p}`)
        .join("\n")}`,
    );
  if (result.value.name !== file)
    throw new Error(
      `内置 agent 定义 definitions/${file}.json 的 name 是「${result.value.name}」——文件名与 name 必须一致`,
    );
  return normalizeDefinition(result.value);
}

function toPreset(def: AgentDefinition): AcpAgentPreset {
  const module = def.adapter?.module;
  if (!module) return def;
  const adapter = BUILTIN_ADAPTERS[module];
  if (!adapter)
    throw new Error(
      `内置 agent 定义「${def.name}」声明了未注册的 adapter「${module}」——内置定义只能引用 BUILTIN_ADAPTERS 里已注册的模块`,
    );
  return { ...def, ...adapter };
}

function buildRegistry(): {
  definitions: Record<string, AgentDefinition>;
  presets: Record<string, AcpAgentPreset>;
} {
  const definitions: Record<string, AgentDefinition> = {};
  const presets: Record<string, AcpAgentPreset> = {};
  for (const [file, raw] of RAW_DEFINITIONS) {
    const def = loadDefinition(file, raw);
    definitions[def.name] = def;
    presets[def.name] = toPreset(def);
  }
  return { definitions, presets };
}

const registry = buildRegistry();

/** 内置定义（纯数据视图；用户定义层接上后与它合并，见 P1 加载层）。 */
export const BUILTIN_AGENT_DEFINITIONS: Record<string, AgentDefinition> = registry.definitions;

/** 内置预设（数据 + 代码 hook；现有解析与 spawn 路径读这个）。 */
export const ACP_AGENT_PRESETS: Record<string, AcpAgentPreset> = registry.presets;

/** 全部内置 agent 名（`auto` 不在其中：它只是「自动探测」的开关）。 */
export function builtinDefinitionNames(): string[] {
  return Object.keys(BUILTIN_AGENT_DEFINITIONS);
}
