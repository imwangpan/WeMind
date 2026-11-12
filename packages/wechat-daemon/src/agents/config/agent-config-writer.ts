import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import type { ResolvedAgent } from "../brain-agents.js";
import { ACP_AGENT_PRESETS } from "../brain-presets.js";
import { writeJsonAtomic } from "../../shared/io/atomic-json.js";
import { readJsonConfig } from "./overlay.js";

/**
 * 真实 Agent 配置的受控写入层。
 *
 * 只支持能无损读成对象的 JSON / JSONC；YAML、TOML 等格式没有内置编辑器时明确拒绝，
 * 不把 JSON 硬写进 `.yml`（那会把用户配置写坏）。写入前备份，写入用原子 rename。
 */
export type ConfigFileFormat = "json" | "jsonc" | "unsupported";

/** 写入前的文件快照：用于乐观并发校验，避免覆盖终端侧刚改过的真实配置。 */
export type ConfigFileSnapshot = {
  exists: boolean;
  mtimeMs: number;
  size: number;
  hash: string;
};

export function snapshotConfigFile(file: string): ConfigFileSnapshot {
  try {
    const st = fs.statSync(file);
    const buf = fs.readFileSync(file);
    return {
      exists: true,
      mtimeMs: st.mtimeMs,
      size: st.size,
      hash: crypto.createHash("sha256").update(buf).digest("hex"),
    };
  } catch {
    return { exists: false, mtimeMs: 0, size: 0, hash: "" };
  }
}

function sameSnapshot(a: ConfigFileSnapshot, b: ConfigFileSnapshot): boolean {
  return (
    a.exists === b.exists &&
    a.size === b.size &&
    a.hash === b.hash &&
    Math.abs(a.mtimeMs - b.mtimeMs) < 1
  );
}

/** 发现终端侧在“读—改—写”之间改过文件时拒绝覆盖；调用方应重新读取后重试。 */
export function assertConfigUnchanged(file: string, expected: ConfigFileSnapshot): void {
  const now = snapshotConfigFile(file);
  if (!sameSnapshot(now, expected)) {
    throw new Error(
      `配置在读取后被其它程序修改，已拒绝覆盖：${file}。请重新读取后再改（终端侧可能刚保存过）。`,
    );
  }
}

/** 检测 JSONC 里是否真有注释；字符串里的 // 不算。 */
function hasJsonComments(raw: string): boolean {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length - 1; i++) {
    const c = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "/" && (raw[i + 1] === "/" || raw[i + 1] === "*")) return true;
  }
  return false;
}

export function configFileFormat(file: string): ConfigFileFormat {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".json") return "json";
  if (ext === ".jsonc") return "jsonc";
  return "unsupported";
}

export function resolveAgentConfigFile(ag: ResolvedAgent, file?: string): string {
  if (!ag.realHome) throw new Error(`agent「${ag.name}」没有真实配置目录，无法修改配置`);
  const rel = file?.trim() || ag.settingsBase || ag.mcpConfigFile;
  if (!rel) throw new Error(`agent「${ag.name}」没有默认配置文件，请用 --file 指定`);
  const abs = path.resolve(ag.realHome, rel);
  if (!isInside(abs, path.resolve(ag.realHome))) {
    throw new Error(`配置文件必须位于 agent 真实配置目录内：${rel}`);
  }
  return abs;
}

/** 编辑配置不需要 agent 二进制可用；按预设名解析真实目录即可。 */
export function resolveAgentConfigFileByName(agent: string, file?: string): string {
  const key = agent.trim().toLowerCase();
  const preset = ACP_AGENT_PRESETS[key];
  if (!preset) throw new Error(`未知 agent「${agent}」`);
  const realHome =
    process.env.WEMIND_BRAIN_REAL_HOME?.trim() ||
    process.env.WECHAT_REAL_KIRO_HOME?.trim() ||
    preset.realHome;
  if (!realHome) throw new Error(`agent「${key}」没有真实配置目录`);
  const rel = file?.trim() || preset.settingsBase || preset.mcpConfigFile || "settings.json";
  const abs = path.resolve(realHome, rel);
  if (!isInside(abs, path.resolve(realHome)))
    throw new Error(`配置文件必须位于 agent 真实配置目录内：${rel}`);
  return abs;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 支持 `a.b`、`a[0].b`；空路径表示整个文件。 */
export function parseConfigPath(expr: string): Array<string | number> {
  const text = expr.trim();
  if (!text) return [];
  const out: Array<string | number> = [];
  for (const part of text.split(".")) {
    const m = part.match(/^([^[\]]*)((?:\[\d+\])*)$/);
    if (!m) throw new Error(`无法解析配置路径：${expr}`);
    if (m[1]) out.push(m[1]);
    for (const idx of m[2].matchAll(/\[(\d+)\]/g)) out.push(Number(idx[1]));
  }
  return out;
}

export function getConfigPath(value: unknown, expr: string): unknown {
  let cur: unknown = value;
  for (const key of parseConfigPath(expr)) {
    if (typeof key === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[key];
    } else {
      if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
      cur = (cur as Record<string, unknown>)[key];
    }
  }
  return cur;
}

export function setConfigPath(
  value: Record<string, unknown>,
  expr: string,
  next: unknown,
): Record<string, unknown> {
  const keys = parseConfigPath(expr);
  if (!keys.length) {
    if (!next || typeof next !== "object" || Array.isArray(next))
      throw new Error("整文件替换必须是对象");
    return next as Record<string, unknown>;
  }
  const root: Record<string, unknown> = { ...value };
  let cur: Record<string, unknown> | unknown[] = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    const nextKey = keys[i + 1];
    if (typeof key === "number") {
      if (!Array.isArray(cur)) throw new Error(`路径 ${expr} 的父级不是数组`);
      if (cur[key] === undefined || cur[key] === null)
        cur[key] = typeof nextKey === "number" ? [] : {};
      cur = cur[key] as Record<string, unknown> | unknown[];
    } else {
      if (!cur || typeof cur !== "object" || Array.isArray(cur))
        throw new Error(`路径 ${expr} 的父级不是对象`);
      const obj = cur as Record<string, unknown>;
      if (obj[key] === undefined || obj[key] === null)
        obj[key] = typeof nextKey === "number" ? [] : {};
      cur = obj[key] as Record<string, unknown> | unknown[];
    }
  }
  const last = keys[keys.length - 1];
  if (typeof last === "number") {
    if (!Array.isArray(cur)) throw new Error(`路径 ${expr} 的父级不是数组`);
    cur[last] = next;
  } else {
    if (!cur || typeof cur !== "object" || Array.isArray(cur))
      throw new Error(`路径 ${expr} 的父级不是对象`);
    (cur as Record<string, unknown>)[last] = next;
  }
  return root;
}

export function deleteConfigPath(
  value: Record<string, unknown>,
  expr: string,
): Record<string, unknown> {
  const keys = parseConfigPath(expr);
  if (!keys.length) return {};
  const root: Record<string, unknown> = { ...value };
  let cur: Record<string, unknown> | unknown[] = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (typeof key === "number") {
      if (!Array.isArray(cur) || !cur[key]) return root;
      cur = cur[key] as Record<string, unknown> | unknown[];
    } else {
      if (!cur || typeof cur !== "object" || Array.isArray(cur)) return root;
      const v = (cur as Record<string, unknown>)[key];
      if (!v || typeof v !== "object") return root;
      cur = v as Record<string, unknown> | unknown[];
    }
  }
  const last = keys[keys.length - 1];
  if (typeof last === "number") {
    if (Array.isArray(cur)) cur.splice(last, 1);
  } else if (cur && typeof cur === "object" && !Array.isArray(cur)) {
    delete (cur as Record<string, unknown>)[last];
  }
  return root;
}

/** CLI 值：能 JSON 解析就按 JSON，否则当字符串；用户写 `"x"` 也按字符串。 */
export function parseCliValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function readConfigObject(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  if (configFileFormat(file) === "unsupported")
    throw new Error(`暂不支持编辑 ${path.basename(file)}（当前只支持 .json / .jsonc）`);
  const parsed = readJsonConfig(file);
  if (!parsed) throw new Error(`配置不是有效 JSON/JSONC：${file}`);
  return parsed;
}

/** 最近备份最多保留 5 份，避免每次 set 都在用户配置目录堆文件。 */
function backupFile(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${file}.wemind-bak-${stamp}`;
  try {
    fs.copyFileSync(file, backup);
    const dir = path.dirname(file);
    const base = path.basename(file);
    const olds = fs
      .readdirSync(dir)
      .filter((n) => n.startsWith(`${base}.wemind-bak-`))
      .sort();
    for (const old of olds.slice(0, Math.max(0, olds.length - 5)))
      fs.rmSync(path.join(dir, old), { force: true });
    return backup;
  } catch {
    return null;
  }
}

export function writeConfigObject(
  file: string,
  value: Record<string, unknown>,
  opts: { backup?: boolean; expected?: ConfigFileSnapshot } = {},
): string | null {
  if (configFileFormat(file) === "unsupported")
    throw new Error(`暂不支持编辑 ${path.basename(file)}（当前只支持 .json / .jsonc）`);
  if (opts.expected) assertConfigUnchanged(file, opts.expected);
  if (configFileFormat(file) === "jsonc" && fs.existsSync(file)) {
    const raw = fs.readFileSync(file, "utf-8");
    if (hasJsonComments(raw)) {
      throw new Error(
        `配置含注释（JSONC），写入层会丢失注释，已拒绝：${file}。请用 \`config agent edit\` 或编辑器修改；若坚持命令行写入，请先移除注释。`,
      );
    }
  }
  const backup = opts.backup === false ? null : backupFile(file);
  writeJsonAtomic(file, value);
  return backup;
}

export function mutateConfigFile(
  file: string,
  expr: string,
  value: unknown | undefined,
  opts: { backup?: boolean; expected?: ConfigFileSnapshot } = {},
): { file: string; backup: string | null; before: unknown; snapshotBefore: ConfigFileSnapshot } {
  const snapshotBefore = snapshotConfigFile(file);
  if (opts.expected) assertConfigUnchanged(file, opts.expected);
  const before = readConfigObject(file);
  const next =
    value === undefined ? deleteConfigPath(before, expr) : setConfigPath(before, expr, value);
  // 即使调用方没有显式传 expected，也要用「读之前」的快照再校验一次：
  // readConfigObject 与 writeConfigObject 之间，终端侧可能刚保存过文件。
  const backup = writeConfigObject(file, next, {
    ...opts,
    expected: opts.expected ?? snapshotBefore,
  });
  return { file, backup, before: getConfigPath(before, expr), snapshotBefore };
}

/** overlay 的 config 段是 `{ 文件相对路径: patch }`；这里只做“路径级 patch”的更新。 */
export function applyOverlayPathPatch(
  base: Record<string, unknown>,
  expr: string,
  value: unknown | undefined,
): Record<string, unknown> {
  if (!expr.trim()) {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("overlay 整文件 patch 必须是对象");
    return value as Record<string, unknown>;
  }
  return value === undefined ? deleteConfigPath(base, expr) : setConfigPath(base, expr, value);
}

/** overlay patch 的合并：对象递归合并，数组整段替换，`null` 保留（表示“删除真实键”）。 */
export function mergeOverlayPatch(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      out[k] &&
      typeof out[k] === "object" &&
      !Array.isArray(out[k])
    )
      out[k] = mergeOverlayPatch(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    else out[k] = v;
  }
  return out;
}

/** 把 `null` 写进 overlay patch 表示删除键；CLI unset 用这个语义。 */
export function patchWithDelete(expr: string): Record<string, unknown> {
  const keys = parseConfigPath(expr);
  if (!keys.length) return {};
  const out: Record<string, unknown> = {};
  let cur = out;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (typeof key === "number") throw new Error("overlay patch 的父级暂不支持数组下标");
    const child: Record<string, unknown> = {};
    cur[key] = child;
    cur = child;
  }
  const last = keys[keys.length - 1];
  if (typeof last === "number") throw new Error("overlay patch 的末级暂不支持数组下标");
  cur[last] = null;
  return out;
}
