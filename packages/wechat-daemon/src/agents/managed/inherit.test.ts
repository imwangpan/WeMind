import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ResolvedAgent } from "../brain-agents.js";
import { syncInherited } from "./inherit.js";

/*
 * 共用副本根（kiro / deepseek / pi 的 configSubdir 都为空）：换 agent 后必须换成新 agent 的 skills/AGENTS.md，
 * 不能继续读上一个 agent 的。真实配置目录永远不动。
 */
const fake = (
  name: string,
  realHome: string,
  inheritDirs: string[],
  inheritFiles: string[],
): ResolvedAgent => ({ name, realHome, inherit: true, inheritDirs, inheritFiles }) as ResolvedAgent;

let root = "";
let cfg = "";
let homeA = "";
let homeB = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-inherit-"));
  cfg = path.join(root, "brain-home");
  homeA = path.join(root, "real-a");
  homeB = path.join(root, "real-b");
  for (const [home, tag] of [
    [homeA, "A"],
    [homeB, "B"],
  ] as const) {
    fs.mkdirSync(path.join(home, "skills"), { recursive: true });
    fs.writeFileSync(path.join(home, "skills", "s.md"), `${tag}-skills`);
    fs.writeFileSync(path.join(home, "AGENTS.md"), tag);
  }
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("syncInherited（共用副本根的继承）", () => {
  it("换 agent：同名 skills 链接与 AGENTS.md 换成新 agent 的", () => {
    syncInherited(root, cfg, fake("deepseek", homeA, ["skills"], ["AGENTS.md"]));
    expect(fs.readFileSync(path.join(cfg, "AGENTS.md"), "utf-8")).toBe("A");
    expect(fs.readFileSync(path.join(cfg, "skills", "s.md"), "utf-8")).toBe("A-skills");

    syncInherited(root, cfg, fake("pi", homeB, ["skills"], ["AGENTS.md"]));
    expect(fs.readFileSync(path.join(cfg, "AGENTS.md"), "utf-8")).toBe("B");
    expect(fs.readFileSync(path.join(cfg, "skills", "s.md"), "utf-8")).toBe("B-skills");
  });

  it("新 agent 不要的条目清掉（只删链接/拷贝，真实目录不动）", () => {
    syncInherited(root, cfg, fake("deepseek", homeA, ["skills"], ["AGENTS.md"]));
    syncInherited(root, cfg, fake("kiro", homeB, ["steering"], []));

    expect(fs.existsSync(path.join(cfg, "AGENTS.md"))).toBe(false);
    expect(fs.existsSync(path.join(cfg, "skills"))).toBe(false);
    expect(fs.readFileSync(path.join(homeA, "skills", "s.md"), "utf-8")).toBe("A-skills");
  });

  it("同一 agent 重跑不覆盖副本里的单文件记忆（保留 agent 自己写的）", () => {
    syncInherited(root, cfg, fake("deepseek", homeA, [], ["AGENTS.md"]));
    fs.writeFileSync(path.join(cfg, "AGENTS.md"), "copy-edit");
    syncInherited(root, cfg, fake("deepseek", homeA, [], ["AGENTS.md"]));
    expect(fs.readFileSync(path.join(cfg, "AGENTS.md"), "utf-8")).toBe("copy-edit");
  });

  it("无 symlink 权限时告警且不抛异常（副本漂移可见）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const symlink = vi.spyOn(fs, "symlinkSync").mockImplementation(() => {
      throw new Error("EPERM: operation not permitted");
    });
    try {
      expect(() =>
        syncInherited(root, cfg, fake("pi", homeA, ["skills"], ["AGENTS.md"])),
      ).not.toThrow();
      expect(warn).toHaveBeenCalled();
      expect(fs.readFileSync(path.join(cfg, "AGENTS.md"), "utf-8")).toBe("A");
    } finally {
      symlink.mockRestore();
      warn.mockRestore();
    }
  });

  it("清单里的 ../ 与绝对路径被过滤（不删副本目录外的文件）", () => {
    fs.mkdirSync(cfg, { recursive: true });
    const outside = path.join(root, "outside.txt");
    fs.writeFileSync(outside, "keep", "utf-8");
    const inside = path.join(cfg, "inside.txt");
    fs.writeFileSync(inside, "drop-me", "utf-8");
    fs.writeFileSync(
      path.join(cfg, ".wemind-inherited.json"),
      JSON.stringify({
        agent: "old",
        dirs: ["../outside-dir"],
        files: ["../outside.txt", outside, "inside.txt"],
      }),
      "utf-8",
    );
    syncInherited(root, cfg, fake("pi", homeB, [], []));
    expect(fs.readFileSync(outside, "utf-8")).toBe("keep");
    expect(fs.existsSync(inside)).toBe(false);
  });
});
