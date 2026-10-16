import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { DATA_DIR } from "@wemind/wechat-ilink-core";
import { resolveAgent } from "./brain-agents.js";
import { readMcpServers, withMcpServers, parseJsonc } from "./agent-mcp.js";

/**
 * worker 沙箱：与 brain 沙箱（mcp-sandbox.ts）并列，但 MCP 策略相反。
 *
 * worker 是无人值守的任务执行机，默认**继承真实配置目录的全部 MCP**（仅排除 wechat 防回环），
 * 而非 brain 的「默认空 + 对话中按需加载」——因为没人在旁边逐个加载工具，任务需要开箱即用的完整能力。
 * 记忆/技能/规则（mirrorRealKiro）与 settings（syncSettings，含模型/信任）的继承与 brain 一致。
 *
 * 按 agent 适配（同 mcp-sandbox.ts）：配置目录、MCP 格式、设置继承方式均随 agent 而变。
 *
 * 设计依据：docs/方案C-MVP-远程human-in-the-loop.md §8.4。
 * 与 mcp-sandbox.ts 有少量重复（mirrorRealKiro/syncSettings），刻意复制以隔离演进、不动已稳定的 brain 沙箱。
 */

const AG = resolveAgent();

/** worker 专用沙箱根（由 agent 的 homeEnvVar 指向它）。 */
export const WORKER_HOME =
  process.env.WEMIND_WORKER_HOME?.trim() || path.join(DATA_DIR, "worker-home");

/** 该 agent 在 worker 沙箱里的「配置目录」（kiro=沙箱根；opencode=<沙箱>/opencode）。 */
export const WORKER_CONFIG_DIR = path.join(WORKER_HOME, AG.configSubdir);

const WORKER_MCP_JSON = path.join(WORKER_CONFIG_DIR, AG.mcpConfigFile);

/** MCP「目录」：可继承的 MCP 定义来源（同 brain，默认取 agent 真实配置目录的 catalogFile）。 */
const CATALOG =
  process.env.WEMIND_MCP_CATALOG?.trim() ||
  process.env.WECHAT_MCP_CATALOG?.trim() ||
  path.join(AG.realHome || path.join(os.homedir(), ".kiro"), AG.catalogFile);

/** worker 不继承的 MCP：wechat 始终强制排除（防回环），外加 WEMIND_WORKER_MCP_EXCLUDE 指定的。 */
function excludeSet(): Set<string> {
  const raw = process.env.WEMIND_WORKER_MCP_EXCLUDE ?? "wechat";
  const s = new Set(
    raw
      .split(/[,\s]+/)
      .map((x) => x.trim())
      .filter(Boolean),
  );
  s.add("wechat"); // 强制：worker 加载 wechat 会用同一 bot token 长轮询、与 daemon 抢消息（坑①回环）
  return s;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function loadCatalog(): Record<string, unknown> {
  return readMcpServers(readJson(CATALOG), AG.mcpFormat);
}

/** worker 继承全量 MCP：复制 catalog 全部 server，去掉排除集与 disabled:true 的。 */
export function applyWorkerSandbox(): void {
  const cat = loadCatalog();
  const ex = excludeSet();
  const servers: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(cat)) {
    if (ex.has(name)) continue;
    if (def && typeof def === "object" && (def as { disabled?: unknown }).disabled === true)
      continue; // 跳过用户已禁用的
    servers[name] = def;
  }
  const existing = readJson(WORKER_MCP_JSON) ?? {};
  const next = withMcpServers(existing, servers, AG.mcpFormat);
  fs.mkdirSync(path.dirname(WORKER_MCP_JSON), { recursive: true });
  fs.writeFileSync(WORKER_MCP_JSON, JSON.stringify(next, null, 2), "utf-8");
}

/** kiro：继承真实 settings/ 下除 mcp.json 外的文件（cli.json 含模型/免确认等）。逻辑同 brain 的 syncKiroSettings。 */
function syncKiroSettings(): void {
  const realSettings = path.join(AG.realHome!, "settings");
  const workerSettings = path.join(WORKER_CONFIG_DIR, "settings");
  if (!fs.existsSync(realSettings)) return;
  try {
    fs.mkdirSync(workerSettings, { recursive: true });
  } catch {
    /* ignore */
  }
  let names: string[] = [];
  try {
    names = fs.readdirSync(realSettings);
  } catch {
    return;
  }
  for (const f of names) {
    if (f === "mcp.json") continue; // MCP 用 worker curated 版本（applyWorkerSandbox 全量除排除集）
    try {
      const src = path.join(realSettings, f);
      if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(workerSettings, f));
    } catch {
      /* best-effort */
    }
  }
}

/** opencode：把用户全局 opencode.json(c)（去 mcp 段）作基底写入 worker 沙箱，继承 model 等；mcp 由 applyWorkerSandbox 覆盖。 */
function syncOpencodeBase(): void {
  const src = ["opencode.json", "opencode.jsonc"]
    .map((f) => path.join(AG.realHome!, f))
    .find((f) => fs.existsSync(f));
  if (!src) return;
  let parsed: Record<string, unknown> | null = null;
  try {
    const raw = fs.readFileSync(src, "utf-8");
    parsed = src.endsWith(".jsonc")
      ? parseJsonc(raw)
      : (JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  delete (parsed as Record<string, unknown>).mcp;
  fs.mkdirSync(WORKER_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(WORKER_MCP_JSON, JSON.stringify(parsed, null, 2), "utf-8");
}

function syncSettings(): void {
  if (!AG.inherit || !AG.realHome) return;
  if (AG.mcpFormat === "opencode") syncOpencodeBase();
  else syncKiroSettings();
}

/** 用 junction/symlink 把真实配置目录的记忆/技能/规则类子目录链入 worker 配置目录；单文件记忆直接拷。逻辑同 brain 的 mirrorRealKiro。 */
function mirrorRealKiro(): void {
  if (!AG.inherit || !AG.realHome) return;
  if (path.resolve(WORKER_HOME) === path.resolve(AG.realHome)) return; // 安全：别把自己链给自己
  try {
    fs.mkdirSync(WORKER_CONFIG_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
  for (const d of AG.inheritDirs) {
    const target = path.join(AG.realHome, d);
    const link = path.join(WORKER_CONFIG_DIR, d);
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
        if (st.isSymbolicLink()) continue; // 已是链接 → 不动
        if (st.isDirectory()) {
          if (fs.readdirSync(link).length === 0) {
            fs.rmdirSync(link); // 空目录 → 删掉，下面改建 junction
          } else {
            // 非空真实目录：补拷真实目录里缺失的文件（不删已有）
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
  for (const f of AG.inheritFiles) {
    const src = path.join(AG.realHome, f);
    const dst = path.join(WORKER_CONFIG_DIR, f);
    try {
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
    } catch {
      /* ignore */
    }
  }
}

/** 启动时确保 worker 沙箱就绪：继承 settings（除 mcp）→ 写全量 MCP（除排除集）→ 链入记忆/技能。 */
export function ensureWorkerHome(): void {
  syncSettings(); // 先同步「非 MCP」设置（模型/免确认等）
  applyWorkerSandbox(); // 再写全量 MCP（除 wechat 等排除集）
  mirrorRealKiro(); // 链入记忆/steering/skills（sessions 仍隔离）
}
