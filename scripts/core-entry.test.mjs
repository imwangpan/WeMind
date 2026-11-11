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

  it("两个发布包都开 sourcemap（.map 随包由 prepack 守卫检查）", () => {
    for (const rel of [
      "packages/wechat-daemon/tsdown.config.ts",
      "packages/wechat-mcp/tsdown.config.ts",
    ]) {
      expect(readText(rel)).toMatch(/sourcemap:\s*true/);
    }
  });

  it("CLI / daemon / MCP 的错误出口都走 describeError（日志自动带 .ts 行号）", () => {
    const cli = readText("packages/wechat-daemon/src/cli.ts");
    expect(cli.match(/describeError\(/g)?.length).toBeGreaterThanOrEqual(3);
    // 管理命令的 fatal 出口用 log.child("cli")：前缀与级别由 logger 生成，调用点不再自带前缀，也不能退回裸 console.error。
    expect(cli).toContain('const cliLog = log.child("cli")');
    expect(cli).toContain("cliLog.error(describeError(e, import.meta.url))");
    expect(cli).not.toContain('console.error("error:"');
    expect(readText("packages/wechat-daemon/src/index.ts")).toContain(
      'process.on("unhandledRejection"',
    );
    expect(readText("packages/wechat-daemon/src/index.ts")).toContain("describeError(");
    expect(readText("packages/wechat-mcp/src/index.ts")).toContain("describeError(");
  });

  it("daemon 业务循环与 MCP 全局兜底也用 describeError（日志行号可读）", () => {
    const daemon = readText("packages/wechat-daemon/src/index.ts");
    const mcp = readText("packages/wechat-mcp/src/index.ts");
    for (const label of [
      "save state failed:",
      "poller error:",
      "fast command error:",
      "handleMessage error:",
    ]) {
      expect(daemon).toContain(`log.error("${label}", describeError(`);
    }
    expect(mcp).toContain('process.on("unhandledRejection"');
    expect(mcp).toContain('process.on("uncaughtException"');
    expect(mcp).toContain("describeError(reason, import.meta.url)");
  });

  it("根脚本不再预构建 core", () => {
    const root = readJson("package.json");
    expect(root.scripts.build).not.toContain("build -w @wemind/wechat-ilink-core");
    expect(root.scripts.typecheck).not.toContain("build -w @wemind/wechat-ilink-core");
    expect(root.scripts.build).toContain("typecheck -w @wemind/wechat-ilink-core");
  });
});
