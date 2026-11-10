import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const GUARD = fileURLToPath(new URL("./prepack-guard.mjs", import.meta.url));
const dirs = [];

/** 造一个最小可打包目录：package.json + dist/cli.js（可带额外产物）。 */
function makePkg({ js = '#!/usr/bin/env node\nconsole.log("ok");\n', extraFiles = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-prepack-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dist", "cli.js"), js);
  for (const [name, content] of Object.entries(extraFiles)) {
    fs.writeFileSync(path.join(dir, "dist", name), content);
  }
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "fixture-pkg",
        version: "0.0.0",
        files: ["dist"],
        bin: { wemind: "dist/cli.js" },
      },
      null,
      2,
    ),
  );
  return dir;
}

function runGuard(dir) {
  return spawnSync(process.execPath, [GUARD, dir], { encoding: "utf8" });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("prepack-guard：产物自包含", () => {
  it("自包含产物通过", () => {
    const r = runGuard(makePkg());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("产物齐全");
  });

  it("拒绝静态 import 工作区包", () => {
    const r = runGuard(
      makePkg({ js: '#!/usr/bin/env node\nimport { x } from "@wemind/wechat-ilink-core";\n' }),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("@wemind/wechat-ilink-core");
  });

  it("拒绝 export ... from 工作区包", () => {
    const r = runGuard(
      makePkg({ js: '#!/usr/bin/env node\nexport { x } from "@wemind/wechat-ilink-core";\n' }),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("@wemind/wechat-ilink-core");
  });

  it("拒绝动态 import 工作区包", () => {
    const r = runGuard(
      makePkg({ js: '#!/usr/bin/env node\nimport("@wemind/wechat-mcp").then(() => {});\n' }),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("@wemind/wechat-mcp");
  });

  it("拒绝 require 工作区包", () => {
    const r = runGuard(
      makePkg({ js: '#!/usr/bin/env node\nconst x = require("@wemind/wechat-ilink-core");\n' }),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("@wemind/wechat-ilink-core");
  });

  it("不扫 .map：只有 sourcemap 的 sourcesContent 出现包名时放行", () => {
    const r = runGuard(
      makePkg({
        extraFiles: {
          "cli.js.map": JSON.stringify({
            sourcesContent: ['import { x } from "@wemind/wechat-ilink-core";'],
          }),
        },
      }),
    );
    expect(r.status).toBe(0);
  });

  it("空 dist 仍然失败", () => {
    const dir = makePkg();
    fs.rmSync(path.join(dir, "dist"), { recursive: true, force: true });
    const r = runGuard(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("files 条目不存在或为空");
  });

  it("bin 缺少 shebang 仍然失败", () => {
    const r = runGuard(makePkg({ js: 'console.log("no shebang");\n' }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("shebang");
  });
});
