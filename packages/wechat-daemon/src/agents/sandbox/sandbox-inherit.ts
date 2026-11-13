import fs from "node:fs";
import path from "node:path";

import type { ResolvedAgent } from "../brain-agents.js";

/**
 * 把 agent 真实配置目录里的「记忆/规则/技能」链入沙箱配置目录，并在**换 agent** 时清掉上一个 agent 留下的条目。
 * 仅在 `sandbox` 模式调用；`direct` 直接读真实配置、不生成任何副本，不走本模块。
 *
 * 为什么需要清单：kiro / deepseek / pi 的 `configSubdir` 都是空（配置目录就是沙箱根），共用同一个目录。
 * 热切换后若只做「不存在才建」，新 agent 会继续读到上一个 agent 的 `skills` 链接与 `AGENTS.md`——
 * 表现为「切到 pi 了，但回答仍按 kiro 的记忆来」。清单记录上次由 WeMind 链入/拷贝的名字，只清理这些，
 * 真实配置目录永远不动（沙箱里的非链接目录也保留，避免误删 agent 自建数据）。
 *
 * brain 与 worker 共用（两边的沙箱布局相同，只是根目录不同）。
 */

const MANIFEST = ".wemind-inherited.json";

type Manifest = { agent?: string; dirs: string[]; files: string[] };

function readManifest(dir: string): Manifest {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), "utf-8"));
    return {
      agent: typeof j?.agent === "string" ? j.agent : undefined,
      dirs: Array.isArray(j?.dirs) ? j.dirs.filter((x: unknown) => typeof x === "string") : [],
      files: Array.isArray(j?.files) ? j.files.filter((x: unknown) => typeof x === "string") : [],
    };
  } catch {
    return { dirs: [], files: [] };
  }
}

function writeManifest(dir: string, m: Manifest): void {
  try {
    fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(m, null, 2), "utf-8");
  } catch {
    /* best-effort */
  }
}

/** 删掉一个链接本身（不碰它指向的真实目录）。 */
function removeLink(link: string): void {
  try {
    fs.unlinkSync(link);
  } catch {
    try {
      fs.rmdirSync(link);
    } catch {
      /* 不存在 / 权限不足 */
    }
  }
}

function pointsTo(link: string, target: string): boolean {
  try {
    return path.resolve(fs.readlinkSync(link)) === path.resolve(target);
  } catch {
    return false;
  }
}

/**
 * `root` = 沙箱根（安全校验用），`dir` = 该 agent 的配置目录（通常是 root 或 root/<subdir>）。
 * 调用前 `dir` 不存在也没关系。
 */
export function syncInherited(root: string, dir: string, ag: ResolvedAgent): void {
  if (!ag.inherit || !ag.realHome) return;
  if (path.resolve(root) === path.resolve(ag.realHome)) return; // 安全：别把自己链给自己
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return;
  }
  const prev = readManifest(dir);
  const staleFiles = new Set(prev.agent !== ag.name ? prev.files : []);
  const keepDirs = new Set(ag.inheritDirs);
  const keepFiles = new Set(ag.inheritFiles);

  // 1) 清掉上一个 agent 有、这个 agent 不要的条目。
  for (const d of prev.dirs) {
    if (keepDirs.has(d)) continue;
    const link = path.join(dir, d);
    try {
      if (fs.lstatSync(link).isSymbolicLink()) removeLink(link);
    } catch {
      /* 不存在 */
    }
  }
  for (const f of prev.files) {
    if (keepFiles.has(f)) continue;
    try {
      fs.rmSync(path.join(dir, f), { force: true });
    } catch {
      /* ignore */
    }
  }

  // 2) 链入目录：同名链接指向别的真实目录（上一个 agent）时重建。
  for (const d of ag.inheritDirs) {
    const target = path.join(ag.realHome, d);
    const link = path.join(dir, d);
    if (!fs.existsSync(target)) continue;
    let present = false;
    try {
      fs.lstatSync(link);
      present = true;
    } catch {
      /* 不存在 */
    }
    if (present) {
      try {
        const st = fs.lstatSync(link);
        if (st.isSymbolicLink()) {
          if (pointsTo(link, target)) continue; // 已指向当前 agent 的真实目录
          removeLink(link); // 指向上一个 agent → 重建
        } else if (st.isDirectory()) {
          if (fs.readdirSync(link).length === 0) {
            fs.rmdirSync(link); // 空目录 → 删掉，下面改建 junction
          } else {
            // 非空真实目录（如 kiro 自建 agents 脚手架）：补拷真实目录里缺失的文件（不删已有）
            for (const f of fs.readdirSync(target)) {
              const dst = path.join(link, f);
              const src = path.join(target, f);
              try {
                if (!fs.existsSync(dst) && fs.statSync(src).isFile()) fs.copyFileSync(src, dst);
              } catch {
                /* ignore */
              }
            }
            continue;
          }
        } else continue;
      } catch {
        continue;
      }
    }
    try {
      fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    } catch {
      /* 权限不足等：best-effort 忽略 */
    }
  }

  // 3) 单文件记忆：真实目录有就拷；上一个 agent 留下的同名文件视为过期，用当前 agent 的覆盖。
  for (const f of ag.inheritFiles) {
    const src = path.join(ag.realHome, f);
    const dst = path.join(dir, f);
    try {
      if (fs.existsSync(src) && (!fs.existsSync(dst) || staleFiles.has(f)))
        fs.copyFileSync(src, dst);
    } catch {
      /* ignore */
    }
  }

  writeManifest(dir, { agent: ag.name, dirs: [...ag.inheritDirs], files: [...ag.inheritFiles] });
}
