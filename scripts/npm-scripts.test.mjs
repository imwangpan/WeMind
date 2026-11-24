/**
 * npm 脚本自身的守卫：一条检查只能有一个入口，组合脚本只做组合。
 *
 * 为什么需要：2026-11 之前 `verify` 把 11 步串在一起，CI 又把其中 9 步抄了一遍，
 * 两边顺序不同、调用方式不同，还留了一个 `shell: pwsh` 跑 Node 脚本的残留。
 * 这些断言把「谁是唯一入口」「CI 必须调 verify」固定下来，改动时先失败再讨论。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const pkg = JSON.parse(read("package.json"));
const scripts = pkg.scripts;

/** 取出脚本里所有 `npm run <名字>` 的引用（`npm run --silent x` 也算）。 */
function referenced(script) {
  return [...script.matchAll(/npm run (?:--silent )?([a-z][a-z:-]*)/g)].map((m) => m[1]);
}

const guards = [
  "check:version",
  "check:user-copy",
  "check:agent-docs",
  "check:tables",
  "check:impact",
  "check:links",
];

describe("npm 脚本：一个入口一个职责", () => {
  it("verify 只做组合：publish → code → docs", () => {
    expect(scripts.verify).toBe(
      "npm run verify:publish && npm run verify:code && npm run verify:docs",
    );
  });

  it("每条检查恰好属于一个 verify 分组，且预提交的快速检查是其子集", () => {
    const owners = ["verify:publish", "verify:code", "verify:docs"];
    for (const guard of guards) {
      const holders = owners.filter((owner) => referenced(scripts[owner]).includes(guard));
      expect(holders, `${guard} 应恰好被一个 verify 分组引用`).toHaveLength(1);
    }
    expect(referenced(scripts["verify:publish"])).toContain("check:version");
    expect(referenced(scripts["verify:docs"])).toEqual(
      expect.arrayContaining(["check:user-copy", "check:agent-docs", "check:tables"]),
    );
    const hookOnly = referenced(scripts["hook:check"]);
    expect(hookOnly).toEqual(
      expect.arrayContaining(["format:check", "check:user-copy", "check:agent-docs"]),
    );
    const full = owners.flatMap((owner) => referenced(scripts[owner]));
    for (const name of hookOnly) expect(full, `hook:check 多跑了一个检查：${name}`).toContain(name);
  });

  it("分组脚本不内联脚本路径，只调 npm 别名", () => {
    for (const owner of ["verify:publish", "verify:code", "verify:docs", "hook:check"]) {
      // hook:check 里的 `--staged` 是 check:impact 没有的用法，单独豁免这一处。
      const text = scripts[owner].replace(/node scripts\/doc-impact\.mjs --check --staged/, "");
      expect(text, owner).not.toMatch(/node scripts\//);
    }
  });

  it("分组脚本引用的别名都存在", () => {
    for (const owner of ["verify", "verify:publish", "verify:code", "verify:docs", "hook:check"]) {
      for (const name of referenced(scripts[owner])) {
        expect(scripts[name], `${owner} 引用了不存在的 ${name}`).toBeTypeOf("string");
      }
    }
  });

  it("format 与 format:check 的范围完全一致", () => {
    expect(scripts["format:check"]).toBe(`${scripts.format} --check`);
  });

  it("三个子包的 typecheck 只有一种写法，core 的测试参与类型检查", () => {
    for (const name of ["wechat-ilink-core", "wechat-daemon", "wechat-mcp"]) {
      const sub = JSON.parse(read("packages", name, "package.json"));
      expect(sub.scripts.typecheck, name).toBe("tsc -p tsconfig.json");
    }
    const coreTsconfig = JSON.parse(read("packages", "wechat-ilink-core", "tsconfig.json"));
    expect(coreTsconfig.compilerOptions.noEmit).toBe(true);
    expect(coreTsconfig.exclude ?? []).not.toContain("src/**/*.test.ts");
  });
});

describe("子包命令", () => {
  const packages = ["wechat-ilink-core", "wechat-daemon", "wechat-mcp"];
  const sub = (name) => JSON.parse(read("packages", name, "package.json")).scripts;

  it("三个包的 test 各指向自己，并带回仓库根需要的 --root / --config", () => {
    for (const name of packages) {
      // 两个旗标缺一不可：vitest 把 cwd 当 root，include/setupFiles 都相对 root 解析。
      expect(sub(name).test, name).toBe(
        `vitest run --root ../.. --config ../../vitest.config.ts packages/${name}`,
      );
      expect(sub(name)["test:watch"], name).toBe(
        `vitest --root ../.. --config ../../vitest.config.ts packages/${name}`,
      );
    }
    expect(scripts.test).toBe("vitest run");
  });

  it("daemon 的 start 走带单实例守卫的 start，不是裸 daemon", () => {
    expect(sub("wechat-daemon").start).toBe("node dist/cli.js start");
  });

  it("从 dist 启动的两个包，start 前会先 build", () => {
    for (const name of ["wechat-daemon", "wechat-mcp"]) {
      expect(sub(name).prestart, name).toBe("npm run build");
    }
  });

  it("daemon 的 dev 从源码跑，且不提供 watch（重启会打断长轮询）", () => {
    expect(sub("wechat-daemon").dev).toBe("tsx src/cli.ts");
    expect(sub("wechat-daemon")["dev:watch"]).toBeUndefined();
  });
});

describe("CI / 钩子复用同一套脚本", () => {
  const ci = read(".github", "workflows", "ci.yml");
  const buildTest = ci.split("\n  build-test:")[1] ?? "";

  it("build-test 不再抄步骤，直接跑 verify", () => {
    expect(buildTest).toContain("npm run verify");
    for (const step of ["npm run lint", "npm run typecheck", "npm run build", "npm test"]) {
      expect(buildTest, `build-test 不应再单独跑 ${step}`).not.toContain(step);
    }
  });

  it("build-test 保留 doc-impact 需要的完整历史", () => {
    expect(buildTest).toContain("fetch-depth: 0");
  });

  it("工作流里没有 PowerShell 残留", () => {
    for (const file of fs.readdirSync(path.join(root, ".github", "workflows"))) {
      expect(read(".github", "workflows", file), file).not.toContain("shell: pwsh");
    }
  });

  it("发布工作流跑组合脚本，而不是逐条列检查", () => {
    for (const file of ["wemind-publish.yml", "wechat-mcp-publish.yml"]) {
      const text = read(".github", "workflows", file);
      expect(text, file).toContain("npm run verify:publish && npm run verify:code");
      expect(text, file).not.toContain("npm run typecheck");
    }
  });

  it("pre-commit 只调 hook:check", () => {
    const hook = read(".githooks", "pre-commit");
    expect(hook).toContain("npm run --silent hook:check");
    expect(hook).not.toContain("node scripts/");
  });
});
