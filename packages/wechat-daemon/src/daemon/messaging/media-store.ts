import fs from "node:fs";
import path from "node:path";

import { BRAIN_HOME } from "../../agents/sandbox/mcp-sandbox.js";

/**
 * 入站附件落盘。
 *
 * 放在 BRAIN_HOME/media/inbound：brain 的 cwd 就是 BRAIN_HOME，agent 用文件工具可直接按
 * 相对路径 media/inbound/... 找到；prompt 里同时给绝对路径，避免 agent 猜 cwd。
 * 目录/文件权限：POSIX 下 0700/0600；Windows 的 chmod 是 no-op，依赖数据目录本身的权限。
 */

/** 默认保留 7 天；超过就清（微信媒体本身也只保留有限时间）。 */
export const INBOUND_MEDIA_TTL_MS =
  (Number(process.env.WECHAT_MEDIA_TTL_DAYS) || 7) * 24 * 3600_000;
/** 默认总量 256MB，超过按最旧优先清。 */
export const INBOUND_MEDIA_MAX_BYTES =
  (Number(process.env.WECHAT_MEDIA_MAX_MB) || 256) * 1024 * 1024;

const WINDOWS_RESERVED = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** 去掉路径分隔符/控制字符/Windows 保留名，保留扩展名；空结果用 fallback。 */
export function safeMediaFileName(name: string | undefined, fallback = "attachment"): string {
  const base = path.basename((name ?? "").replace(/\\/g, "/"));
  // 控制字符（0x00–0x1f/0x7f）用码点过滤，避免触发 no-control-regex；再替换 Windows 非法字符。
  const noControls = Array.from(base)
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join("");
  let cleaned = noControls
    .replace(/[<>:"|?*]/g, "_")
    .replace(/^\.+/, "")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!cleaned) cleaned = fallback;
  const dot = cleaned.lastIndexOf(".");
  const stem = dot > 0 ? cleaned.slice(0, dot) : cleaned;
  const ext = dot > 0 ? cleaned.slice(dot).replace(/[^A-Za-z0-9.]/g, "") : "";
  const safeStem = WINDOWS_RESERVED.has(stem.toLowerCase()) ? `${stem}_` : stem;
  const out = `${safeStem}${ext}`;
  return out.length > 100 ? out.slice(0, 100) : out;
}

/** 把附件写入 inbox；同名时加 -1/-2 后缀，返回绝对路径。 */
export function saveInboundMedia(
  data: Buffer,
  opts: { messageId: string; fileName?: string; kind: string },
  dir: string = mediaInboxDir(),
): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = (opts.messageId || "msg").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  const name = safeMediaFileName(opts.fileName, `${opts.kind}.bin`);
  const stem = `${id}-${name}`;
  for (let i = 0; i < 100; i++) {
    const file = path.join(dir, i === 0 ? stem : `${id}-${i}-${name}`);
    try {
      fs.writeFileSync(file, data, { flag: "wx", mode: 0o600 });
      return file;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
    }
  }
  throw new Error(`无法为附件生成唯一文件名：${name}`);
}

/** inbox 目录（绝对路径）。 */
export function mediaInboxDir(): string {
  return path.join(BRAIN_HOME, "media", "inbound");
}

/**
 * 清理 inbox：先删过期文件，再按总量从旧到新删到限额内。
 * best-effort：单个文件失败只跳过，不影响消息处理。
 */
export function pruneInboundMedia(
  dir: string = mediaInboxDir(),
  opts: { ttlMs?: number; maxBytes?: number; now?: number } = {},
): { removed: number; bytes: number } {
  const ttlMs = opts.ttlMs ?? INBOUND_MEDIA_TTL_MS;
  const maxBytes = opts.maxBytes ?? INBOUND_MEDIA_MAX_BYTES;
  const now = opts.now ?? Date.now();
  let entries: Array<{ path: string; size: number; mtimeMs: number }> = [];
  try {
    entries = fs
      .readdirSync(dir)
      .map((name) => {
        const file = path.join(dir, name);
        try {
          const st = fs.statSync(file);
          return st.isFile() ? { path: file, size: st.size, mtimeMs: st.mtimeMs } : null;
        } catch {
          return null;
        }
      })
      .filter((e): e is { path: string; size: number; mtimeMs: number } => !!e);
  } catch {
    return { removed: 0, bytes: 0 };
  }

  let removed = 0;
  let bytes = entries.reduce((sum, e) => sum + e.size, 0);
  const remove = (file: string) => {
    try {
      fs.rmSync(file, { force: true });
      removed += 1;
    } catch {
      /* best-effort */
    }
  };

  for (const e of entries.filter((x) => now - x.mtimeMs > ttlMs)) {
    remove(e.path);
    bytes -= e.size;
  }
  const remaining = entries
    .filter((e) => fs.existsSync(e.path))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const e of remaining) {
    if (bytes <= maxBytes) break;
    remove(e.path);
    bytes -= e.size;
  }
  return { removed, bytes: Math.max(0, bytes) };
}
