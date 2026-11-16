/**
 * 定义包安装与移除（`wemind agent add/remove`）。
 *
 * 口径：**复制即安装**。运行期绝不联网拉取；`add` 只读本地目录/文件，把定义与相对路径的 adapter
 * 复制到 `~/.wemind/.agents/`，并把 `adapter.module` 改写成相对定义文件的路径。
 *
 * 包结构（单定义或多定义都支持）：
 * - `wemind-agent.json`：一份定义（推荐）；
 * - `package.json` 的 `wemind` 字段：`{ "definition": "wemind-agent.json" }`
 *   或 `{ "definitions": "agents" }`（目录下所有 `*.json`）；
 * - 目录里没有上述声明时，回退到根 `wemind-agent.json` 或 `agents/*.json`。
 *
 * adapter 复制到 `<定义目录>/adapters/<name>/`；定义里的 `./adapter.cjs` 改写成
 * `./adapters/<name>/adapter.cjs`。绝对路径与包名原样保留（调用方知道自己依赖什么）。
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeFileAtomic, writeJsonAtomic } from "../shared/io/atomic-json.js";
import {
  isSafeAgentName,
  validateAgentDefinition,
  type AgentDefinition,
} from "./agent-definition.js";
import { preloadAgentAdapter, resetAgentAdapterCache } from "./agent-adapter-loader.js";
import { agentSourcesFile, agentsDir } from "./agent-paths.js";
import { builtinDefinitionNames, resetAgentRegistryCache } from "./agent-registry.js";

export type AgentInstallResult = {
  ok: boolean;
  text: string;
  installed: string[];
};

type PackageSpec = {
  baseDir: string;
  label: string;
  definitions: AgentDefinition[];
};

type SourceEntry = { kind: "package"; source: string; at: string };

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf-8").replace(/^\uFEFF/, ""));
}

function findPackageDirWith(req: NodeJS.Require, source: string): string | null {
  try {
    const pkgJson = req.resolve(`${source}/package.json`);
    return path.dirname(pkgJson);
  } catch {
    /* 包的 exports 可能不暴露 package.json；下面从入口向上找 */
  }
  try {
    let dir = path.dirname(req.resolve(source));
    for (;;) {
      if (fs.existsSync(path.join(dir, "package.json"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch {
    return null;
  }
}

function resolvePackageDir(source: string): string | null {
  // 先按调用者 cwd 解析（本地项目里的包）；再按 CLI 自己所在模块解析（全局安装）。
  const roots = [path.join(process.cwd(), "__wemind_install__.cjs")];
  try {
    roots.push(fileURLToPath(new URL("./__wemind_install__.cjs", import.meta.url)));
  } catch {
    /* ignore */
  }
  for (const root of roots) {
    try {
      const found = findPackageDirWith(createRequire(root), source);
      if (found) return found;
    } catch {
      /* 继续下一个解析根 */
    }
  }
  return null;
}

function readPackageSpec(source: string): PackageSpec {
  const resolved = path.resolve(source);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    if (path.basename(resolved).toLowerCase() === "package.json")
      return readPackageDir(path.dirname(resolved), path.dirname(resolved));
    if (!resolved.toLowerCase().endsWith(".json"))
      throw new Error(`agent add 只接受 .json 定义或包目录：${resolved}`);
    const def = parseDefinitionFile(resolved);
    return { baseDir: path.dirname(resolved), label: resolved, definitions: [def] };
  }

  const dir =
    fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
      ? resolved
      : resolvePackageDir(source);
  if (!dir)
    throw new Error(
      `找不到包「${source}」。先安装它（npm i -g / 本地 npm i），或直接传包目录/定义 .json 的路径。`,
    );
  return readPackageDir(dir, dir);
}

function readPackageDir(dir: string, label: string): PackageSpec {
  const packageJsonFile = path.join(dir, "package.json");
  let wemind: Record<string, unknown> | null = null;
  if (fs.existsSync(packageJsonFile)) {
    const pkg = readJson(packageJsonFile);
    if (pkg && typeof pkg === "object" && !Array.isArray(pkg)) {
      const w = (pkg as Record<string, unknown>).wemind;
      if (w && typeof w === "object" && !Array.isArray(w)) wemind = w as Record<string, unknown>;
    }
  }

  const single = path.join(dir, "wemind-agent.json");
  const declared =
    typeof wemind?.definition === "string"
      ? packagePath(dir, wemind.definition, "wemind.definition")
      : "";
  if (declared || fs.existsSync(single)) {
    const file = declared || single;
    if (!fs.existsSync(file))
      throw new Error(`package.json 的 wemind.definition 指向的文件不存在：${file}`);
    return { baseDir: dir, label, definitions: [parseDefinitionFile(file)] };
  }

  const definitionsDir =
    typeof wemind?.definitions === "string"
      ? packagePath(dir, wemind.definitions, "wemind.definitions")
      : path.join(dir, "agents");
  if (fs.existsSync(definitionsDir) && fs.statSync(definitionsDir).isDirectory()) {
    const files = fs
      .readdirSync(definitionsDir)
      .filter((name) => name.toLowerCase().endsWith(".json"))
      .sort();
    if (!files.length) throw new Error(`包里的定义目录没有 *.json：${definitionsDir}`);
    return {
      baseDir: dir,
      label,
      definitions: files.map((name) => parseDefinitionFile(path.join(definitionsDir, name))),
    };
  }

  throw new Error(
    `包「${dir}」没有定义：需要 wemind-agent.json，或 package.json 的 wemind.definition / wemind.definitions，或 agents/*.json`,
  );
}

function packagePath(dir: string, rel: string, label: string): string {
  const target = path.resolve(dir, rel);
  if (!isWithin(dir, target))
    throw new Error(`${label} 必须位于包目录内：${rel}（解析为 ${target}）`);
  return target;
}

function parseDefinitionFile(file: string): AgentDefinition {
  let raw: unknown;
  try {
    raw = readJson(file);
  } catch (e) {
    throw new Error(
      `读不了或不是有效 JSON：${file}（${e instanceof Error ? e.message : String(e)}）`,
    );
  }
  const result = validateAgentDefinition(raw);
  if (!result.ok) {
    const problems = result.problems.map((p) => `  - ${p.path}: ${p.message}`).join("\n");
    throw new Error(`定义不合法：${file}\n${problems}`);
  }
  return result.value;
}

function isWithin(root: string, file: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function isRelativeAdapterSpec(module: string): boolean {
  return (
    module === "." ||
    module === ".." ||
    module.startsWith("./") ||
    module.startsWith("../") ||
    module.startsWith(".\\") ||
    module.startsWith("..\\")
  );
}

type SourcesRead = {
  sources: Record<string, SourceEntry>;
  problem?: string;
};

function readSources(): SourcesRead {
  try {
    const raw = readJson(agentSourcesFile());
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return {
        sources: {},
        problem: `${agentSourcesFile()} 不是对象；为避免覆盖来源记录，本次不写入`,
      };
    return { sources: raw as Record<string, SourceEntry> };
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { sources: {} };
    return {
      sources: {},
      problem: `无法读取 ${agentSourcesFile()}：${e instanceof Error ? e.message : String(e)}；为避免丢来源记录，本次不写入`,
    };
  }
}

function writeSources(sources: Record<string, SourceEntry>): void {
  writeJsonAtomic(agentSourcesFile(), sources);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 来源文件是跨进程 read-modify-write：用短锁把最后一次合并串行化。 */
function withSourcesLock<T>(fn: () => T): T {
  const lock = `${agentSourcesFile()}.lock`;
  const deadline = Date.now() + 5000;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      fd = fs.openSync(lock, "wx", 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST")
        throw new Error(
          `无法锁定 ${agentSourcesFile()}：${e instanceof Error ? e.message : String(e)}`,
        );
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > 30_000) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        /* 锁刚被释放，继续重试 */
      }
      if (Date.now() >= deadline) throw new Error(`等待 ${agentSourcesFile()} 锁超时；请稍后重试`);
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(lock, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** 把定义里相对路径的 adapter 复制进定义目录，并返回改写后的定义。 */
function stageAdapter(
  def: AgentDefinition,
  baseDir: string,
  targetDir: string,
  label: string,
  adapterOverride?: string,
): {
  def: AgentDefinition;
  copies: Array<{ dest: string; data: Buffer; previous: Buffer | null }>;
} {
  const ref = def.adapter;
  if (!ref) return { def, copies: [] };
  const module = ref.module;
  if (!isRelativeAdapterSpec(module)) return { def, copies: [] };

  const source = path.resolve(baseDir, adapterOverride || module);
  if (!isWithin(baseDir, source))
    throw new Error(`adapter 必须位于定义包目录内：${source}（来自 ${label}）`);
  if (!fs.existsSync(source)) throw new Error(`adapter 文件不存在：${source}（来自 ${label}）`);
  if (path.extname(source).toLowerCase() === ".ts")
    throw new Error(`adapter 不能是 TypeScript 源码（${source}）：先编译成 .js/.cjs/.mjs`);
  const ext = path.extname(source).toLowerCase();
  if (![".js", ".cjs", ".mjs"].includes(ext))
    throw new Error(`adapter 只支持 .js/.cjs/.mjs：${source}`);

  const relDir = path.join("adapters", def.name);
  const destDir = path.join(targetDir, relDir);
  const dest = path.join(destDir, path.basename(source));
  return {
    def: {
      ...def,
      adapter: { ...ref, module: `./${relDir.replaceAll("\\", "/")}/${path.basename(source)}` },
    },
    copies: [
      {
        dest,
        data: fs.readFileSync(source),
        previous: fs.existsSync(dest) ? fs.readFileSync(dest) : null,
      },
    ],
  };
}

/**
 * 安装一个定义包。先全部准备好再落盘；adapter 预加载失败会回滚本次写入（不留下半套定义）。
 */
export async function installAgentPackage(source: string): Promise<AgentInstallResult> {
  const spec = readPackageSpec(source);
  const sourcesRead = readSources();
  if (sourcesRead.problem)
    return {
      ok: false,
      text: `❌ 安装失败：${sourcesRead.problem}`,
      installed: [],
    };
  const previousSources = sourcesRead.sources;
  const duplicate = spec.definitions.find(
    (def, i) => spec.definitions.findIndex((other) => other.name === def.name) !== i,
  );
  if (duplicate)
    return {
      ok: false,
      text: `❌ 同一个包里有重复的 agent 名「${duplicate.name}」；每个 name 只能有一份定义。`,
      installed: [],
    };
  const targetDir = agentsDir();
  fs.mkdirSync(targetDir, { recursive: true });

  const packageJsonFile = path.join(spec.baseDir, "package.json");
  let adapterOverride: string | undefined;
  try {
    const pkg = readJson(packageJsonFile) as { wemind?: { adapter?: unknown } };
    if (typeof pkg?.wemind?.adapter === "string") adapterOverride = pkg.wemind.adapter;
  } catch {
    /* 单文件或没有 package.json */
  }

  const staged = spec.definitions.map((def) =>
    stageAdapter(def, spec.baseDir, targetDir, spec.label, adapterOverride),
  );
  const definitions = staged.map((s) => s.def);
  const written: string[] = [];
  const backups = new Map<string, Buffer | null>();
  const adapterBackups = new Map<string, Buffer | null>();
  const backupFiles = new Map<string, string>();
  const installedAdapterDirs = new Map<string, Set<string>>();
  const cleanupWarnings: string[] = [];

  try {
    for (const s of staged)
      for (const copy of s.copies) {
        adapterBackups.set(copy.dest, copy.previous);
        fs.mkdirSync(path.dirname(copy.dest), { recursive: true });
        writeFileAtomic(copy.dest, copy.data);
        written.push(copy.dest);
        const dir = path.dirname(copy.dest);
        const names = installedAdapterDirs.get(dir) ?? new Set<string>();
        names.add(path.basename(copy.dest));
        installedAdapterDirs.set(dir, names);
      }
    for (const def of definitions) {
      const file = path.join(targetDir, `${def.name}.json`);
      const existing = fs.existsSync(file);
      backups.set(file, existing ? fs.readFileSync(file) : null);
      if (existing) {
        const bak = `${file}.bak`;
        fs.copyFileSync(file, bak);
        backupFiles.set(def.name, bak);
      }
      writeJsonAtomic(file, def);
      written.push(file);
    }

    resetAgentRegistryCache();
    resetAgentAdapterCache();
    for (const def of definitions) {
      if (!def.adapter) continue;
      const file = path.join(targetDir, `${def.name}.json`);
      const loaded = await preloadAgentAdapter(def, file, { refresh: true });
      if (!loaded.ok) throw new Error(loaded.error);
    }
    withSourcesLock(() => {
      const latest = readSources();
      if (latest.problem) throw new Error(latest.problem);
      const sources = { ...latest.sources };
      for (const def of definitions)
        sources[def.name] = {
          kind: "package",
          source: spec.label,
          at: new Date().toISOString(),
        };
      writeSources(sources);
    });
    // 重装可能换 adapter 文件名或去掉 adapter；成功落盘后清掉旧文件，避免运行期仍能加载残留 hook。
    for (const def of definitions) {
      const adapterDir = path.join(targetDir, "adapters", def.name);
      if (!isWithin(targetDir, adapterDir)) continue;
      if (!def.adapter) {
        try {
          fs.rmSync(adapterDir, { recursive: true, force: true });
        } catch (e) {
          cleanupWarnings.push(
            `${adapterDir} 未能清理：${e instanceof Error ? e.message : String(e)}`,
          );
        }
        continue;
      }
      const keep = installedAdapterDirs.get(adapterDir) ?? new Set<string>();
      try {
        for (const child of fs.readdirSync(adapterDir, { withFileTypes: true })) {
          if (keep.has(child.name)) continue;
          fs.rmSync(path.join(adapterDir, child.name), { recursive: true, force: true });
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT")
          cleanupWarnings.push(
            `${adapterDir} 的旧文件未能清理：${e instanceof Error ? e.message : String(e)}`,
          );
      }
    }
    resetAgentRegistryCache();

    const lines = [
      `已安装 ${definitions.length} 个定义到 ${targetDir}：`,
      ...definitions.map((def) => {
        const previous = previousSources[def.name];
        const hadLocalFile = backups.get(path.join(targetDir, `${def.name}.json`)) !== null;
        const shadow = builtinDefinitionNames().includes(def.name)
          ? hadLocalFile && !previous
            ? `（覆盖同名内置的本机手写定义；原文件备份为 ${backupFiles.get(def.name)}）`
            : "（覆盖同名内置；remove 后恢复）"
          : previous
            ? "（覆盖已安装数据包定义）"
            : hadLocalFile
              ? `（覆盖本机手写定义；原文件备份为 ${backupFiles.get(def.name)}）`
              : "";
        const code = def.adapter ? `  adapter=${def.adapter.module}（会执行代码）` : "";
        return `  - ${def.name}${shadow}${code}`;
      }),
      ...cleanupWarnings.map((w) => `⚠ ${w}（新定义不引用这些旧文件，但建议手动清理）`),
      "下一步：wemind agent check <name>；要切换大脑说「切到 <name>」（不会自动切换）。",
    ];
    return { ok: true, text: lines.join("\n"), installed: definitions.map((d) => d.name) };
  } catch (e) {
    for (const file of written) {
      try {
        if (backups.get(file) === null) fs.rmSync(file, { force: true });
      } catch {
        /* best-effort */
      }
    }
    for (const [file, buf] of backups) {
      try {
        if (buf !== null) fs.writeFileSync(file, buf);
        else if (fs.existsSync(file)) fs.rmSync(file, { force: true });
      } catch {
        /* best-effort */
      }
    }
    for (const [file, buf] of adapterBackups) {
      try {
        if (buf !== null) fs.writeFileSync(file, buf);
        else if (fs.existsSync(file)) fs.rmSync(file, { force: true });
      } catch {
        /* best-effort */
      }
    }
    for (const def of definitions) {
      try {
        fs.rmdirSync(path.join(targetDir, "adapters", def.name));
      } catch {
        /* 目录非空或不存在：保留 */
      }
    }
    resetAgentAdapterCache();
    resetAgentRegistryCache();
    return {
      ok: false,
      text: `❌ 安装失败，已回滚本次写入：${e instanceof Error ? e.message : String(e)}`,
      installed: [],
    };
  }
}

/** 只移除本机/数据包层；同名内置定义会在下一次解析时恢复。 */
export function removeAgentDefinition(name: string): AgentInstallResult {
  const key = name.trim().toLowerCase();
  if (!key) return { ok: false, text: "❌ 需要 agent 名", installed: [] };
  if (!isSafeAgentName(key))
    return {
      ok: false,
      text: `❌ 非法 agent 名「${name}」：只能使用小写字母/数字/./_/-，且不能以 . 或 - 开头。`,
      installed: [],
    };
  const dir = agentsDir();
  const file = path.join(dir, `${key}.json`);
  if (!isWithin(dir, file))
    return { ok: false, text: `❌ agent 名越出定义目录：${name}`, installed: [] };
  if (!fs.existsSync(file))
    return {
      ok: false,
      text: `❌ ${key} 不是本机/数据包定义，不能 remove（内置定义不在 ${dir}）。`,
      installed: [],
    };
  const preflightSources = readSources();
  if (preflightSources.problem)
    return {
      ok: false,
      text: `❌ 移除失败：${preflightSources.problem}`,
      installed: [],
    };
  try {
    fs.rmSync(file, { force: true });
    const adapterDir = path.join(dir, "adapters", key);
    if (isWithin(dir, adapterDir) && fs.existsSync(adapterDir))
      fs.rmSync(adapterDir, { recursive: true, force: true });
    withSourcesLock(() => {
      const read = readSources();
      if (read.problem) throw new Error(read.problem);
      const sources = read.sources;
      delete sources[key];
      writeSources(sources);
    });
    resetAgentAdapterCache();
    resetAgentRegistryCache();
    const restored = builtinDefinitionNames().includes(key) ? "；同名内置定义已恢复" : "";
    return { ok: true, text: `已移除 ${key}${restored}。`, installed: [] };
  } catch (e) {
    return {
      ok: false,
      text: `❌ 移除失败：${e instanceof Error ? e.message : String(e)}`,
      installed: [],
    };
  }
}
