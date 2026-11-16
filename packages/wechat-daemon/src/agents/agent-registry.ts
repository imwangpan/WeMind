/**
 * 内置 agent 定义注册表。
 *
 * 定义本体是 `definitions/*.json`（纯数据，可被文档守卫直接读取）；这个模块只做三件事：
 * 展开 `~`、按 `agent-definition.ts` 的契约校验、把仍需代码解释的 hook（adapter）挂到定义上。
 * 内置定义在构建期静态内联，发布包里不需要带 `definitions/` 目录；运行期只扫一个本机目录
 * `~/.wemind/.agents/`（按目录指纹缓存，新增/修改/删除后下一次解析自动重读）。
 *
 * 名称与文件名必须一致（`kiro.json` 里的 `name` 就是 `kiro`）：`name` 同时是 brain.json 的键与
 * 微信指令里的名字，复制一份定义忘了改名会让两个 agent 抢同一个槽位。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AGENT_MCP_FORMATS,
  formatAgentDefinitionProblems,
  validateAgentDefinition,
  type AgentDefinition,
  type AgentDefinitionProblem,
} from "./agent-definition.js";
import type { AgentAdapter } from "./agent-adapter.js";
import { loadAgentAdapterSync } from "./agent-adapter-loader.js";
import { agentSourcesFile, agentsDir } from "./agent-paths.js";
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
 * `hooks` 是 adapter 模块解析后的结果；数据面表达不了的东西都在那里。
 */
export type AcpAgentPreset = AgentDefinition & {
  hooks?: AgentAdapter;
  /** adapter 的实际来源（内置模块名或解析后的绝对路径），用于来源可见性。 */
  adapterSource?: string;
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

function loadBuiltinDefinition(file: string, raw: unknown): AgentDefinition {
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

/**
 * 把一份已校验的定义挂上它声明的内置 hook。
 * 本地文件与 `agent check <文件>` 也走这里，保证「安装后」与「安装前检查」看到的是同一套 adapter。
 */
export function presetForDefinition(def: AgentDefinition, definitionFile?: string): AcpAgentPreset {
  const loaded = def.adapter ? loadAgentAdapterSync(def, definitionFile) : null;
  if (loaded && !loaded.ok) throw new Error(loaded.error);
  if (def.mcpFormat && !(AGENT_MCP_FORMATS as readonly string[]).includes(def.mcpFormat)) {
    if (!loaded?.ok || !loaded.adapter.mcp)
      throw new Error(
        `agent「${def.name}」的自定义 mcpFormat「${def.mcpFormat}」需要 adapter 提供 mcp.read/write hook`,
      );
  }
  return loaded?.ok ? { ...def, hooks: loaded.adapter, adapterSource: loaded.source } : def;
}

function toBuiltinPreset(def: AgentDefinition, file: string): AcpAgentPreset {
  return presetForDefinition(def, file);
}

function buildBuiltinRegistry(): {
  definitions: Record<string, AgentDefinition>;
  presets: Record<string, AcpAgentPreset>;
} {
  const definitions: Record<string, AgentDefinition> = {};
  const presets: Record<string, AcpAgentPreset> = {};
  for (const [file, raw] of RAW_DEFINITIONS) {
    const def = loadBuiltinDefinition(file, raw);
    definitions[def.name] = def;
    presets[def.name] = toBuiltinPreset(def, `definitions/${file}.json`);
  }
  return { definitions, presets };
}

const builtinRegistry = buildBuiltinRegistry();

/** 内置定义（纯数据视图；不含本机定义层）。 */
export const BUILTIN_AGENT_DEFINITIONS: Record<string, AgentDefinition> =
  builtinRegistry.definitions;

/** 一根定义来自哪一层。P4 的「数据包」也落在本机目录里，届时再加 kind。 */
export type AgentDefinitionSource = {
  kind: "builtin" | "package" | "local";
  /** 内置为 `definitions/<name>.json`，本机为绝对路径。 */
  file: string;
};

/** 坏定义：不参与解析，但按文件名占位——同名内置不会被静默回退。 */
export type BrokenAgentDefinition = {
  name: string;
  file: string;
  problems: AgentDefinitionProblem[];
};

export type AgentRegistry = {
  /** 本机定义目录（即使不存在也返回约定路径，便于报错）。 */
  dir: string;
  /** 目录本身读不了时的原因（不是某个定义坏了）。 */
  dirError?: string;
  definitions: Record<string, AgentDefinition>;
  presets: Record<string, AcpAgentPreset>;
  sources: Record<string, AgentDefinitionSource>;
  broken: Record<string, BrokenAgentDefinition>;
};

export { agentsDir };

type LocalFile = { file: string; name: string; mtimeMs: number; size: number };

function errorCode(e: unknown): string {
  return typeof e === "object" && e !== null && "code" in e
    ? String((e as { code: unknown }).code)
    : String(e);
}

/**
 * 只做目录扫描与 stat：每次解析都扫一遍（几个小文件），不做 fs.watch。
 * 指纹包含目录路径、文件名、mtime 与大小——够发现新增/删除/改名/保存，又不用每次解析 JSON。
 */
function scanLocalFiles(dir: string): {
  files: LocalFile[];
  fingerprint: string;
  dirError?: string;
} {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (errorCode(e) === "ENOENT") return { files: [], fingerprint: `${dir}|missing` };
    return {
      files: [],
      fingerprint: `${dir}|error:${errorCode(e)}`,
      dirError: `无法读取 agent 定义目录 ${dir}：${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const files: LocalFile[] = [];
  const parts = [`dir:${dir}`];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    if (!entry.name.toLowerCase().endsWith(".json")) continue;
    const file = path.join(dir, entry.name);
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    files.push({ file, name: entry.name, mtimeMs: st.mtimeMs, size: st.size });
    parts.push(`${entry.name}:${st.mtimeMs}:${st.size}`);
  }
  return { files, fingerprint: parts.join("|") };
}

function brokenOf(
  name: string,
  file: string,
  problems: AgentDefinitionProblem[],
): BrokenAgentDefinition {
  return { name: name.toLowerCase(), file, problems };
}

/**
 * 读一份本机定义。失败不抛：返回 broken，让同名内置被遮住、选择时报详细原因。
 * 文件名与 `name` 必须一致——`brain.json` 与微信指令都按文件名找它，不一致会让两份定义抢同一个槽位。
 */
function readLocalDefinition(
  file: string,
  stem: string,
): { preset: AcpAgentPreset } | { broken: BrokenAgentDefinition } {
  const key = stem.toLowerCase();
  let raw: unknown;
  try {
    // Windows 编辑器常写 UTF-8 BOM；JSON.parse 会把 BOM 当非法字符。
    raw = JSON.parse(fs.readFileSync(file, "utf-8").replace(/^\uFEFF/, ""));
  } catch (e) {
    return {
      broken: brokenOf(key, file, [
        {
          path: "(file)",
          message: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}`,
        },
      ]),
    };
  }
  const result = validateAgentDefinition(raw);
  if (!result.ok) return { broken: brokenOf(key, file, result.problems) };
  const def = result.value;
  const expected = `${def.name}.json`;
  if (def.name !== stem)
    return {
      broken: brokenOf(key, file, [
        {
          path: "name",
          message: `文件名是「${path.basename(file)}」，定义里的 name 是「${def.name}」——两者必须一致（应为 ${expected}）`,
        },
      ]),
    };
  if (def.name === "auto")
    return {
      broken: brokenOf(key, file, [
        { path: "name", message: "`auto` 是自动探测开关，不能作为 agent 名" },
      ]),
    };
  let preset: AcpAgentPreset;
  try {
    preset = presetForDefinition(normalizeDefinition(def), file);
  } catch (e) {
    return {
      broken: brokenOf(key, file, [
        { path: "adapter.module", message: e instanceof Error ? e.message : String(e) },
      ]),
    };
  }
  return { preset };
}

function buildRegistry(dir: string, scan: ReturnType<typeof scanLocalFiles>): AgentRegistry {
  const definitions = { ...builtinRegistry.definitions };
  const presets = { ...builtinRegistry.presets };
  const sources: Record<string, AgentDefinitionSource> = {};
  const broken: Record<string, BrokenAgentDefinition> = {};
  const installed = readInstalledSources();
  for (const [name] of RAW_DEFINITIONS)
    sources[name] = { kind: "builtin", file: `definitions/${name}.json` };

  // 先按文件名（小写）分组：大小写不敏感文件系统上 `Kiro.json` / `kiro.json` 会互相覆盖，
  // 这种重名无法判断用户想用哪份，整组标坏比挑一份更安全。
  const groups = new Map<string, LocalFile[]>();
  for (const item of scan.files) {
    const stem = item.name.slice(0, -".json".length);
    const key = stem.toLowerCase();
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }

  for (const [key, items] of groups) {
    if (items.length > 1) {
      broken[key] = brokenOf(key, items[0].file, [
        {
          path: "(file)",
          message: `定义文件名重复（大小写不敏感）：${items.map((x) => path.basename(x.file)).join(" / ")}`,
        },
      ]);
      delete definitions[key];
      delete presets[key];
      delete sources[key];
      continue;
    }
    const item = items[0];
    const stem = item.name.slice(0, -".json".length);
    const loaded = readLocalDefinition(item.file, stem);
    if ("broken" in loaded) {
      broken[key] = loaded.broken;
      // 坏定义在解析层表现为「不存在」：同名内置也不会被静默使用。
      delete definitions[key];
      delete presets[key];
      delete sources[key];
      continue;
    }
    const name = loaded.preset.name;
    definitions[name] = loaded.preset;
    presets[name] = loaded.preset;
    sources[name] = {
      kind: installed[name]?.kind === "package" ? "package" : "local",
      file: item.file,
    };
    delete broken[name];
  }

  return {
    dir,
    ...(scan.dirError ? { dirError: scan.dirError } : {}),
    definitions,
    presets,
    sources,
    broken,
  };
}

type InstalledSource = { kind: "package"; source: string; at?: string };

/** `wemind agent add` 写下的安装来源；手写定义不在其中，按「本机」展示。 */
function readInstalledSources(): Record<string, InstalledSource> {
  try {
    const raw = JSON.parse(fs.readFileSync(agentSourcesFile(), "utf-8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, InstalledSource> = {};
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const v = value as Record<string, unknown>;
      if (v.kind !== "package" || typeof v.source !== "string") continue;
      out[name.toLowerCase()] = {
        kind: "package",
        source: v.source,
        ...(typeof v.at === "string" ? { at: v.at } : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

let cached: { fingerprint: string; registry: AgentRegistry } | null = null;

/**
 * 合并后的注册表：内置 < 本机（同名整条替换）。
 * 按目录指纹缓存；新增/修改/删除定义后下一次调用自动重读，无需重启 daemon（也没有文件监听线程）。
 * `refresh: true` 强制重读（`agent add/remove` 这类刚改完目录的命令用）。
 */
export function getAgentRegistry(opts: { refresh?: boolean } = {}): AgentRegistry {
  const dir = agentsDir();
  const scan = scanLocalFiles(dir);
  if (!opts.refresh && cached && cached.fingerprint === scan.fingerprint) return cached.registry;
  const registry = buildRegistry(dir, scan);
  cached = { fingerprint: scan.fingerprint, registry };
  return registry;
}

/** 仅供单测：清掉缓存，让下一次访问按当前 WEMIND_AGENTS_DIR 重读。 */
export function resetAgentRegistryCache(): void {
  cached = null;
}

function ownValue<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** 合并后的定义（有效定义；坏定义不在其中，见 `findBrokenAgentDefinition`）。 */
export function findAgentDefinition(name: string): AgentDefinition | undefined {
  return ownValue(getAgentRegistry().definitions, name.trim().toLowerCase());
}

export function findAgentDefinitionSource(name: string): AgentDefinitionSource | undefined {
  return ownValue(getAgentRegistry().sources, name.trim().toLowerCase());
}

export function findBrokenAgentDefinition(name: string): BrokenAgentDefinition | undefined {
  return ownValue(getAgentRegistry().broken, name.trim().toLowerCase());
}

/** 可作为 agent 名的 token：有效定义，或坏定义（解析层要接住它并回一条可读的失败原因）。 */
export function isAgentToken(name: string): boolean {
  const key = name.trim().toLowerCase();
  if (!key) return false;
  const registry = getAgentRegistry();
  return Object.hasOwn(registry.presets, key) || Object.hasOwn(registry.broken, key);
}

/** 坏定义的统一文案（CLI / daemon / 微信回执共用）。 */
export function brokenAgentDefinitionMessage(b: BrokenAgentDefinition): string {
  const problems = formatAgentDefinitionProblems(b.problems)
    .map((p) => `  - ${p}`)
    .join("\n");
  return (
    `agent 定义「${b.name}」不可用（${b.file}）：\n${problems}\n` +
    `修复：改好或删掉该文件（删掉后同名内置定义恢复），再运行 \`wemind agent check ${b.name}\` 复查。`
  );
}

/**
 * 合并后的预设视图。用 Proxy 而不是启动时拷贝：新定义落盘后，持续运行的 daemon 在下一次
 * 解析/指令匹配时也能看到（按目录指纹重读），满足「本地加配置即可用、不必重启换版」。
 */
export const ACP_AGENT_PRESETS: Record<string, AcpAgentPreset> = new Proxy(
  {},
  {
    get(_target, prop) {
      return typeof prop === "string" ? ownValue(getAgentRegistry().presets, prop) : undefined;
    },
    has(_target, prop) {
      return typeof prop === "string" && Object.hasOwn(getAgentRegistry().presets, prop);
    },
    ownKeys() {
      return Reflect.ownKeys(getAgentRegistry().presets);
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop !== "string") return undefined;
      const registry = getAgentRegistry();
      if (!Object.hasOwn(registry.presets, prop)) return undefined;
      return {
        configurable: true,
        enumerable: true,
        value: registry.presets[prop],
        writable: false,
      };
    },
  },
);

/** 全部内置 agent 名（`auto` 不在其中：它只是「自动探测」的开关）。 */
export function builtinDefinitionNames(): string[] {
  return Object.keys(BUILTIN_AGENT_DEFINITIONS);
}

/**
 * `auto` 的探测顺序：由内置 adapter 的 `hints.autoProbe` 决定（数字小的优先）。
 * 只取内置定义——用户定义可以显式选择，但不参与自动挑脑（避免装一个未登录的 agent 后静默换脑）。
 */
export const AUTO_PROBE_ORDER: readonly string[] = Object.entries(builtinRegistry.presets)
  .filter(([, preset]) => preset.hooks?.hints?.autoProbe !== undefined)
  .sort((a, b) => (a[1].hooks!.hints!.autoProbe ?? 0) - (b[1].hooks!.hints!.autoProbe ?? 0))
  .map(([name]) => name);
