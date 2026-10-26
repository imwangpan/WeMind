import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CLI_VERSION, versionLine } from "./version.js";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("CLI 版本号", () => {
  it("version.ts 的 CLI_VERSION 与 package.json 的 version 一致", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf-8")) as {
      version: string;
      name: string;
    };
    expect(CLI_VERSION).toBe(pkg.version);
  });

  it("versionLine 带上包名与当前 node 版本", () => {
    const line = versionLine();
    expect(line.startsWith(`wemind ${CLI_VERSION}`)).toBe(true);
    expect(line).toContain(process.versions.node);
  });
});
