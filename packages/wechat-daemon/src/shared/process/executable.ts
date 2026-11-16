import fs from "node:fs";
import path from "node:path";

/**
 * 可执行文件解析。
 *
 * Windows 上 Node 的 `spawn("npm", …)` 不会补 `.cmd`（只补 `.exe`），而 npm 全局安装的 ACP
 * 适配器通常是 `.cmd`。这里统一按 PATH + PATHEXT 解析，供 brain 与探针共用。
 */
export type ExecutableOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
};

function pathEntries(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATH ?? env.Path ?? "";
  return raw.split(platform === "win32" ? ";" : path.delimiter).filter(Boolean);
}

function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATHEXT?.trim() || ".COM;.EXE;.BAT;.CMD";
  return raw
    .split(";")
    .map((x) => x.trim().toLowerCase())
    .filter((x) => /^\.[a-z0-9]+$/.test(x));
}

/** 在 PATH 上查找一个精确文件名；不解释 PATHEXT。 */
export function findOnPath(exe: string, opts: ExecutableOptions = {}): string | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  for (const dir of pathEntries(platform, env)) {
    const candidate = path.join(dir, exe);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* 继续找 */
    }
  }
  return null;
}

/** 同 findOnPath，但按平台补齐扩展名（Windows 上 npm shim 多为 .cmd）。 */
export function findOnPathAny(exe: string, opts: ExecutableOptions = {}): string | null {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return findOnPath(exe, opts);
  const env = opts.env ?? process.env;
  const clean = exe.trim().replace(/^["']+|["']+$/g, "");
  if (path.win32.extname(clean)) return findOnPath(clean, opts);
  for (const ext of windowsExtensions(env)) {
    const hit = findOnPath(`${clean}${ext}`, opts);
    if (hit) return hit;
  }
  return findOnPath(clean, opts);
}

/**
 * 解析裸名、绝对/相对路径。裸名按 PATH + PATHEXT；路径按原样检查，Windows 无扩展名时再补
 * PATHEXT。只返回实际存在的文件。
 */
export function locateExecutable(bin: string, opts: ExecutableOptions = {}): string | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const clean = bin.trim().replace(/^["']+|["']+$/g, "");
  if (!clean) return null;
  const hasSeparator = clean.includes("/") || clean.includes("\\");
  if (!hasSeparator) return findOnPathAny(clean, opts);

  const resolved = path.resolve(clean);
  try {
    if (fs.statSync(resolved).isFile()) return resolved;
  } catch {
    /* Windows 无扩展名路径继续补扩展名 */
  }
  if (platform !== "win32" || path.win32.extname(resolved)) return null;
  for (const ext of windowsExtensions(env)) {
    try {
      const candidate = `${resolved}${ext}`;
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* 继续找 */
    }
  }
  return null;
}

/** 该文件是否必须经 shell 启动（Windows `.cmd` / `.bat`）。 */
export function isShellScriptPath(
  file: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") return false;
  return [".cmd", ".bat"].includes(path.win32.extname(file).toLowerCase());
}
