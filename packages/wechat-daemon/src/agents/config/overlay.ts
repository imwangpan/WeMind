import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "@wemind/wechat-ilink-core";

import { writeJsonAtomic } from "../../shared/io/atomic-json.js";
import { parseJsonc } from "../sandbox/agent-mcp.js";

/**
 * 微信独享覆盖：`<账号>/agent-overrides/<agent>.json`。
 *
 * 只影响微信侧，永不自动写回真实配置。默认修改真实配置；用户明确说“微信侧/仅微信”时才走这里。
 * 不设“安全键”白名单——任何真实配置键都允许覆盖；安全性靠路径校验、解析失败拒绝、写前备份与原子写。
 */
export type OverlayMcp = {
  disable?: string[];
  extra?: Record<string, unknown>;
};

export type AgentOverlay = {
  version: 1;
  config?: Record<string, Record<string, unknown>>;
  mcp?: OverlayMcp;
};

export type OverlayRead = {
  overlay: AgentOverlay;
  problems: string[];
};

export function overlayPath(agent: string, dir: string = DATA_DIR): string {
  return path.join(dir, "agent-overrides", `${agent}.json`);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function looksSecretKey(key: string): boolean {
  const n = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    n.endsWith("apikey") ||
    n === "key" ||
    n.endsWith("token") ||
    n.endsWith("secret") ||
    n.endsWith("password") ||
    n.endsWith("passwd") ||
    n.endsWith("credential") ||
    n.endsWith("credentials") ||
    n === "authorization"
  );
}

/** 递归检查配置 patch 里是否有明显的密钥键名；值本身不扫描（可能误伤普通文本）。 */
export function findSecretKeys(value: unknown, prefix = ""): string[] {
  if (!isObj(value)) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (looksSecretKey(k)) out.push(key);
    out.push(...findSecretKeys(v, key));
  }
  return out;
}

/** 读 overlay；损坏/版本不支持返回空对象并记录问题，调用方决定是否拒绝启动。 */
export function readOverlay(agent: string, dir: string = DATA_DIR): OverlayRead {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(overlayPath(agent, dir), "utf-8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT")
      return { overlay: { version: 1 }, problems: [] };
    return { overlay: { version: 1 }, problems: [`overlay 解析失败：${String(e)}`] };
  }
  if (!isObj(raw)) return { overlay: { version: 1 }, problems: ["overlay 不是对象"] };
  const problems: string[] = [];
  if (raw.version !== undefined && raw.version !== 1)
    problems.push(`overlay version=${String(raw.version)} 不支持（当前只支持 1）`);
  const overlay: AgentOverlay = { version: 1 };
  if (raw.config !== undefined) {
    if (!isObj(raw.config)) problems.push("overlay.config 不是对象");
    else {
      const config: Record<string, Record<string, unknown>> = {};
      for (const [file, patch] of Object.entries(raw.config)) {
        if (!isObj(patch)) {
          problems.push(`overlay.config.${file} 不是对象`);
          continue;
        }
        const secrets = findSecretKeys(patch);
        if (secrets.length) {
          problems.push(`overlay.config.${file} 含疑似密钥键：${secrets.join(", ")}`);
          continue;
        }
        config[file] = patch;
      }
      if (Object.keys(config).length) overlay.config = config;
    }
  }
  if (raw.mcp !== undefined) {
    if (!isObj(raw.mcp)) problems.push("overlay.mcp 不是对象");
    else {
      const mcp: OverlayMcp = {};
      const disable = raw.mcp.disable;
      if (disable !== undefined) {
        if (Array.isArray(disable))
          mcp.disable = disable.filter((x): x is string => typeof x === "string" && !!x.trim());
        else problems.push("overlay.mcp.disable 不是数组");
      }
      if (raw.mcp.extra !== undefined) {
        if (isObj(raw.mcp.extra)) {
          const secrets = findSecretKeys(raw.mcp.extra);
          if (secrets.length)
            problems.push(`overlay.mcp.extra 含疑似密钥键：${secrets.join(", ")}`);
          else mcp.extra = raw.mcp.extra;
        } else problems.push("overlay.mcp.extra 不是对象");
      }
      if (mcp.disable?.length || mcp.extra) overlay.mcp = mcp;
    }
  }
  return { overlay, problems };
}

export function writeOverlay(agent: string, overlay: AgentOverlay, dir: string = DATA_DIR): void {
  const secrets = [
    ...findSecretKeys(overlay.config ?? {}),
    ...findSecretKeys(overlay.mcp?.extra ?? {}),
  ];
  if (secrets.length) throw new Error(`overlay 不能保存疑似密钥键：${secrets.join(", ")}`);
  writeJsonAtomic(overlayPath(agent, dir), overlay);
}

/** 深合并 patch：对象递归合并，数组整段替换，`null` 删除键。 */
export function applyPatch(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete out[k];
      continue;
    }
    if (isObj(v) && isObj(out[k])) out[k] = applyPatch(out[k] as Record<string, unknown>, v);
    else out[k] = v;
  }
  return out;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * 解析 overlay 的文件键。默认相对 realHome；只有 `extraConfigFiles` 里的目标允许用 `..` 指过去。
 * 返回 real 目标与 view 目标，调用方负责“先断开链接再写副本”。
 */
export function resolveOverlayTarget(
  realHome: string,
  configDir: string,
  key: string,
  extraConfigFiles: string[] = [],
): { real: string; view: string } | null {
  if (!key.trim() || path.isAbsolute(key)) return null;
  const real = path.resolve(realHome, key);
  const view = path.resolve(configDir, key);
  const allowedFile = extraConfigFiles.some((f) => path.resolve(f) === real);
  if (!isInside(real, path.resolve(realHome)) && !allowedFile) return null;
  if (!isInside(view, path.resolve(configDir)) && !allowedFile) return null;
  return { real, view };
}

export function overlayDisableSet(overlay: AgentOverlay): Set<string> {
  return new Set(overlay.mcp?.disable ?? []);
}

export function overlayExtraServers(overlay: AgentOverlay): Record<string, unknown> {
  return overlay.mcp?.extra ?? {};
}

/** overlay 的文件键是否越界；只按 real home 判断，视图目录与它同构。 */
export function overlayPathProblems(
  realHome: string | undefined,
  overlay: AgentOverlay,
  extraConfigFiles: string[] = [],
): string[] {
  if (!realHome || !overlay.config) return [];
  const out: string[] = [];
  for (const key of Object.keys(overlay.config)) {
    const target = resolveOverlayTarget(realHome, realHome, key, extraConfigFiles);
    if (!target) out.push(`overlay.config.${key} 指向了 real home 之外的路径`);
  }
  return out;
}

/** 读一个真实配置文件作为 patch 基底；JSONC/JSON 支持，其它格式返回 null（调用方报错，不静默写坏）。 */
export function readJsonConfig(file: string): Record<string, unknown> | null {
  try {
    return parseJsonc(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}
