import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readPidRecords, recordMarkers, pidRecordOf, writePidRecords } from "./pid-record.js";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-pidrec-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const file = (name = "brain.pid"): string => path.join(dir, name);
const writeRaw = (s: string, name = "brain.pid"): void => fs.writeFileSync(file(name), s, "utf-8");

describe("readPidRecords（兼容三种形态）", () => {
  it("旧版裸整数 → 一条 legacy 记录（无 bin/args，判定要回退配置）", () => {
    writeRaw("4321\n");
    const recs = readPidRecords(file());
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ pid: 4321, legacy: true, bin: "", args: [] });
    expect(recordMarkers(recs[0])).toEqual([]);
  });

  it("单个 JSON 对象与 JSON 数组都认（brain 单条 / workers 多条同一个读法）", () => {
    writeRaw(JSON.stringify({ pid: 11, agent: "kiro", bin: "kiro-cli", args: ["acp"] }));
    expect(readPidRecords(file())[0]).toMatchObject({ pid: 11, agent: "kiro", state: "busy" });
    writeRaw(
      JSON.stringify([
        { pid: 11, agent: "kiro", bin: "kiro-cli", args: ["acp"], taskId: 2, state: "busy" },
        { pid: 12, agent: "opencode", bin: "opencode", args: ["acp"], state: "idle" },
      ]),
      "workers.pid.json",
    );
    const recs = readPidRecords(file("workers.pid.json"));
    expect(recs.map((r) => r.pid)).toEqual([11, 12]);
    expect(recs[0].taskId).toBe(2);
    expect(recs[1].state).toBe("idle");
  });

  it("缺失 / 空 / 损坏 / 无效条目 → 降级为空（不抛，绝不阻塞启动）", () => {
    expect(readPidRecords(file("nope.pid"))).toEqual([]);
    writeRaw("   \n");
    expect(readPidRecords(file())).toEqual([]);
    writeRaw("{ 坏 json");
    expect(readPidRecords(file())).toEqual([]);
    writeRaw(JSON.stringify([{ pid: 0 }, { pid: "x" }, { pid: 9 }]));
    expect(readPidRecords(file()).map((r) => r.pid)).toEqual([9]);
  });
});

describe("writePidRecords", () => {
  it("单条写对象、多条写数组、空数组删文件", () => {
    writePidRecords(file(), [
      pidRecordOf(7, { name: "kiro", bin: "kiro-cli", args: ["acp"], shell: false }),
    ]);
    expect(JSON.parse(fs.readFileSync(file(), "utf-8")).pid).toBe(7);
    writePidRecords(file("workers.pid.json"), [
      pidRecordOf(7, { name: "kiro", bin: "kiro-cli", args: ["acp"], shell: false }),
      pidRecordOf(
        8,
        { name: "qoder", bin: "qodercli", args: ["--acp"], shell: false },
        { state: "idle", taskId: 3 },
      ),
    ]);
    const arr = JSON.parse(fs.readFileSync(file("workers.pid.json"), "utf-8"));
    expect(Array.isArray(arr)).toBe(true);
    expect(arr[1]).toMatchObject({ pid: 8, state: "idle", taskId: 3, bin: "qodercli" });
    writePidRecords(file(), []);
    expect(fs.existsSync(file())).toBe(false);
  });
});

describe("pidRecordOf / recordMarkers（manage 判定身份用）", () => {
  it("记录带上起进程时真实用的 bin/args，特征串按它算", () => {
    const rec = pidRecordOf(99, {
      name: "qoder",
      bin: "C:\\q\\qodercli.exe",
      args: ["--acp", "--yolo"],
      shell: false,
    });
    expect(rec).toMatchObject({
      pid: 99,
      agent: "qoder",
      bin: "C:\\q\\qodercli.exe",
      state: "busy",
    });
    expect(recordMarkers(rec)).toEqual([["qodercli", "--acp", "--yolo"]]);
  });
});
