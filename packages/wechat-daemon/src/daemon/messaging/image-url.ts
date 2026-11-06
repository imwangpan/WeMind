import dns from "node:dns/promises";
import net from "node:net";

/**
 * 发图 URL 的安全闸：只允许公网 http(s)。
 *
 * 大脑的回复可能被微信里的提示注入带偏，让它输出 `http://127.0.0.1:…` / 内网服务地址；daemon 直接 fetch 会把
 * 内网响应当作图片发回微信（SSRF）。这里在每次请求（含每一跳重定向）前校验主机，拒绝回环/私网/链路本地等地址。
 * 本地文件绝对路径不受影响——那是大脑自己就能读的文件，不是网络面。
 */

type Lookup = (host: string) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: Lookup = (host) => dns.lookup(host, { all: true });

function ipv4Parts(ip: string): number[] {
  const p = ip.split(".").map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : [];
}

function ipv4Private(ip: string): boolean {
  const p = ipv4Parts(ip);
  if (p.length !== 4) return false;
  const [a, b] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) /* CGNAT */ ||
    (a === 169 && b === 254) /* 链路本地（含云元数据 169.254.169.254） */ ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) /* 基准测试 */ ||
    a >= 224 /* 组播 + 保留 */
  );
}

/** 把 IPv6 字面量折成 BigInt（支持 `::` 压缩与末尾内嵌 IPv4）；解析不了返回 null。 */
function ipv6ToBigInt(ip: string): bigint | null {
  let s = ip.toLowerCase();
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct); // zone id
  let tail: number[] = [];
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const p = ipv4Parts(v4[1]);
    if (p.length !== 4) return null;
    tail = [p[0] * 256 + p[1], p[2] * 256 + p[3]];
    s = s.slice(0, s.length - v4[1].length).replace(/:$/, "");
    if (!s) return null;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (!part) return [];
    const out: number[] = [];
    for (const h of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
      out.push(parseInt(h, 16));
    }
    return out;
  };
  const head = parse(halves[0] ?? "");
  const mid = parse(halves[1] ?? "");
  if (!head || !mid) return null;
  const missing = 8 - head.length - mid.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array<number>(missing).fill(0), ...mid, ...tail];
  let v = 0n;
  for (const g of groups) v = (v << 16n) | BigInt(g);
  return v;
}

function ipv6Private(ip: string): boolean {
  const v = ipv6ToBigInt(ip);
  if (v === null) return true; // 解析不了：保守拒绝
  if (v === 0n || v === 1n) return true; // :: / ::1
  const top16 = v >> 112n;
  if ((top16 & 0xffc0n) === 0xfe80n) return true; // fe80::/10 链路本地
  if ((top16 & 0xffc0n) === 0xfec0n) return true; // fec0::/10 站点本地（已弃用）
  if ((top16 & 0xfe00n) === 0xfc00n) return true; // fc00::/7 唯一本地
  if ((top16 & 0xff00n) === 0xff00n) return true; // ff00::/8 组播
  if (v >> 32n === 0xffffn) {
    // ::ffff:0:0/96：内嵌 IPv4，按 IPv4 规则再判一次
    const n = Number(v & 0xffffffffn);
    return ipv4Private(`${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`);
  }
  return false;
}

/** 回环/私网/链路本地/组播等「不该从公网图片地址访问」的地址；非 IP 字面量返回 false。 */
export function isPrivateAddress(ip: string): boolean {
  const t = ip.trim();
  const fam = net.isIP(t);
  if (fam === 4) return ipv4Private(t);
  if (fam === 6) return ipv6Private(t);
  return false;
}

/**
 * 校验图片 URL：协议只能是 http(s)，主机不能是本机/内网。
 * 域名要先解析、逐个地址检查（解析失败也拒绝——宁可不发图，也不把请求打到不可知的主机）。
 */
export async function assertPublicHttpUrl(
  raw: string,
  lookup: Lookup = defaultLookup,
): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`图片地址不是合法 URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`只允许 http/https 图片地址: ${raw}`);
  }
  const host = u.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (!host) throw new Error(`图片地址缺少主机: ${raw}`);
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error(`拒绝访问本机/内网地址: ${host}`);
  }
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error(`拒绝访问本机/内网地址: ${host}`);
    return u;
  }
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookup(host);
  } catch {
    throw new Error(`无法解析图片地址的主机: ${host}`);
  }
  if (!addrs.length) throw new Error(`无法解析图片地址的主机: ${host}`);
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) {
      throw new Error(`拒绝访问本机/内网地址: ${host}（${a.address}）`);
    }
  }
  return u;
}
