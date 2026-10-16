import { describe, it, expect, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadBrainConfig,
  saveBrainConfig,
  clearBrainConfig,
  brainConfigPath,
} from "./brain-config.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-brain-config-"));

afterEach(() => {
  fs.rmSync(brainConfigPath(dir), { force: true });
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("brain.json 读写", () => {
  it("无文件 → null", () => {
    expect(loadBrainConfig(dir)).toBeNull();
  });

  it("save → read 往返（agent 单字段）", () => {
    saveBrainConfig({ agent: "opencode" }, dir);
    expect(loadBrainConfig(dir)).toEqual({ agent: "opencode" });
  });

  it("支持 bin / args / shell / homeEnvVar，且 args 容忍字符串", () => {
    saveBrainConfig(
      {
        agent: "acme",
        bin: "/x/acme",
        args: ["serve", "--acp"],
        shell: true,
        homeEnvVar: "ACME_HOME",
      },
      dir,
    );
    expect(loadBrainConfig(dir)).toEqual({
      agent: "acme",
      bin: "/x/acme",
      args: ["serve", "--acp"],
      shell: true,
      homeEnvVar: "ACME_HOME",
    });
    fs.writeFileSync(brainConfigPath(dir), JSON.stringify({ agent: "acme", args: "serve --acp" }));
    expect(loadBrainConfig(dir)?.args).toEqual(["serve", "--acp"]);
  });

  it("损坏 / 缺 agent → null（不抛）", () => {
    fs.writeFileSync(brainConfigPath(dir), "{ not json");
    expect(loadBrainConfig(dir)).toBeNull();
    fs.writeFileSync(brainConfigPath(dir), JSON.stringify({ bin: "x" }));
    expect(loadBrainConfig(dir)).toBeNull();
    fs.writeFileSync(brainConfigPath(dir), JSON.stringify({ agent: "   " }));
    expect(loadBrainConfig(dir)).toBeNull();
  });

  it("clear 删除配置；重复 clear 返回 false", () => {
    saveBrainConfig({ agent: "kiro" }, dir);
    expect(clearBrainConfig(dir)).toBe(true);
    expect(clearBrainConfig(dir)).toBe(false);
    expect(loadBrainConfig(dir)).toBeNull();
  });
});
