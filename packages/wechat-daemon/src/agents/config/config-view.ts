import fs from "node:fs";
import path from "node:path";

import { createLogger } from "@wemind/wechat-ilink-core";

import type { AgentRole } from "../brain-config.js";
import type { ResolvedAgent } from "../brain-agents.js";
import { applyPatch, readJsonConfig, resolveOverlayTarget, type AgentOverlay } from "./overlay.js";
import { writeJsonAtomic } from "../../shared/io/atomic-json.js";

const log = createLogger("wechat-daemon/config-view");

/**
 * 配置视图：给 Agent 一个“看起来像 real home”的目录。
 *
 * - 目录优先 junction/symlink，单文件优先 hardlink；这样技能/记忆/会话仍是真实目录的双向镜像；
 * - 需要 WeMind 权威覆盖的文件（MCP、settingsBase、settingsDefaults、overlay）先断开链接，再生成副本；
 * - 任何“生成副本”都登记在清单里，下一次构建只清理自己创建过的链接，不误删 Agent 自建数据。
 */
export type ConfigView = {
  root: string;
  configDir: string;
  overrides: string[];
};

type ViewManifest = {
  version: 1;
  agent: string;
  links: string[];
  generated: string[];
};

export function viewRoot(role: AgentRole, agent: string, dir: string): string {
  return path.join(dir, "agent-view", role, agent);
}

function manifestPath(root: string): string {
  return path.join(root, ".wemind-view.json");
}

function readManifest(root: string): ViewManifest {
  try {
    const j = JSON.parse(fs.readFileSync(manifestPath(root), "utf-8")) as Partial<ViewManifest>;
    return {
      version: 1,
      agent: typeof j.agent === "string" ? j.agent : "",
      links: Array.isArray(j.links)
        ? j.links.filter((x): x is string => typeof x === "string")
        : [],
      generated: Array.isArray(j.generated)
        ? j.generated.filter((x): x is string => typeof x === "string")
        : [],
    };
  } catch {
    return { version: 1, agent: "", links: [], generated: [] };
  }
}

function writeManifest(root: string, m: ViewManifest): void {
  writeJsonAtomic(manifestPath(root), m);
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function lstat(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function removePath(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/** 删除链接本身，不碰它指向的内容（Windows junction 也走这里）。 */
function removeLink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    try {
      fs.rmdirSync(p);
    } catch {
      removePath(p);
    }
  }
}

/**
 * overlay 的目标文件可能位于一个已链接的父目录下（例如整个 `settings/` 是 junction）。
 * 直接写 `target.view` 会穿透父链接改到真实文件。写前把最近的链接父目录换成真实目录，
 * 再用 linkTree 把除目标文件之外的兄弟重新链接回真实目录。
 */
function materializeLinkedParent(view: ConfigView, target: string): void {
  const relParent = path.relative(view.configDir, path.dirname(target));
  if (relParent === "" || relParent.startsWith("..")) return;
  let cur = view.configDir;
  for (const part of relParent.split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    const st = lstat(cur);
    if (!st?.isSymbolicLink()) continue;

    const realDir = fs.realpathSync(cur);
    const relRoot = path.relative(view.root, cur);
    const relTarget = path.relative(view.configDir, target);
    removeLink(cur);
    fs.mkdirSync(cur, { recursive: true });

    const prev = readManifest(view.root);
    const prevLinks = new Set(prev.links);
    const desired = new Set(prev.links);
    for (const r of desired) {
      if (r === relRoot || r.startsWith(`${relRoot}${path.sep}`)) desired.delete(r);
    }
    // 目标文件本身不链接，留给 applyOverlayToView 写真实副本。
    linkTree(realDir, cur, new Set([relTarget]), prevLinks, desired, view.root, view.configDir);
    writeManifest(view.root, { ...prev, links: [...desired] });
    log.warn(`overlay 目标位于链接目录内，已断开父链接并重建真实目录：${cur}`);
    return;
  }
}

function ensureDirLink(
  src: string,
  dst: string,
  prevLinks: Set<string>,
  desired: Set<string>,
  rel: string,
): void {
  const st = lstat(dst);
  if (st) {
    if (st.isSymbolicLink()) {
      try {
        if (path.resolve(fs.readlinkSync(dst)) === path.resolve(src)) {
          desired.add(rel);
          return;
        }
      } catch {
        /* fallthrough */
      }
      if (prevLinks.has(rel)) removePath(dst);
    } else if (prevLinks.has(rel) && st.isDirectory()) {
      // 上次是复制回退：这次重新尝试链接/复制，避免副本永远停在旧内容。
      removePath(dst);
    }
    // 已存在的真实目录/文件：可能是 Agent 自建数据，保留，不覆盖。
    if (fs.existsSync(dst)) return;
  }
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.symlinkSync(src, dst, process.platform === "win32" ? "junction" : "dir");
    desired.add(rel);
  } catch (e) {
    try {
      fs.cpSync(src, dst, { recursive: true, dereference: false });
      desired.add(rel);
      log.warn(`无法建立目录链接，已复制副本（双向同步可能不完整）：${dst} ← ${src}：${String(e)}`);
    } catch (copyErr) {
      log.warn(`无法建立目录链接 ${dst} → ${src}：${String(e)}；复制也失败：${String(copyErr)}`);
    }
  }
}

function sameHardlink(a: string, b: string): boolean {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

function ensureFileLink(
  src: string,
  dst: string,
  prevLinks: Set<string>,
  desired: Set<string>,
  rel: string,
): void {
  const st = lstat(dst);
  if (st) {
    if (st.isSymbolicLink()) {
      try {
        if (path.resolve(fs.readlinkSync(dst)) === path.resolve(src)) {
          desired.add(rel);
          return;
        }
      } catch {
        /* fallthrough */
      }
      if (prevLinks.has(rel)) removePath(dst);
    } else if (sameHardlink(src, dst)) {
      desired.add(rel);
      return;
    } else if (prevLinks.has(rel)) {
      // 之前由 WeMind 建过链接，但目标变了：重建；不删 Agent 自己写的非清单文件。
      removePath(dst);
    } else {
      return;
    }
  }
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try {
      // 单文件优先 symlink：终端侧原子替换文件后，视图仍指向真实路径；hardlink 会被“写临时文件再 rename”打断。
      fs.symlinkSync(src, dst, "file");
    } catch {
      try {
        fs.linkSync(src, dst);
      } catch {
        fs.copyFileSync(src, dst);
        try {
          fs.chmodSync(dst, 0o600);
        } catch {
          /* Windows：靠目录 ACL */
        }
        log.warn(`无法建立文件链接，已复制副本（双向同步可能不完整）：${dst} ← ${src}`);
      }
    }
    desired.add(rel);
  } catch (e) {
    log.warn(`无法建立文件链接 ${dst} ← ${src}：${String(e)}`);
  }
}

function hasOverriddenChild(rel: string, overrides: Set<string>): boolean {
  const prefix = rel ? `${rel}${path.sep}` : "";
  for (const o of overrides) if (o.startsWith(prefix)) return true;
  return false;
}

function linkTree(
  srcDir: string,
  destDir: string,
  overrides: Set<string>,
  prevLinks: Set<string>,
  desired: Set<string>,
  root: string,
  configDir: string,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === ".wemind-view.json") continue;
    const src = path.join(srcDir, entry.name);
    const dst = path.join(destDir, entry.name);
    // overrides 以 configDir 为基准；manifest 以 view root 为基准。两者不能混用：
    // 有 configSubdir 的 agent（gemini/opencode/claude-code/qoder/cline）会把
    // `settings.json` 记成 `settings.json` 而不是 `.gemini/settings.json`，清理时清错位置。
    const relConfig = path.relative(configDir, dst);
    const relRoot = path.relative(root, dst);
    if (overrides.has(relConfig)) {
      // 上一次构建可能把整个文件链接到真实 home；现在它要由 WeMind 生成，
      // 必须先断开链接，否则后续写副本会穿透到真实配置。
      if (lstat(dst)?.isSymbolicLink()) removeLink(dst);
      continue;
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(src);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (hasOverriddenChild(relConfig, overrides)) {
        // 父目录若还是上一次构建留下的 junction，先断开再建真实目录；
        // 只删链接本身，不碰它指向的内容。
        if (lstat(dst)?.isSymbolicLink()) removeLink(dst);
        try {
          fs.mkdirSync(dst, { recursive: true });
        } catch {
          continue;
        }
        linkTree(src, dst, overrides, prevLinks, desired, root, configDir);
      } else {
        ensureDirLink(src, dst, prevLinks, desired, relRoot);
      }
    } else if (st.isFile()) {
      ensureFileLink(src, dst, prevLinks, desired, relRoot);
    }
  }
}

/** 需要生成副本、不能直接链接的文件（相对 configDir）。 */
export function overrideRelPaths(ag: ResolvedAgent, overlay: AgentOverlay): string[] {
  const out = new Set<string>();
  // 预设里的路径常写成 `settings/mcp.json`（正斜杠）；比较时必须统一成平台分隔符，
  // 否则 Windows 上 `hasOverriddenChild("settings", {"settings/mcp.json"})` 会漏判，
  // 整个 settings/ 变 junction，生成写入就会穿透到真实配置。
  if (!ag.mcpViaAcp) out.add(path.normalize(ag.mcpConfigFile));
  if (ag.settingsBase) out.add(path.normalize(ag.settingsBase));
  if (Object.keys(ag.settingsDefaults).length) out.add("settings.json");
  // kiro v3 的免审批写在 settings/permissions.yaml。不能让 settings/ 整体成为
  // junction：否则 ensureKiroV3Permissions() 会穿透到真实 ~/.kiro/settings。
  if (ag.kiroV3) out.add(path.join("settings", "permissions.yaml"));
  for (const key of Object.keys(overlay.config ?? {})) {
    if (path.isAbsolute(key)) continue;
    const rel = path.normalize(key);
    if (rel !== ".." && !rel.startsWith(`..${path.sep}`)) out.add(rel);
  }
  return [...out];
}

/** 把真实文件先复制一份作为 patch 基底；只在视图目标不存在时复制，避免覆盖上一轮生成结果。 */
function seedOverrideFiles(ag: ResolvedAgent, configDir: string, overrides: string[]): void {
  if (!ag.realHome) return;
  for (const rel of overrides) {
    const src = path.resolve(ag.realHome, rel);
    const dst = path.resolve(configDir, rel);
    if (!isInside(src, path.resolve(ag.realHome)) || !fs.existsSync(src) || fs.existsSync(dst))
      continue;
    try {
      const st = fs.statSync(src);
      if (!st.isFile()) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      try {
        fs.chmodSync(dst, 0o600);
      } catch {
        /* Windows */
      }
    } catch {
      /* best-effort：生成模块会按空基底继续 */
    }
  }
}

function linkExtraFiles(
  ag: ResolvedAgent,
  root: string,
  prevLinks: Set<string>,
  desired: Set<string>,
): void {
  const extras = ag.extraConfigFiles ?? [];
  for (const extra of extras) {
    if (!fs.existsSync(extra.source)) continue;
    const dst = path.join(root, extra.target);
    const rel = path.relative(root, dst);
    ensureFileLink(extra.source, dst, prevLinks, desired, rel);
  }
}

/**
 * 构建/刷新视图。返回后调用方再写 MCP/settings 生成文件；所有覆盖路径都已从链接清单中排除。
 */
export function buildConfigView(
  role: AgentRole,
  ag: ResolvedAgent,
  dir: string,
  overlay: AgentOverlay,
): ConfigView {
  const root = viewRoot(role, ag.name, dir);
  const configDir = ag.configSubdir ? path.join(root, ag.configSubdir) : root;
  fs.mkdirSync(configDir, { recursive: true });
  const prev = readManifest(root);
  const prevLinks = new Set(prev.links);
  const desired = new Set<string>();
  const overrides = overrideRelPaths(ag, overlay);
  const source = ag.realHome;
  if (source && fs.existsSync(source))
    linkTree(source, configDir, new Set(overrides), prevLinks, desired, root, configDir);
  seedOverrideFiles(ag, configDir, overrides);
  linkExtraFiles(ag, root, prevLinks, desired);

  // Claude 这类 agent 的 catalog 可能在配置目录的上一级；只补这一个已知外部文件，不递归猜。
  if (source) {
    const catalogSrc = path.resolve(source, ag.catalogFile);
    const catalogDst = path.resolve(configDir, ag.catalogFile);
    if (
      fs.existsSync(catalogSrc) &&
      !isInside(catalogDst, configDir) &&
      !(ag.extraConfigFiles ?? []).some((x) => path.resolve(x.source) === catalogSrc)
    ) {
      ensureFileLink(catalogSrc, catalogDst, prevLinks, desired, path.relative(root, catalogDst));
    }
  }

  for (const rel of prevLinks) {
    if (desired.has(rel)) continue;
    const p = path.join(root, rel);
    const st = lstat(p);
    // 只清理链接/文件；如果 Agent 把某个链接位置换成了真实目录，保留它的数据。
    if (!st) continue;
    if (st.isSymbolicLink() || st.isFile()) removePath(p);
  }
  writeManifest(root, {
    version: 1,
    agent: ag.name,
    links: [...desired],
    generated: prev.generated,
  });
  return { root, configDir, overrides };
}

/** 标记一个生成文件（供清理时区分“WeMind 生成”与 Agent 自建）。 */
export function markGenerated(view: ConfigView, file: string): void {
  const rel = path.relative(view.root, file);
  const m = readManifest(view.root);
  if (!m.generated.includes(rel)) m.generated.push(rel);
  writeManifest(view.root, m);
}

/** 把 overlay 的 config patch 落到视图副本；不穿透链接。 */
export function applyOverlayToView(
  view: ConfigView,
  ag: ResolvedAgent,
  overlay: AgentOverlay,
): string[] {
  const problems: string[] = [];
  if (!ag.realHome || !overlay.config) return problems;
  for (const [key, patch] of Object.entries(overlay.config)) {
    const ext = path.extname(key).toLowerCase();
    if (ext && ext !== ".json" && ext !== ".jsonc") {
      problems.push(`overlay.config.${key} 的格式暂不支持（当前只支持 .json / .jsonc）`);
      continue;
    }
    const target = resolveOverlayTarget(
      ag.realHome,
      view.configDir,
      key,
      (ag.extraConfigFiles ?? []).map((x) => x.source),
    );
    if (!target) {
      problems.push(`overlay.config.${key} 指向了不允许的路径`);
      continue;
    }
    // 优先读视图：real/mirror 的视图已包含 WeMind 生成内容，sandbox 的视图才是沙箱副本；
    // 直接读 real 会把沙箱里已剥离的 MCP/密钥重新带回来。
    const baseFile = fs.existsSync(target.view) ? target.view : target.real;
    const base = readJsonConfig(baseFile) ?? {};
    const next = applyPatch(base, patch);
    materializeLinkedParent(view, target.view);
    const st = lstat(target.view);
    if (st?.isSymbolicLink()) removePath(target.view);
    try {
      fs.mkdirSync(path.dirname(target.view), { recursive: true });
      writeJsonAtomic(target.view, next);
      markGenerated(view, target.view);
    } catch (e) {
      problems.push(`overlay.config.${key} 写入失败：${String(e)}`);
    }
  }
  return problems;
}
