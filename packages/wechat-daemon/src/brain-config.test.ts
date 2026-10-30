import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  agentConfigFor,
  clearBrainConfig,
  loadBrainConfig,
  mergeBrainConfig,
  saveBrainConfig,
  updateBrainConfig,
  type BrainConfig,
} from "./brain-config.js";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-braincfg-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (j: unknown): void =>
  fs.writeFileSync(path.join(dir, "brain.json"), JSON.stringify(j), "utf-8");

describe("loadBrainConfig（宽松归一化）", () => {
  it("缺失 / 损坏 / 无 agent 一律 null", () => {
    expect(loadBrainConfig(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, "brain.json"), "{ not json", "utf-8");
    expect(loadBrainConfig(dir)).toBeNull();
    write({ bin: "x" });
    expect(loadBrainConfig(dir)).toBeNull();
    write([1, 2]);
    expect(loadBrainConfig(dir)).toBeNull();
  });

  it("顶层字段 + worker 段 + presets 段都能读出来（args 字符串按空格切）", () => {
    write({
      agent: "opencode",
      args: "acp --verbose",
      model: "auto",
      worker: { agent: "Qoder", bin: "C:\\x\\qodercli.exe", shell: true },
      presets: {
        deepseek: { bin: " C:\\dsh\\dsh.cmd ", model: ' ["deepseek-account","deepseek-flash"] ' },
      },
    });
    const cfg = loadBrainConfig(dir)!;
    expect(cfg.agent).toBe("opencode");
    expect(cfg.args).toEqual(["acp", "--verbose"]);
    expect(cfg.model).toBe("auto");
    expect(cfg.worker).toEqual({ agent: "Qoder", bin: "C:\\x\\qodercli.exe", shell: true });
    expect(cfg.presets).toEqual({
      deepseek: { bin: "C:\\dsh\\dsh.cmd", model: '["deepseek-account","deepseek-flash"]' },
    });
  });

  it("extraArgs 字符串按空格切；数组原样保留", () => {
    write({ agent: "kiro", extraArgs: "--foo --bar" });
    expect(loadBrainConfig(dir)!.extraArgs).toEqual(["--foo", "--bar"]);
    write({ agent: "kiro", extraArgs: ["--a", "--b"] });
    expect(loadBrainConfig(dir)!.extraArgs).toEqual(["--a", "--b"]);
  });

  it("worker 段缺 agent（只有 bin）视为无效，不写进配置", () => {
    write({ agent: "kiro", worker: { bin: "x" } });
    expect(loadBrainConfig(dir)!.worker).toBeUndefined();
  });
});

describe("agentConfigFor（角色回退）", () => {
  const top: BrainConfig = { agent: "kiro", bin: "k.cmd" };
  it("未设 worker → 回落到顶层（拆分角色之前的行为）", () => {
    expect(agentConfigFor(top, "brain")).toBe(top);
    expect(agentConfigFor(top, "worker")).toBe(top);
  });
  it("设了 worker → 用 worker 段", () => {
    const cfg: BrainConfig = { ...top, worker: { agent: "opencode" } };
    expect(agentConfigFor(cfg, "worker")).toEqual({ agent: "opencode" });
    expect(agentConfigFor(cfg, "brain")).toBe(cfg);
  });
  it("null → null", () => {
    expect(agentConfigFor(null, "worker")).toBeNull();
  });
});

describe("mergeBrainConfig（读-改-写，不丢段）", () => {
  it("设顶层 agent 时保留已有 worker 段（旧实现整体覆盖写会把它删掉）", () => {
    const existing: BrainConfig = { agent: "kiro", worker: { agent: "opencode" } };
    const next = mergeBrainConfig(existing, { agent: "qoder" });
    expect(next.agent).toBe("qoder");
    expect(next.worker).toEqual({ agent: "opencode" });
  });

  it("patch 自带 worker 段时以 patch 为准", () => {
    const existing: BrainConfig = { agent: "kiro", worker: { agent: "opencode" } };
    const next = mergeBrainConfig(existing, { agent: "kiro", worker: { agent: "gemini" } });
    expect(next.worker).toEqual({ agent: "gemini" });
  });

  it("换 agent 时，旧 agent 的顶层启动覆盖迁进 presets[旧 agent]（切回去不丢 --bin）", () => {
    const existing: BrainConfig = {
      agent: "deepseek",
      bin: "C:\\dsh\\dsh.cmd",
      args: ["--profile", "acp"],
    };
    const next = mergeBrainConfig(existing, { agent: "opencode" });
    expect(next.bin).toBeUndefined();
    expect(next.presets).toEqual({
      deepseek: { bin: "C:\\dsh\\dsh.cmd", args: ["--profile", "acp"] },
    });
  });

  it("patch 带启动覆盖时同时写 presets[新 agent] 与顶层（顶层供旧版本 CLI 读取）", () => {
    const next = mergeBrainConfig(null, {
      agent: "DeepSeek",
      bin: "C:\\dsh\\dsh.cmd",
      shell: false,
    });
    expect(next.agent).toBe("DeepSeek");
    expect(next.bin).toBe("C:\\dsh\\dsh.cmd");
    expect(next.shell).toBe(false);
    expect(next.presets).toEqual({ deepseek: { bin: "C:\\dsh\\dsh.cmd", shell: false } });
  });

  it("同一个 agent 上再设一次：presets 里合并而不是丢字段", () => {
    const existing: BrainConfig = {
      agent: "deepseek",
      presets: { deepseek: { bin: "old.cmd", args: ["a"] } },
    };
    const next = mergeBrainConfig(existing, { agent: "deepseek", bin: "new.cmd" });
    expect(next.presets!.deepseek).toEqual({ bin: "new.cmd", args: ["a"] });
  });

  it("同一个 agent 上只改一半（未给的覆盖沿用原值，不丢 --bin）", () => {
    const existing: BrainConfig = {
      agent: "deepseek",
      bin: "C:\\dsh\\dsh.cmd",
      args: ["--profile", "acp"],
    };
    const next = mergeBrainConfig(existing, { agent: "deepseek" });
    expect(next.bin).toBe("C:\\dsh\\dsh.cmd");
    expect(next.args).toEqual(["--profile", "acp"]);
  });

  it("extraArgs 与其他启动覆盖同规则：换 agent 迁进 presets，同 agent 重设时保留", () => {
    const existing: BrainConfig = { agent: "kiro", extraArgs: ["--keep"] };
    const same = mergeBrainConfig(existing, { agent: "kiro" });
    expect(same.extraArgs).toEqual(["--keep"]);
    expect(same.presets?.kiro.extraArgs).toEqual(["--keep"]);

    const switched = mergeBrainConfig(existing, { agent: "opencode" });
    expect(switched.extraArgs).toBeUndefined();
    expect(switched.presets?.kiro.extraArgs).toEqual(["--keep"]);

    const updated = mergeBrainConfig(existing, { agent: "kiro", extraArgs: ["--new"] });
    expect(updated.extraArgs).toEqual(["--new"]);
    expect(updated.presets?.kiro.extraArgs).toEqual(["--new"]);
  });

  it("换 agent 时模型覆盖也迁进 presets（切回来仍按它建会话）", () => {
    const existing: BrainConfig = {
      agent: "deepseek",
      model: '["deepseek-account","deepseek-flash"]',
    };
    const next = mergeBrainConfig(existing, { agent: "opencode" });
    expect(next.model).toBeUndefined();
    expect(next.presets).toEqual({
      deepseek: { model: '["deepseek-account","deepseek-flash"]' },
    });
  });

  it("只改模型：同一 agent 的其它覆盖沿用，presets 里合并而不是丢字段", () => {
    const existing: BrainConfig = {
      agent: "deepseek",
      bin: "C:\\dsh\\dsh.cmd",
      model: '["deepseek-account","deepseek-flash"]',
    };
    const next = mergeBrainConfig(existing, { agent: "deepseek", model: "auto" });
    expect(next.bin).toBe("C:\\dsh\\dsh.cmd");
    expect(next.model).toBe("auto"); // auto = 跟随 agent 默认，原样存
    expect(next.presets!.deepseek).toEqual({ bin: "C:\\dsh\\dsh.cmd", model: "auto" });
    // 再设一次不带 model：沿用 auto，不会被悄悄改回预设值
    expect(mergeBrainConfig(next, { agent: "deepseek" }).model).toBe("auto");
  });
});

describe("写入磁盘往返", () => {
  it("save/load 往返一致；updateBrainConfig 保留 worker 段；clear 删文件", () => {
    saveBrainConfig({ agent: "kiro", worker: { agent: "opencode" } }, dir);
    expect(loadBrainConfig(dir)).toEqual({ agent: "kiro", worker: { agent: "opencode" } });

    const next = updateBrainConfig({ agent: "qoder" }, dir);
    expect(next.agent).toBe("qoder");
    expect(next.worker).toEqual({ agent: "opencode" });
    expect(loadBrainConfig(dir)).toEqual(next);

    expect(clearBrainConfig(dir)).toBe(true);
    expect(loadBrainConfig(dir)).toBeNull();
    expect(clearBrainConfig(dir)).toBe(false);
  });
});
