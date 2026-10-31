import fs from "node:fs";
import path from "node:path";

/**
 * Cline ACP 的认证桥接。
 *
 * Cline 的 `isSessionReady()` 只自动恢复它自己的 3 种登录（`cline` / `cline-pass` / `openai-codex`），
 * 自定义/API-key provider（如 `openai-compatible`）不在 `tryRestoreAuth()` 的列表里——即使
 * `data/settings/providers.json` 里已经存在 `lastUsedProvider` 和 `apiKey`，`session/new` 也会报
 * `-32000 Authentication required`。Cline 官方给 ACP 的逃生口是 `CLINE_PROVIDER` + `CLINE_API_KEY`。
 *
 * 这里做一层**只读、按需**的桥接：父进程没有显式提供这两个变量时，把 `lastUsedProvider` 对应的
 * `settings.apiKey` 转成这两个环境变量，从而复用用户已经用 `cline auth` / 手写配置好的登录态。
 *
 * 边界（刻意收窄）：
 * - **显式环境变量永远优先**：`CLINE_PROVIDER` 或 `CLINE_API_KEY` 只要有一个已存在，就完全不接管
 *   （避免把父进程的 provider 和配置文件里的 key 错配）；
 * - 只认 `lastUsedProvider`，且该 provider 必须有非空字符串 `apiKey`；OAuth 条目（只有 `auth`、
 *   没有 `apiKey`）不处理，继续走 Cline 自己的 `tryRestoreAuth()`；
 * - 文件不存在 / JSON 坏了 / 结构不对 → 返回空表，不抛异常（登录态问题仍由原来的认证提示暴露）；
 * - 只读不写，不打印 key。
 */
export function clineCredentialEnv(
  realHome: string | undefined,
  parentEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  if (parentEnv.CLINE_PROVIDER?.trim() || parentEnv.CLINE_API_KEY?.trim()) return {};
  if (!realHome) return {};

  const file = path.join(realHome, "data", "settings", "providers.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return {};
  }
  if (!isObj(parsed)) return {};

  const providerId =
    typeof parsed.lastUsedProvider === "string" ? parsed.lastUsedProvider.trim() : "";
  if (!providerId) return {};

  const providers = isObj(parsed.providers) ? parsed.providers : null;
  const entry = providers && isObj(providers[providerId]) ? providers[providerId] : null;
  const settings = entry && isObj(entry.settings) ? entry.settings : null;
  const apiKey = settings && typeof settings.apiKey === "string" ? settings.apiKey.trim() : "";
  if (!apiKey) return {};

  return { CLINE_PROVIDER: providerId, CLINE_API_KEY: apiKey };
}

function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
