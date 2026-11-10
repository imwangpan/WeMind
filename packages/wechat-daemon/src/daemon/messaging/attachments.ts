import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DATA_DIR, classifyMediaByName, type MediaKind } from "@wemind/wechat-ilink-core";

import { ACP_AGENT_PRESETS } from "../../agents/brain-presets.js";

/**
 * 出站附件：brain 用显式 Markdown 链接 `[附件](file:///abs/path)` / `[文件](...)` / `[视频](...)`
 * 触发，系统读取本地文件并作为文件/视频消息发出。
 *
 * 用户明确选择了「允许任意绝对路径」。这里仍然强制：
 *  - 只认显式 `[附件]/[文件]/[视频]` 语法，不扫描普通链接；
 *  - 只允许本地绝对路径（file:// 或盘符/根路径），拒绝 UNC/网络路径（避免向远端主机发 SMB 认证）与 NTFS 数据流；
 *  - realpath 后拒绝凭证/状态类文件（防止提示注入把 account.json、agent 登录态发出去）；
 *  - 单文件大小上限（默认 25MB）。
 */

const DEFAULT_MAX_BYTES = (Number(process.env.WECHAT_OUTBOUND_FILE_MAX_MB) || 25) * 1024 * 1024;

const SENSITIVE_NAMES = new Set([
  "account.json",
  "state.json",
  "brain-sessions.json",
  "brain-mcps.json",
  "brain.json",
  "brain-runtime.json",
  "session-registry.json",
  "worker-sessions.json",
  "handoff.json",
  "tasks.json",
  "task-state.json",
  "allow-from.json",
  "qr_login.json",
  "workers.pid.json",
  "daemon.pid",
  "wrapper.pid",
  "brain.pid",
]);

/**
 * 各 agent 同步进沙箱的登录态/凭据文件名（与 `agents/brain-presets.ts` 的 `credentialFiles` 对齐）。
 * 这些文件不在数据目录根下，但同样不能外发：提示注入只要让 brain 写一个附件链接就能把
 * OAuth/API 凭据发到微信里。
 */
const CREDENTIAL_NAMES = new Set([
  ".credentials.json",
  ".credentials.yaml",
  "oauth_creds.json",
  "google_accounts.json",
  "auth.json",
  "providers.json",
  "models.json",
  "models-store.json",
]);

/** 解析真实路径；根目录可能本身是 junction，和已 realpath 的文件比较时必须先解析。 */
function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isUnderRoot(file: string, root: string): boolean {
  try {
    const rel = path.relative(realOrSelf(root), path.resolve(file));
    return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

/**
 * agent 配置文件可能含网关 token / 默认 provider：除了 brain-home/worker-home（都在数据目录下），
 * 各 preset 的 `realHome` 原件同样不能外发（如 `~/.copilot/config.json`、`~/.claude/settings.json`、
 * `~/.pi/agent/models*.json`）。
 */
function isUnderAgentConfigRoot(file: string): boolean {
  const roots: string[] = [DATA_DIR];
  for (const p of [
    process.env.WECHAT_BRAIN_HOME,
    process.env.WEMIND_WORKER_HOME,
    ...Object.values(ACP_AGENT_PRESETS).map((preset) => preset.realHome),
  ]) {
    if (p?.trim()) roots.push(p);
  }
  return roots.some((root) => isUnderRoot(file, root));
}

/**
 * 拒绝凭证/状态类文件（realpath 之后调用）。
 * 说明：路径 denylist 无法识别硬链接（realpath 也指向同一 inode）；这属于已接受的风险——
 * 提示注入已经能让大脑自己读文件，这里的闸只拦「顺手把已知敏感路径外发」。
 */
export function isSensitiveFilePath(file: string): boolean {
  const base = path.basename(file).toLowerCase();
  if (SENSITIVE_NAMES.has(base)) return true;
  if (CREDENTIAL_NAMES.has(base)) return true;
  if (
    path
      .resolve(file)
      .split(path.sep)
      .some((part) => part.toLowerCase() === ".auth")
  )
    return true;
  if (/^\.env(\.|$)/.test(base)) return true;
  if (/\.(pem|key|p12|pfx|jks|keystore)$/.test(base)) return true;
  if (/^id_(rsa|dsa|ed25519|ecdsa)(_sk)?(\.|$)/.test(base)) return true;
  if (/(^|[._-])(secrets?|credentials?|creds?|tokens?|passwords?)([._-]|$)/.test(base)) return true;
  // 沙箱/真实 home 里的 agent 配置可能含默认 provider/网关地址与 token；
  // pi 的 settings.json / models*.json、claude 的 settings.json 尤其如此。
  if (
    (base === "config.json" || base === "settings.json" || /^models.*\.json$/.test(base)) &&
    isUnderAgentConfigRoot(file)
  )
    return true;
  // 数据目录根下的控制桥/任务/日志文件同样属于内部状态。
  try {
    const rel = path.relative(realOrSelf(DATA_DIR), path.resolve(file));
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
      const top = rel.split(path.sep)[0];
      if (["control-in", "control-out", "task-inbox", "task-out"].includes(top)) return true;
      if (rel === "daemon.log" || rel.endsWith(`${path.sep}daemon.log`)) return true;
    }
  } catch {
    /* best-effort */
  }
  return false;
}

/** 命中敏感名单时抛这个类型，调用方据此把附件记进「允许敏感文件」的待补发队列。 */
export class SensitiveFileError extends Error {
  readonly code = "SENSITIVE_FILE";
  constructor(readonly fileName: string) {
    super(`拒绝发送敏感文件：${fileName}`);
    this.name = "SensitiveFileError";
  }
}

/** 是否为敏感名单拒绝（兼容打包后跨副本的判定：先看 code，再看 instanceof）。 */
export function isSensitiveFileError(e: unknown): e is SensitiveFileError {
  return (
    e instanceof SensitiveFileError ||
    (typeof e === "object" && e !== null && (e as { code?: unknown }).code === "SENSITIVE_FILE")
  );
}

export type ExtractedAttachment = {
  src: string;
  /** 由链接标签决定的类型；`附件` 交给扩展名判断。 */
  kind?: MediaKind;
};

/**
 * 从 brain 回复里提取显式附件链接，并返回去掉这些链接后的文本。
 * 先解析尖括号形式 `[附件](<路径>)`（路径里可以有括号），再解析普通形式；普通形式不允许括号。
 */
export function extractAttachments(text: string): {
  attachments: ExtractedAttachment[];
  text: string;
} {
  const attachments: ExtractedAttachment[] = [];
  const seen = new Set<string>();
  const collect = (input: string, re: RegExp): string =>
    input.replace(re, (match, label: string, rawSrc: string) => {
      const src = rawSrc.trim();
      // 出站附件只接受本地绝对路径；http(s) 链接保留在正文里，避免误把网页当文件。
      if (!src || /^https?:/i.test(src)) return match;
      const kind: MediaKind | undefined =
        label === "视频" ? "video" : label === "文件" ? "file" : undefined;
      const key = `${kind ?? "auto"}:${src}`;
      if (!seen.has(key)) {
        seen.add(key);
        attachments.push({ src, kind });
      }
      return "";
    });
  let out = collect(text ?? "", /\[(附件|文件|视频)\]\(\s*<([^>\n]+)>\s*\)/g);
  // 普通形式整段排除 `<` 与 `(`：残缺的尖括号语法、以及含 `)` 的路径都保留为正文，
  // 避免把 `report (1).pdf` 截成 `report (1` 后发错文件。这类路径必须写成 `<...>`。
  out = collect(out, /\[(附件|文件|视频)\]\(\s*([^<()\n][^<()\n]*?)\s*\)/g);
  // 没有附件链接时原样返回：下面的清理只用于「移除链接后留下的空行」，不该改动正文里的 Markdown 代码块空行或首尾空白。
  if (attachments.length === 0) return { attachments: [], text: text ?? "" };
  return {
    attachments,
    text: out
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  };
}

export type ResolvedAttachment = {
  data: Buffer;
  fileName: string;
  kind: MediaKind;
  /** 命中了敏感名单、但被「允许敏感文件」窗口放行（调用方据此记日志，便于事后审计）。 */
  sensitiveBypassed?: boolean;
};

/** file:// URL 只接受空 host；localhost 会被 WHATWG URL 规范化为空 host（等价 file:///），带其它 host 的写法一律按网络路径拒绝（Windows 上 fileURLToPath 会解析成 UNC）。 */
function localFilePath(src: string): string {
  if (!/^file:/i.test(src)) return src;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    throw new Error(`无效的 file:// 路径：${src}`);
  }
  if (url.protocol !== "file:") throw new Error(`不是本地文件路径：${src}`);
  if (url.host) throw new Error(`只允许本地绝对路径（不支持网络路径）：${src}`);
  return fileURLToPath(url);
}

/** 去掉 Windows 的 `\\?\` 长路径前缀；`\\?\UNC\` 还原成普通 UNC 以便拒绝。 */
function normalizeWinPath(p: string): string {
  if (process.platform !== "win32") return p;
  if (p.startsWith("\\\\?\\UNC\\")) return `\\\\${p.slice(8)}`;
  if (p.startsWith("\\\\?\\")) return p.slice(4);
  return p;
}

/**
 * 拒绝网络路径与 NTFS 备用数据流。
 * `account.json::$DATA` 这类 ADS 路径 basename 会变成 `account.json::$data`，能绕过所有按名规则。
 */
function assertLocalPath(p: string, src: string): void {
  const q = normalizeWinPath(p);
  // UNC（\\server\share）会触发 SMB 认证；只允许本机路径。
  if (/^[\\/]{2}/.test(q)) throw new Error(`只允许本地绝对路径（不支持网络路径）：${src}`);
  if (process.platform === "win32") {
    // 盘符后的冒号在 Windows 文件名里非法，只会是流名。
    const tail = /^[A-Za-z]:/.test(q) ? q.slice(2) : q;
    if (tail.includes(":")) throw new Error(`拒绝 NTFS 数据流路径：${src}`);
  }
}

/** 读取一个出站附件；路径/权限/大小/敏感文件校验都在这里。 */
export function resolveAttachment(
  attachment: ExtractedAttachment,
  maxBytes: number = DEFAULT_MAX_BYTES,
  opts: { allowSensitive?: boolean } = {},
): ResolvedAttachment {
  const raw = localFilePath(attachment.src);
  assertLocalPath(raw, attachment.src);
  if (!path.isAbsolute(raw)) throw new Error(`只允许绝对路径：${attachment.src}`);
  // 软链接/目录联接可能在 realpath 时才暴露成网络路径：先看链接目标，再看解析结果。
  const lst = fs.lstatSync(raw);
  if (lst.isSymbolicLink()) {
    const target = fs.readlinkSync(raw);
    assertLocalPath(path.resolve(path.dirname(raw), target), attachment.src);
  }
  const real = fs.realpathSync(raw);
  assertLocalPath(real, attachment.src);
  // 「允许敏感文件」窗口只跳过这张名单；网络路径/数据流/大小上限在前后照旧执行。
  const sensitive = isSensitiveFilePath(real);
  if (sensitive && !opts.allowSensitive) throw new SensitiveFileError(path.basename(real));
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error(`不是文件：${real}`);
  if (st.size > maxBytes) throw new Error(`文件过大 ${st.size} > ${maxBytes}`);
  const fileName = path.basename(real);
  const kind = attachment.kind ?? classifyMediaByName(fileName);
  return {
    data: fs.readFileSync(real),
    fileName,
    kind,
    sensitiveBypassed: sensitive && opts.allowSensitive === true,
  };
}

export type AttachmentFailureReason = "read" | "send" | "budget" | "sensitive";

export type AttachmentFailure = {
  src: string;
  reason: AttachmentFailureReason;
};

/** 把附件失败按原因归类成给用户的附注；没有失败返回空串。 */
export function attachmentFailureNote(failures: AttachmentFailure[]): string {
  if (failures.length === 0) return "";
  const labels: Record<AttachmentFailureReason, string> = {
    read: "没能读取/校验通过",
    send: "没能发出去",
    budget: "因接近微信连续发送上限没发",
    sensitive: "被敏感文件名单拦下（回复「允许敏感文件」可补发）",
  };
  return (["read", "send", "budget", "sensitive"] as const)
    .map((reason) => {
      const items = failures.filter((f) => f.reason === reason).map((f) => f.src);
      return items.length
        ? `（有 ${items.length} 个附件${labels[reason]}，原引用：\n${items.join("\n")}）`
        : "";
    })
    .filter(Boolean)
    .join("\n\n");
}
