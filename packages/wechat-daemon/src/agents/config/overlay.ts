import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { DATA_DIR } from "@wemind/wechat-ilink-core";

import { writeJsonAtomic } from "../../shared/io/atomic-json.js";
import { findForbiddenMcpEntries, normalizeMcpName } from "../sandbox/agent-mcp.js";

/**
 * 微信侧独享配置：`<账号>/agent-overrides/<agent>.json`。
 *
 * WeMind 不改写 Agent 配置，所以这里**只支持会话级 MCP 调整**：
 * - `mcp.disable`：不把同名 MCP 交给 ACP（仅对走 ACP 下发 MCP 的 agent 有效）；
 * - `mcp.extra`：额外追加的 MCP 定义（对象即定义，不落盘）。
 *
 * 其余微信独享项（模型/模式/回复风格）走会话参数或运行时指令，不在这里改 Agent 文件。
 * 默认修改 Agent 真实配置；只有用户明确说“微信侧/仅微信”时才用这个文件。
 */
export type OverlayMcp = {
  disable?: string[];
  extra?: Record<string, unknown>;
};

export type AgentOverlay = {
  version: 1;
  mcp?: OverlayMcp;
};

export type OverlayRead = {
  overlay: AgentOverlay;
  problems: string[];
};

export function overlayPath(agent: string, dir: string = DATA_DIR): string {
  // agent 名来自微信指令；不校验就能用 `../runtime` 覆盖账号自己的 runtime.json / 别的账号。
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(agent) || agent.includes(".."))
    throw new Error(`非法 agent 名：${agent}`);
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

/** 明显的密钥值（不只看键名）：sk-…、GitHub/Slack/AWS token、Bearer、私钥头。 */
function looksSecretValue(v: unknown): boolean {
  if (typeof v !== "string") return false;
  return (
    /(^|[^a-z0-9])sk-[a-z0-9_-]{12,}/i.test(v) ||
    /gh[pousr]_[A-Za-z0-9]{20,}/.test(v) ||
    /xox[baprs]-[A-Za-z0-9-]{10,}/.test(v) ||
    /AKIA[0-9A-Z]{16}/.test(v) ||
    /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/i.test(v) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(v)
  );
}

/** 递归检查配置 patch：明显密钥键名 + 明显密钥值（数组也递归）。 */
export function findSecretKeys(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    const out: string[] = [];
    value.forEach((v, i) => out.push(...findSecretKeys(v, `${prefix}[${i}]`)));
    return out;
  }
  if (!isObj(value)) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (looksSecretKey(k)) out.push(key);
    // 只报键名，不把密钥值写进日志/错误信息
    if (typeof v === "string" && looksSecretValue(v) && !looksSecretKey(k))
      out.push(`${key}（值疑似密钥）`);
    out.push(...findSecretKeys(v, key));
  }
  return out;
}

/** 读 overlay；损坏/版本不支持返回空对象并记录问题，调用方决定是否告警。 */
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
  if (raw.config !== undefined)
    problems.push(
      "overlay.config 已不再支持：WeMind 不改写 Agent 配置文件；微信独享配置只支持 mcp.disable / mcp.extra",
    );
  const overlay: AgentOverlay = { version: 1 };
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

/** 写前备份（保留最近 5 份）；用于回滚手工改坏的 overlay。 */
function backupOverlay(file: string): void {
  if (!fs.existsSync(file)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${file}.wemind-bak-${stamp}`;
  try {
    fs.copyFileSync(file, backup);
  } catch {
    return;
  }
  try {
    const dir = path.dirname(file);
    const prefix = `${path.basename(file)}.wemind-bak-`;
    const old = fs
      .readdirSync(dir)
      .filter((n) => n.startsWith(prefix))
      .sort();
    for (const n of old.slice(0, Math.max(0, old.length - 5))) {
      fs.rmSync(path.join(dir, n), { force: true });
    }
  } catch {
    /* 清理失败不影响写入 */
  }
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function writeOverlay(
  agent: string,
  overlay: AgentOverlay,
  dir: string = DATA_DIR,
  opts: { expectedSha256?: string } = {},
): void {
  const secrets = findSecretKeys(overlay.mcp?.extra ?? {});
  if (secrets.length) throw new Error(`overlay 不能保存疑似密钥：${secrets.join(", ")}`);
  const forbidden = findForbiddenMcpEntries(overlay.mcp?.extra ?? {});
  if (forbidden.length)
    throw new Error(
      `overlay 不能加入微信 MCP（${forbidden.join(", ")}）：会形成第二个 poller/回环。`,
    );
  const file = overlayPath(agent, dir);
  if (opts.expectedSha256 !== undefined && fs.existsSync(file)) {
    const cur = sha256(fs.readFileSync(file, "utf-8"));
    if (cur !== opts.expectedSha256)
      throw new Error("overlay 在读取后被其它程序修改，已拒绝覆盖（请重试）。");
  }
  backupOverlay(file);
  writeJsonAtomic(file, overlay);
}

export function overlayDisableSet(overlay: AgentOverlay): Set<string> {
  return new Set((overlay.mcp?.disable ?? []).map(normalizeMcpName));
}

export function overlayExtraServers(overlay: AgentOverlay): Record<string, unknown> {
  return overlay.mcp?.extra ?? {};
}
