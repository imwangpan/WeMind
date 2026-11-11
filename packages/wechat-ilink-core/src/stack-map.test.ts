import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeError,
  loadOwnSourceMap,
  mapStackToSource,
  type StackSourceMap,
} from "./stack-map.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** 造一个临时「产物 + 同目录 .map」：mappings 让产物第 13 行映射到 src.ts 第 5 行。 */
function makeBundle(withMap: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-stack-"));
  dirs.push(dir);
  const bundle = path.join(dir, "fake.js");
  fs.writeFileSync(bundle, "// bundle\n");
  if (withMap) {
    fs.writeFileSync(
      `${bundle}.map`,
      JSON.stringify({
        version: 3,
        file: "fake.js",
        sources: ["src.ts"],
        sourcesContent: ["line1\n"],
        names: [],
        mappings: "AAAA;;;;;;;;;;;;AAIA",
      }),
    );
  }
  return pathToFileURL(bundle).href;
}

const fakeMap: StackSourceMap = {
  findOrigin: () => ({ fileName: "../src/cli/cli-dispatch.ts", lineNumber: 5 }),
};
const bundle = path.resolve("/x/dist/cli.js");

describe("mapStackToSource（纯函数）", () => {
  it("把本产物的帧换成 .ts 行号，去掉 dist 前缀与 ../", () => {
    const stack = `Error: boom\n    at cliHook (${pathToFileURL(bundle).href}:13:8)`;
    expect(mapStackToSource(stack, fakeMap, bundle)).toBe(
      "Error: boom\n    at cliHook (src/cli/cli-dispatch.ts:5)",
    );
  });

  it("裸文件名（无路径前缀）也能映射", () => {
    expect(mapStackToSource("    at f (cli.js:13:8)", fakeMap, bundle)).toBe(
      "    at f (src/cli/cli-dispatch.ts:5)",
    );
  });

  it("多帧：只改本产物，第三方、node_modules 同名文件与 Node 内部帧原样", () => {
    const stack = [
      "Error: boom",
      "    at a (/x/dist/cli.js:13:8)",
      "    at b (node:internal/modules/esm/module_job:561:25)",
      "    at c (/x/node_modules/foo/index.js:2:3)",
      "    at d (/x/dist/other.js:9:1)",
    ].join("\n");
    const out = mapStackToSource(stack, fakeMap, bundle);
    expect(out).toContain("at a (src/cli/cli-dispatch.ts:5)");
    expect(out).toContain("at b (node:internal/modules/esm/module_job:561:25)");
    expect(out).toContain("at c (/x/node_modules/foo/index.js:2:3)");
    expect(out).toContain("at d (/x/dist/other.js:9:1)");
  });

  it("安装路径含 node_modules 时仍按完整路径映射（npm / npx 主场景）", () => {
    const installed = path.resolve("/x/node_modules/@wemind/cli/dist/cli.js");
    expect(
      mapStackToSource(`    at f (${pathToFileURL(installed).href}:13:8)`, fakeMap, installed),
    ).toBe("    at f (src/cli/cli-dispatch.ts:5)");
  });

  it("同名的第三方 index.js（含 node_modules）不映射", () => {
    const mcp = path.resolve("/x/node_modules/@wemind/wechat-mcp/dist/index.js");
    const stack = "    at g (/x/node_modules/other/dist/index.js:13:8)";
    expect(mapStackToSource(stack, fakeMap, mcp)).toBe(stack);
  });

  it("map 为 null、stack 为空、路径不等于本产物都原样返回", () => {
    expect(mapStackToSource("at f (cli.js:13:8)", null, bundle)).toBe("at f (cli.js:13:8)");
    expect(mapStackToSource("", fakeMap, bundle)).toBe("");
    expect(mapStackToSource("at f (/x/lib/cli.js:13:8)", fakeMap, bundle)).toBe(
      "at f (/x/lib/cli.js:13:8)",
    );
  });

  it("findOrigin 查不到或抛错都原样返回，不影响主流程", () => {
    const empty: StackSourceMap = { findOrigin: () => ({}) };
    const broken: StackSourceMap = {
      findOrigin: () => {
        throw new Error("bad map");
      },
    };
    expect(mapStackToSource("at f (cli.js:13:8)", empty, bundle)).toBe("at f (cli.js:13:8)");
    expect(mapStackToSource("at f (cli.js:13:8)", broken, bundle)).toBe("at f (cli.js:13:8)");
  });
});

describe("loadOwnSourceMap / describeError（读同目录 .map）", () => {
  it("产物旁边有 .map 时自动映射，不需要任何环境变量", () => {
    const url = makeBundle(true);
    expect(loadOwnSourceMap(url)).not.toBeNull();
    const err = new Error("boom");
    err.stack = "Error: boom\n    at f (fake.js:13:8)";
    expect(describeError(err, url)).toBe("Error: boom\n    at f (src.ts:5)");
  });

  it("没有 .map（源码用 tsx 直跑、map 丢失）时原样返回", () => {
    const url = makeBundle(false);
    const err = new Error("boom");
    err.stack = "Error: boom\n    at f (fake.js:13:8)";
    expect(describeError(err, url)).toBe("Error: boom\n    at f (fake.js:13:8)");
  });

  it("非 Error 的 rejection 也原样变成字符串", () => {
    expect(describeError("plain failure", makeBundle(false))).toBe("plain failure");
  });
});
