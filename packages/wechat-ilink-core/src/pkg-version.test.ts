import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readOwnVersion } from "./pkg-version.js";

/** 搭一个临时「monorepo」目录树，模拟向上查找会撞到别的 package.json 的场景。 */
let tree = "";
const write = (rel: string, content: string) => {
  const p = path.join(tree, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
};
const url = (rel: string) => pathToFileURL(path.join(tree, rel)).href;

beforeAll(() => {
  tree = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-pkg-version-"));
  // 模拟仓库根（干扰项：没有 version）、core（干扰项：另一个包）、cli（目标）
  write("package.json", JSON.stringify({ name: "wemind-monorepo" }));
  write(
    "packages/wechat-ilink-core/package.json",
    JSON.stringify({ name: "@wemind/wechat-ilink-core", version: "9.9.9" }),
  );
  write(
    "packages/wechat-daemon/package.json",
    JSON.stringify({ name: "@wemind/cli", version: "1.2.3" }),
  );
  write("packages/wechat-daemon/src/version.ts", "// 调用方所在文件\n");
});

afterAll(() => {
  try {
    fs.rmSync(tree, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("readOwnVersion（从调用方位置向上查找自己的 package.json）", () => {
  it("dev 布局：src/ 下的调用方 → 命中自己包的 version（跳过 core 与仓库根的干扰项）", () => {
    expect(readOwnVersion(url("packages/wechat-daemon/src/version.ts"), "@wemind/cli")).toBe(
      "1.2.3",
    );
  });

  it("打包布局：dist/ 下的调用方 → 同样命中", () => {
    write("packages/wechat-daemon/dist/cli.js", "// 产物\n");
    expect(readOwnVersion(url("packages/wechat-daemon/dist/cli.js"), "@wemind/cli")).toBe("1.2.3");
  });

  it("name 不匹配时返回 undefined（绝不静默返回别人的版本）", () => {
    // 从 cli 的位置找 core 的名字 → 找不到（这正是「直接引用别人的 version.ts」会出错的场景）
    expect(
      readOwnVersion(url("packages/wechat-daemon/src/version.ts"), "@wemind/wechat-ilink-core"),
    ).toBeUndefined();
    expect(
      readOwnVersion(url("packages/wechat-daemon/src/version.ts"), "@wemind/wechat-mcp"),
    ).toBeUndefined();
  });

  it("向上只经过祖先目录：兄弟包永远不会被误认", () => {
    // 从 core 自己的位置：先撞到 core 的 9.9.9（name 匹配自己 → 返回它）
    expect(
      readOwnVersion(url("packages/wechat-ilink-core/src/index.ts"), "@wemind/wechat-ilink-core"),
    ).toBe("9.9.9");
    // 找 cli 的名字 → cli 是**兄弟**目录，不在 core 的祖先链上，永远找不到 → undefined
    expect(
      readOwnVersion(url("packages/wechat-ilink-core/src/index.ts"), "@wemind/cli"),
    ).toBeUndefined();
  });

  it("找不到任何匹配 → undefined；非法 URL / 空参数 → undefined（安全失败）", () => {
    write("lonely/src/index.ts", "//\n");
    expect(readOwnVersion(url("lonely/src/index.ts"), "@wemind/cli")).toBeUndefined();
    expect(readOwnVersion("https://example.com/not-a-file.ts", "@wemind/cli")).toBeUndefined();
    expect(readOwnVersion("", "@wemind/cli")).toBeUndefined();
    expect(readOwnVersion(url("packages/wechat-daemon/src/version.ts"), "")).toBeUndefined();
  });

  it("真实模块冒烟：用本测试文件的 import.meta.url 找 core 自己", () => {
    // vitest 下 import.meta.url 指向 src/*.test.ts；向上第一站就是 core 的 package.json
    const corePkg = JSON.parse(
      fs.readFileSync(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../package.json"),
        "utf-8",
      ),
    ) as { name: string; version: string };
    expect(readOwnVersion(import.meta.url, corePkg.name)).toBe(corePkg.version);
  });
});
