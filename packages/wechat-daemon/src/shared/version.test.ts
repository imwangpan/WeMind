import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CLI_PKG_NAME, CLI_VERSION, versionLine } from "./version.js";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf-8")) as {
  name: string;
  version: string;
  bin: Record<string, string>;
};

describe("CLI 版本号与包身份", () => {
  it("CLI_VERSION 来自 package.json 的 version（版本号只有一处来源）", () => {
    // version.ts 不再硬编码版本号，而是运行时从 package.json 读。
    // 这条断言就是那个契约：npm version 改 package.json 后，这里自动跟着变。
    expect(CLI_VERSION).toBe(pkg.version);
    expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("源文件里不再出现硬编码的版本号字面量", () => {
    // 防止有人「顺手」把 CLI_VERSION 改回 `= "1.2.3"`：那样版本号又会分裂成两处。
    const src = fs.readFileSync(path.join(pkgDir, "src", "shared", "version.ts"), "utf-8");
    expect(src).not.toMatch(/export const CLI_VERSION\s*=\s*["']\d+\.\d+\.\d+/);
  });

  it("CLI_PKG_NAME 与 package.json 的 name 一致", () => {
    expect(CLI_PKG_NAME).toBe(pkg.name);
  });

  it("包名与命令名解耦：包名是 @wemind/cli，bin 仍叫 wemind", () => {
    // 发布到 @wemind scope 下，但用户敲的命令仍是 wemind；两者不一致是**有意**的，
    // 这条断言防止有人「顺手」把 bin 也改成 @wemind/cli。
    expect(pkg.name).toBe("@wemind/cli");
    expect(pkg.bin.wemind).toBe("dist/cli.js");
  });

  it("只有一个 bin：npx 按包名推断可执行文件，多挂一个就会让它失败", () => {
    // npm 的 bin 推断（libnpmexec/lib/get-bin-from-manifest.js）：bin 不止一个不同目标时，
    // 只认「包名去掉 scope」（@wemind/cli → cli），凑不上就报 could not determine executable to run，
    // npx -y @wemind/cli 直接坏掉。
    expect(Object.keys(pkg.bin)).toEqual(["wemind"]);
    expect(pkg.bin.wemind).toBe("dist/cli.js");
  });

  it("versionLine 带上命令名、包名与当前运行时", () => {
    const line = versionLine();
    expect(line.startsWith(`wemind ${CLI_VERSION}`)).toBe(true);
    expect(line).toContain(CLI_PKG_NAME);
    // Bun 会把 process.versions.node 伪装成兼容版本号（1.4.4 报 26.3.0），所以按真实运行时断言。
    const runtime = (process.versions as { bun?: string }).bun;
    expect(line).toContain(runtime ? `bun ${runtime}` : `node ${process.versions.node}`);
  });
});
