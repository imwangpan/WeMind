import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "@wemind/wechat-ilink-core";

import type { ResolvedAgent } from "../brain-agents.js";
import type { AgentRuntime } from "./runtime.js";
import { overlayPath } from "./overlay.js";

/** 这些文件由 agent 自己高频写入（会话/历史/统计），不是「配置」；拿内容当指纹会让进程每轮重启。 */
const VOLATILE = new Set([
  ".claude.json",
  "history.jsonl",
  "todos.json",
  "statsig",
  "shell-snapshots",
  "projects",
]);

/**
 * 配置指纹：长跑进程发现终端侧改了配置后，在下一条消息/下一次 spawn 前重建进程，
 * 而不是等 daemon 重启。
 *
 * 只看**明确的配置文件内容**，不做目录递归 mtime 扫描：递归会把 agent 自己写的历史/会话当成
 * “终端改了配置”，导致每轮重启（实测 qoder/claude 都会）。
 *
 * 没有可重定向配置目录的 agent（claude-code / cline / qoder 等）返回空串：它们直接读真实配置，
 * WeMind 不做热重载；改完配置重启 daemon 即可。
 */
export function configFingerprint(
  ag: ResolvedAgent,
  rt: AgentRuntime,
  dir: string = DATA_DIR,
): string {
  if (!ag.homeEnvVar) return "";
  // sandbox 的副本只在重建时更新，所以统一盯**真实配置**：终端改完，下一次 spawn 才会重新复制。
  const base = ag.realHome || rt.configDir;
  if (!base) return "";
  const h = crypto.createHash("sha1");
  const files = new Set<string>();
  const add = (rel: string | undefined): void => {
    if (!rel) return;
    const p = path.resolve(base, rel);
    if (VOLATILE.has(path.basename(p))) return;
    files.add(p);
  };
  add(ag.settingsBase);
  add(ag.mcpConfigFile);
  add(ag.catalogFile);
  for (const f of ag.extraConfigFiles ?? []) {
    if (VOLATILE.has(path.basename(f))) continue;
    add(path.relative(base, f));
  }
  // DSH 这类 provider/默认模型在 profile 目录里：只取一层文件内容，不递归整个 home。
  if (ag.realProfile) {
    const profile = path.join(base, "profiles", ag.realProfile);
    try {
      for (const e of fs.readdirSync(profile, { withFileTypes: true })) {
        if (e.isFile() && !VOLATILE.has(e.name))
          add(path.relative(base, path.join(profile, e.name)));
      }
    } catch {
      /* profile 不存在：不参与指纹 */
    }
  }
  for (const p of [...files].sort()) {
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      h.update(`${p}\0missing\n`);
      continue;
    }
    if (!st.isFile()) {
      h.update(`${p}\0not-a-file\n`);
      continue;
    }
    // 内容哈希：终端用“写临时文件再 rename”原子替换时 mtime/size 可能不变或抖动，内容最可靠。
    try {
      const buf = fs.readFileSync(p);
      const digest = crypto.createHash("sha1").update(buf).digest("hex");
      h.update(`${p}\0${digest}\n`);
    } catch {
      h.update(`${p}\0unreadable\n`);
    }
  }
  // 微信侧 overlay 也属于“下一次启动该看到的配置”。
  try {
    const ov = overlayPath(ag.name, dir);
    h.update(`overlay\0${crypto.createHash("sha1").update(fs.readFileSync(ov)).digest("hex")}\n`);
  } catch {
    h.update("overlay\0missing\n");
  }
  return h.digest("hex");
}
