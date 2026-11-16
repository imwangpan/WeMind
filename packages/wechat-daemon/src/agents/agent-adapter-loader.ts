/**
 * adapter 模块加载器。
 *
 * 同步路径（daemon / 解析器）用 `createRequire`：CJS 插件立即可用；ESM 插件在进程启动时由
 * `preloadAgentAdapters()` 异步 import 进缓存。这样 `getAgentRegistry()` / `resolveAgent()` 仍是同步 API，
 * 不会把半加载的 Promise 当成可用 adapter。
 *
 * 失败一律结构化返回（不抛）：注册表把它变成坏定义，CLI / 日志给出「哪个模块、哪个文件、为什么」。
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { agentsDir } from "./agent-paths.js";
import {
  AGENT_ADAPTER_API_VERSION,
  validateAgentDefinition,
  type AgentDefinition,
} from "./agent-definition.js";
import {
  AGENT_ADAPTER_HOOKS,
  type AgentAdapter,
  type AgentAdapterHookName,
} from "./agent-adapter.js";
import { BUILTIN_AGENT_ADAPTERS, isBuiltinAdapterModule } from "./adapters/builtin.js";

export type AdapterLoadResult =
  | { ok: true; adapter: AgentAdapter; source: string }
  | { ok: false; error: string };

type CacheEntry = AdapterLoadResult & {
  /** 外部模块解析到的实际文件；内置为空。 */
  resolvedFile?: string;
  mtimeMs?: number;
};

const cache = new Map<string, CacheEntry>();
const BUILTIN_PREFIX = "builtin:";

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function adapterError(def: AgentDefinition, module: string, reason: string): AdapterLoadResult {
  return {
    ok: false,
    error:
      `agent「${def.name}」的 adapter「${module}」不可用：${reason}\n` +
      `修复：确认模块已安装且文件存在；ESM 插件会被 CLI/daemon 启动时预加载，若仍失败请运行 \`wemind agent check ${def.name}\` 查看详情。`,
  };
}

function isRelativeSpec(spec: string): boolean {
  return (
    spec === "." ||
    spec === ".." ||
    spec.startsWith("./") ||
    spec.startsWith("../") ||
    spec.startsWith(".\\") ||
    spec.startsWith("..\\")
  );
}

function fileSpec(spec: string): string | null {
  if (spec.startsWith("file://")) return fileURLToPath(spec);
  if (path.isAbsolute(spec)) return path.normalize(spec);
  return null;
}

function candidateOf(mod: unknown): Record<string, unknown> | null {
  if (!mod || typeof mod !== "object") return null;
  const ns = mod as Record<string, unknown>;
  const candidate = ns.default ?? ns;
  return candidate && typeof candidate === "object" ? (candidate as Record<string, unknown>) : null;
}

function validateFunction(
  owner: Record<string, unknown>,
  key: string,
  pathName: string,
  problems: string[],
): void {
  if (owner[key] !== undefined && typeof owner[key] !== "function")
    problems.push(`${pathName}.${key} 应为函数`);
}

function validateStringArray(
  owner: Record<string, unknown>,
  key: string,
  pathName: string,
  problems: string[],
): void {
  const value = owner[key];
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((x) => typeof x !== "string" || x === ""))
    problems.push(`${pathName}.${key} 应为非空字符串数组`);
}

function validateObject(
  owner: Record<string, unknown>,
  key: string,
  pathName: string,
  problems: string[],
): Record<string, unknown> | null {
  const value = owner[key];
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    problems.push(`${pathName}.${key} 应为对象`);
    return null;
  }
  return value as Record<string, unknown>;
}

function validateObjectKeys(
  owner: Record<string, unknown>,
  allowed: readonly string[],
  pathName: string,
  problems: string[],
): void {
  for (const key of Object.keys(owner))
    if (!allowed.includes(key))
      problems.push(`${pathName}.${key} 是未知字段（可用：${allowed.join(" / ")}）`);
}

function requireFunction(
  owner: Record<string, unknown>,
  key: string,
  pathName: string,
  problems: string[],
): void {
  if (typeof owner[key] !== "function") problems.push(`${pathName}.${key} 应为函数`);
}

/** 外部模块的形状校验：未知顶层键 fail-closed（拼错 hook 名不能静默忽略）。 */
function validateAdapterModule(mod: unknown): { adapter?: AgentAdapter; problems: string[] } {
  const candidate = candidateOf(mod);
  if (!candidate) return { problems: ["模块应导出一个对象（CJS module.exports / ESM default）"] };
  const problems: string[] = [];
  const allowed = new Set<string>(AGENT_ADAPTER_HOOKS);
  for (const key of Object.keys(candidate))
    if (!allowed.has(key))
      problems.push(`未知顶层键「${key}」（可用：${AGENT_ADAPTER_HOOKS.join(" / ")}）`);
  if (candidate.apiVersion !== AGENT_ADAPTER_API_VERSION)
    problems.push(
      `apiVersion 应为 ${AGENT_ADAPTER_API_VERSION}（模块声明的是 ${String(candidate.apiVersion)}，需要更新/降级插件或 WeMind）`,
    );

  const known = candidate as Record<string, unknown>;
  const mcp = validateObject(known, "mcp", "adapter", problems);
  if (mcp) {
    validateObjectKeys(
      mcp,
      [
        "id",
        "nativeOwned",
        "readCatalog",
        "writeCatalog",
        "stripSettings",
        "toAcp",
        "nativeCatalog",
      ],
      "adapter.mcp",
      problems,
    );
    if (typeof mcp.id !== "string" || mcp.id === "") problems.push("adapter.mcp.id 应为非空字符串");
    if (typeof mcp.nativeOwned !== "boolean") problems.push("adapter.mcp.nativeOwned 应为布尔值");
    for (const fn of ["readCatalog", "writeCatalog", "stripSettings", "toAcp", "nativeCatalog"])
      requireFunction(mcp, fn, "adapter.mcp", problems);
  }

  const settings = validateObject(known, "settings", "adapter", problems);
  if (settings) {
    validateObjectKeys(settings, ["inherit"], "adapter.settings", problems);
    validateFunction(settings, "inherit", "adapter.settings", problems);
  }

  const profile = validateObject(known, "profile", "adapter", problems);
  if (profile) {
    validateObjectKeys(
      profile,
      ["readDefaultModel", "copyForManaged", "managedFiles", "stripManagedWechat", "hints"],
      "adapter.profile",
      problems,
    );
    for (const fn of [
      "readDefaultModel",
      "copyForManaged",
      "managedFiles",
      "stripManagedWechat",
      "hints",
    ])
      validateFunction(profile, fn, "adapter.profile", problems);
  }

  const env = validateObject(known, "env", "adapter", problems);
  if (env) {
    validateObjectKeys(env, ["derive", "binOverride", "binOverrideNames"], "adapter.env", problems);
    validateFunction(env, "derive", "adapter.env", problems);
    validateFunction(env, "binOverride", "adapter.env", problems);
    validateStringArray(env, "binOverrideNames", "adapter.env", problems);
  }

  const engine = validateObject(known, "engine", "adapter", problems);
  if (engine) {
    validateObjectKeys(engine, ["prepareArgs"], "adapter.engine", problems);
    validateFunction(engine, "prepareArgs", "adapter.engine", problems);
  }

  const spawn = validateObject(known, "spawn", "adapter", problems);
  if (spawn) {
    validateObjectKeys(
      spawn,
      ["prepareArgs", "prepare", "prepareManaged"],
      "adapter.spawn",
      problems,
    );
    for (const fn of ["prepareArgs", "prepare", "prepareManaged"])
      validateFunction(spawn, fn, "adapter.spawn", problems);
  }

  const fingerprint = validateObject(known, "fingerprint", "adapter", problems);
  if (fingerprint) {
    validateObjectKeys(fingerprint, ["volatile", "extraFiles"], "adapter.fingerprint", problems);
    validateStringArray(fingerprint, "volatile", "adapter.fingerprint", problems);
    validateFunction(fingerprint, "extraFiles", "adapter.fingerprint", problems);
  }

  const paths = validateObject(known, "paths", "adapter", problems);
  if (paths) {
    validateObjectKeys(paths, ["sensitive"], "adapter.paths", problems);
    validateFunction(paths, "sensitive", "adapter.paths", problems);
  }

  const hints = validateObject(known, "hints", "adapter", problems);
  if (hints) {
    validateObjectKeys(hints, ["install", "auth", "autoProbe"], "adapter.hints", problems);
    validateFunction(hints, "install", "adapter.hints", problems);
    validateFunction(hints, "auth", "adapter.hints", problems);
    if (
      hints.autoProbe !== undefined &&
      (typeof hints.autoProbe !== "number" || !Number.isFinite(hints.autoProbe))
    )
      problems.push("adapter.hints.autoProbe 应为有限数字");
  }

  if (problems.length) return { problems };
  return { adapter: candidate as unknown as AgentAdapter, problems: [] };
}

function resolvePackageWithRequire(
  baseDir: string,
  spec: string,
): { require: NodeJS.Require; resolved: string | null } {
  const req = createRequire(path.join(baseDir, "__wemind_adapter__.cjs"));
  try {
    return { require: req, resolved: req.resolve(spec) };
  } catch {
    return { require: req, resolved: null };
  }
}

function moduleCacheKey(module: string, baseDir: string): string {
  return `${module}\0${baseDir}`;
}

/**
 * 同步加载：内置 adapter 直接返回；外部模块用 require。
 * ESM-only 模块会返回可读错误，提示先由 CLI 预加载（正常入口已经这样做）。
 */
export function loadAgentAdapterSync(
  def: AgentDefinition,
  definitionFile?: string,
): AdapterLoadResult {
  const adapterRef = def.adapter;
  if (!adapterRef) return { ok: false, error: `agent「${def.name}」没有声明 adapter` };
  const module = adapterRef.module;
  if (isBuiltinAdapterModule(module)) {
    return {
      ok: true,
      adapter: BUILTIN_AGENT_ADAPTERS[module],
      source: module,
    };
  }
  if (module.startsWith(BUILTIN_PREFIX))
    return adapterError(def, module, "未注册的内置 adapter 模块（检查拼写或升级 WeMind）");

  const baseDir = definitionFile ? path.dirname(definitionFile) : process.cwd();
  const key = moduleCacheKey(module, baseDir);
  const cached = cache.get(key);
  if (cached?.ok) {
    if (!cached.resolvedFile) return cached;
    try {
      const mtimeMs = fs.statSync(cached.resolvedFile).mtimeMs;
      if (cached.mtimeMs === mtimeMs) return cached;
    } catch {
      /* 文件被删：走下面重新解析，得到可读错误 */
    }
  }

  const { require: req, resolved } = resolvePackageWithRequire(baseDir, module);
  if (!resolved && !isRelativeSpec(module) && !fileSpec(module))
    return adapterError(
      def,
      module,
      "模块无法解析（按包名安装到能从这里找到的位置，或用绝对/相对路径）",
    );
  const target =
    fileSpec(module) ?? (isRelativeSpec(module) ? path.resolve(baseDir, module) : resolved);
  if (!target)
    return adapterError(
      def,
      module,
      "模块无法解析（ESM-only 包请通过 CLI/daemon 的正常入口启动以完成预加载）",
    );
  if (!fs.existsSync(target)) return adapterError(def, module, `文件不存在：${target}`);

  try {
    if (req.cache?.[target]) delete req.cache[target];
    const loaded = req(target);
    const checked = validateAdapterModule(loaded);
    if (!checked.adapter) return adapterError(def, module, checked.problems.join("；"));
    const result: CacheEntry = {
      ok: true,
      adapter: checked.adapter,
      source: target,
      resolvedFile: target,
      mtimeMs: fs.statSync(target).mtimeMs,
    };
    cache.set(key, result);
    return result;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ERR_REQUIRE_ESM")
      return adapterError(
        def,
        module,
        "这是 ESM 模块，不能同步 require；CLI 与 daemon 启动时会自动预加载，若在解析阶段看到这条说明进程没有走到预加载",
      );
    return adapterError(def, module, `加载失败：${errorText(e)}`);
  }
}

/** 异步加载一个模块（ESM 也支持），成功后写入同一个同步缓存。 */
export async function preloadAgentAdapter(
  def: AgentDefinition,
  definitionFile: string,
  opts: { refresh?: boolean } = {},
): Promise<AdapterLoadResult> {
  const adapterRef = def.adapter;
  if (!adapterRef) return { ok: false, error: `agent「${def.name}」没有声明 adapter` };
  const module = adapterRef.module;
  if (isBuiltinAdapterModule(module))
    return { ok: true, adapter: BUILTIN_AGENT_ADAPTERS[module], source: module };
  if (module.startsWith(BUILTIN_PREFIX))
    return adapterError(def, module, "未注册的内置 adapter 模块（检查拼写或升级 WeMind）");

  const baseDir = path.dirname(definitionFile);
  const key = moduleCacheKey(module, baseDir);
  if (!opts.refresh) {
    const cached = cache.get(key);
    if (cached?.ok) return cached;
  }

  const { resolved } = resolvePackageWithRequire(baseDir, module);
  const target =
    fileSpec(module) ?? (isRelativeSpec(module) ? path.resolve(baseDir, module) : resolved);
  if (!target) return adapterError(def, module, "模块无法解析（确认已安装，或改用绝对/相对路径）");
  if (!fs.existsSync(target)) return adapterError(def, module, `文件不存在：${target}`);

  try {
    const url = pathToFileURL(target);
    // 刷新时带 mtime：ESM 模块缓存按 URL，不带参数会拿到旧代码。
    url.searchParams.set("wemind_mtime", String(fs.statSync(target).mtimeMs));
    const loaded = await import(url.href);
    const checked = validateAdapterModule(loaded);
    if (!checked.adapter) return adapterError(def, module, checked.problems.join("；"));
    const result: CacheEntry = {
      ok: true,
      adapter: checked.adapter,
      source: target,
      resolvedFile: target,
      mtimeMs: fs.statSync(target).mtimeMs,
    };
    cache.set(key, result);
    return result;
  } catch (e) {
    return adapterError(def, module, `加载失败：${errorText(e)}`);
  }
}

/** 只读地扫一遍定义目录，把外部 adapter 预加载进缓存。 */
export async function preloadAgentAdapters(
  opts: { dir?: string; refresh?: boolean } = {},
): Promise<{ loaded: string[]; problems: string[] }> {
  if (opts.refresh) cache.clear();
  const dir = opts.dir ?? agentsDir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { loaded: [], problems: [] };
  }
  const loaded: string[] = [];
  const problems: string[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (
      !entry.isFile() ||
      entry.name.startsWith(".") ||
      !entry.name.toLowerCase().endsWith(".json")
    )
      continue;
    const file = path.join(dir, entry.name);
    let def: AgentDefinition;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf-8").replace(/^\uFEFF/, ""));
      const result = validateAgentDefinition(raw);
      if (!result.ok) continue; // schema 问题由注册表按坏定义报，不在这里重复
      def = result.value;
    } catch {
      continue;
    }
    if (!def.adapter || isBuiltinAdapterModule(def.adapter.module)) continue;
    const result = await preloadAgentAdapter(def, file, opts);
    if (result.ok) loaded.push(def.name);
    else problems.push(result.error);
  }
  return { loaded, problems };
}

/** `agent check <文件>`：文件还没安装，按它所在目录解析相对 adapter。 */
export async function preloadAgentAdapterForDefinition(
  def: AgentDefinition,
  definitionFile: string,
): Promise<AdapterLoadResult> {
  return preloadAgentAdapter(def, definitionFile, { refresh: true });
}

export function resetAgentAdapterCache(): void {
  cache.clear();
}

/** 内置 adapter 模块名（供 `agent spec` / 文档展示）。 */
export function builtinAdapterModuleNames(): string[] {
  return Object.keys(BUILTIN_AGENT_ADAPTERS);
}

/** 契约版本（避免调用方各自 import 两个常量）。 */
export const ADAPTER_API_VERSION = AGENT_ADAPTER_API_VERSION;

export type { AgentAdapterHookName };
