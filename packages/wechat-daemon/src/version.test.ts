import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CLI_PKG_NAME, CLI_VERSION, versionLine } from "./version.js";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
    const src = fs.readFileSync(path.join(pkgDir, "src", "version.ts"), "utf-8");
    expect(src).not.toMatch(/export const CLI_VERSION\s*=\s*["']\d+\.\d+\.\d+/);
  });

  it("CLI_PKG_NAME 与 package.json 的 name 一致", () => {
    expect(CLI_PKG_NAME).toBe(pkg.name);
  });

  it("包名与命令名解耦：包名是 @wemind/cli，bin 仍叫 wemind", () => {
    // 发布到 @wemind scope 下，但用户敲的命令仍是 wemind；两者不一致是**有意**的，
    // 这条断言防止有人「顺手」把 bin 也改成 @wemind/cli。
    expect(pkg.name).toBe("@wemind/cli");
    expect(Object.keys(pkg.bin)).toEqual(["wemind"]);
  });

  it("versionLine 带上命令名、包名与当前 node 版本", () => {
    const line = versionLine();
    expect(line.startsWith(`wemind ${CLI_VERSION}`)).toBe(true);
    expect(line).toContain(CLI_PKG_NAME);
    expect(line).toContain(process.versions.node);
  });
});
