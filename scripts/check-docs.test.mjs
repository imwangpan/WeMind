import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { checkDocs } from "./check-docs.mjs";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-docs.mjs");
const roots = [];

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-docs-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
}

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe("check-docs", () => {
  it("相对链接存在时通过，http/锚点不计数", () => {
    const root = fixture({
      "a.md": '[ok](b.md)\n[anchor](#x)\n[http](https://example.com)\n[title](b.md "T")\n',
      "b.md": "# b\n",
    });
    expect(checkDocs({ root })).toMatchObject({ checked: 2, files: 2, broken: [] });
    const result = run(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("checked 2 relative links in 2 markdown files");
    expect(result.stdout).toContain("OK: no broken relative links");
  });

  it("断链报出文件、行号与目标，并以 1 退出", () => {
    const root = fixture({ "a.md": "# a\n\n[bad](missing.md)\n" });
    expect(checkDocs({ root }).broken).toEqual([{ file: "a.md", line: 3, target: "missing.md" }]);
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("BROKEN: 1");
    expect(result.stdout).toContain("a.md:3  missing.md");
  });

  it("跳过代码围栏与行内代码，去掉 title 与 #锚点", () => {
    const root = fixture({
      "a.md": [
        "```md",
        "[fenced](nope.md)",
        "```",
        "`[inline](nope2.md)`",
        '[ok](b.md#anchor "t")',
        "",
      ].join("\n"),
      "b.md": "",
    });
    expect(checkDocs({ root })).toMatchObject({ checked: 1, broken: [] });
  });

  it("跳过 .worktrees/.agents/node_modules/dist 下的副本", () => {
    const root = fixture({
      "a.md": "[ok](b.md)\n",
      "b.md": "",
      ".worktrees/w/x.md": "[bad](missing.md)\n",
      ".agents/a/x.md": "[bad](missing.md)\n",
      "node_modules/n.md": "[bad](missing.md)\n",
      "pkg/dist/d.md": "[bad](missing.md)\n",
    });
    expect(checkDocs({ root })).toMatchObject({ checked: 1, files: 2, broken: [] });
    expect(run(root).status).toBe(0);
  });
});
