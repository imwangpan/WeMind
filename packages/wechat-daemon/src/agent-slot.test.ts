import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 槽位是**懒解析**的（模块加载期不读配置），而 DATA_DIR 在 core 模块加载时就定死了——
 * 所以必须在任何相关模块 import 之前先设好 WECHAT_DATA_DIR（与 sandbox-qoder.test.ts 同一手法）。
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-slot-"));
const dataDir = path.join(root, "data");
fs.mkdirSync(dataDir, { recursive: true });
process.env.WECHAT_DATA_DIR = dataDir;

const { getAgent, peekAgent, seedSlots, setAgent, resetSlotsForTest } =
  await import("./agent-slot.js");
const { saveBrainConfig } = await import("./brain-config.js");

const savedBrain = process.env.WEMIND_BRAIN;
const savedWorkerBrain = process.env.WEMIND_WORKER_BRAIN;

beforeEach(() => {
  resetSlotsForTest();
  delete process.env.WEMIND_BRAIN;
  delete process.env.WEMIND_WORKER_BRAIN;
  fs.rmSync(path.join(dataDir, "brain.json"), { force: true });
});

afterEach(() => {
  resetSlotsForTest();
  if (savedBrain !== undefined) process.env.WEMIND_BRAIN = savedBrain;
  if (savedWorkerBrain !== undefined) process.env.WEMIND_WORKER_BRAIN = savedWorkerBrain;
});

describe("agent-slot", () => {
  it("peekAgent 不触发解析；getAgent 懒解析后 peek 才有值", () => {
    saveBrainConfig({ agent: "opencode" });
    expect(peekAgent("brain")).toBeUndefined();
    expect(getAgent("brain").name).toBe("opencode");
    expect(peekAgent("brain")?.name).toBe("opencode");
  });

  it("记忆化：解析后改配置/环境变量都不影响本次运行，直到 reset/seed", () => {
    saveBrainConfig({ agent: "opencode" });
    expect(getAgent("brain").name).toBe("opencode");
    saveBrainConfig({ agent: "qoder" });
    process.env.WEMIND_BRAIN = "kiro";
    expect(getAgent("brain").name).toBe("opencode"); // 仍是第一次解析的结果
    resetSlotsForTest();
    expect(getAgent("brain").name).toBe("kiro"); // 环境变量优先
  });

  it("两个角色各自独立：worker 段 + WEMIND_WORKER_BRAIN", () => {
    saveBrainConfig({ agent: "kiro", worker: { agent: "opencode" } });
    expect(getAgent("brain").name).toBe("kiro");
    expect(getAgent("worker").name).toBe("opencode");
    process.env.WEMIND_WORKER_BRAIN = "qoder";
    resetSlotsForTest();
    expect(getAgent("worker").name).toBe("qoder");
    expect(getAgent("brain").name).toBe("kiro");
  });

  it("未配置时两个角色都走 auto（与拆分角色之前的默认一致）", () => {
    expect(getAgent("brain").requestedKey).toBe("auto");
    expect(getAgent("worker").requestedKey).toBe("auto");
  });

  it("seedSlots 用给定配置一次性定下两个角色（runDaemon 启动路径）", () => {
    seedSlots({ agent: "gemini", worker: { agent: "kiro" } });
    expect(getAgent("brain").name).toBe("gemini");
    expect(getAgent("worker").name).toBe("kiro");
    expect(getAgent("brain").source).toBe("file");
  });

  it("setAgent 热更新单个角色；传 null 清缓存（下次重新解析）", () => {
    saveBrainConfig({ agent: "opencode" });
    seedSlots();
    const old = getAgent("brain");
    expect(old.name).toBe("opencode");
    const fresh = { ...getAgent("worker") };
    setAgent("brain", fresh);
    expect(getAgent("brain").name).toBe(fresh.name);
    setAgent("brain", null);
    resetSlotsForTest();
    saveBrainConfig({ agent: "kiro" });
    expect(getAgent("brain").name).toBe("kiro");
  });
});
