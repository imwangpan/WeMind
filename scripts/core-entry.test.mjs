import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("..", import.meta.url));

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(REPO, rel), "utf8"));
}

function readText(rel) {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

describe("core 是 JIT 源码包（source-first）", () => {
  const core = readJson("packages/wechat-ilink-core/package.json");

  it("入口指向 src，不存在 dist 入口", () => {
    expect(core.main).toBe("./src/index.ts");
    expect(core.types).toBe("./src/index.ts");
    expect(core.exports["."].types).toBe("./src/index.ts");
    expect(core.exports["."].default).toBe("./src/index.ts");
  });

  it("没有 build 脚本、files 不包含 dist", () => {
    expect(core.scripts?.build).toBeUndefined();
    expect(core.files ?? []).not.toContain("dist");
  });

  it("工作区里没有遗留的 core/dist", () => {
    expect(
      fs.existsSync(path.join(REPO, "packages/wechat-ilink-core/dist")),
      "core 是 JIT 源码包，不应存在 dist；请删除 packages/wechat-ilink-core/dist",
    ).toBe(false);
  });

  it("消费方 typecheck 不 emit", () => {
    expect(readJson("packages/wechat-daemon/tsconfig.json").compilerOptions.noEmit).toBe(true);
    expect(readJson("packages/wechat-mcp/tsconfig.json").compilerOptions.noEmit).toBe(true);
  });

  it("两个发布包都把 core 内联", () => {
    for (const rel of [
      "packages/wechat-daemon/tsdown.config.ts",
      "packages/wechat-mcp/tsdown.config.ts",
    ]) {
      expect(readText(rel)).toMatch(
        /alwaysBundle:\s*\[[^\]]*["']@wemind\/wechat-ilink-core["']/s,
      );
    }
  });

  it("根脚本不再预构建 core", () => {
    const root = readJson("package.json");
    expect(root.scripts.build).not.toContain("build -w @wemind/wechat-ilink-core");
    expect(root.scripts.typecheck).not.toContain("build -w @wemind/wechat-ilink-core");
    expect(root.scripts.build).toContain("typecheck -w @wemind/wechat-ilink-core");
  });
});
