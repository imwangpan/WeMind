import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "@wemind/wechat-ilink-core";

import type { ResolvedAgent } from "../brain-agents.js";
import { overlayPath } from "./overlay.js";

/**
 * 真实配置的轻量指纹：用于“长跑进程发现终端侧改了配置”后，在下一条消息/下一次 spawn 前重建，而不是等 daemon 重启。
 *
 * 不递归整个 home（Gemini 的 realHome 就是家目录）：只覆盖配置目录两层、已知额外配置文件、以及记忆/技能目录的 mtime。
 * 它不追求内容级 diff；目录 mtime + 文件 mtime/size 足以发现“新增/修改/删除”，漏掉的极端情况用 `wemind config reload` 兜底。
 */
export function configFingerprint(ag: ResolvedAgent, dir: string = DATA_DIR): string {
  const home = ag.realHome;
  if (!home) return "";
  const base =
    ag.name === "gemini" && fs.existsSync(path.join(home, ".gemini"))
      ? path.join(home, ".gemini")
      : home;
  const h = crypto.createHash("sha1");
  const seen = new Set<string>();
  const visit = (p: string, depth: number): void => {
    if (depth < 0 || seen.has(p) || seen.size > 2000) return;
    seen.add(p);
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      return;
    }
    h.update(`${p}\0${st.mtimeMs}\0${st.size}\n`);
    if (!st.isDirectory() || depth === 0) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "sessions") continue;
      visit(path.join(p, e.name), depth - 1);
    }
  };
  visit(base, 2);
  for (const f of ag.extraConfigFiles ?? []) visit(f.source, 0);
  for (const d of ag.inheritDirs) {
    const p = path.join(home, d);
    if (fs.existsSync(p)) visit(p, 1);
  }
  // 微信侧 overlay 也属于“下一次启动/新会话该看到的配置”：改了它也要重建视图，
  // 否则进程常驻时 overlay 会一直停在旧副本。
  visit(overlayPath(ag.name, dir), 0);
  return h.digest("hex");
}
