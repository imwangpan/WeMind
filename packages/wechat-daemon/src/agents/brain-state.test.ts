import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ResolvedAgent } from "./brain-agents.js";
import {
  BRAIN_RUNTIME_FILE,
  clearBrainState,
  readBrainState,
  writeBrainState,
} from "./brain-state.js";

const ag = {
  name: "cline",
  source: "env",
  bin: "cline.cmd",
  args: ["--acp", "--auto-approve", "true"],
} as unknown as ResolvedAgent;

describe("brain-state（运行时大脑身份）", () => {
  it("写入后可读回；clear 后为空", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-brain-state-"));
    try {
      writeBrainState(dir, ag);
      expect(fs.existsSync(path.join(dir, BRAIN_RUNTIME_FILE))).toBe(true);
      const got = readBrainState(dir);
      expect(got?.agent).toBe("cline");
      expect(got?.source).toBe("env");
      expect(got?.args).toEqual(["--acp", "--auto-approve", "true"]);

      clearBrainState(dir);
      expect(readBrainState(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("文件损坏/字段缺失 → null，不抛", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-brain-state-"));
    try {
      fs.writeFileSync(path.join(dir, BRAIN_RUNTIME_FILE), "{bad json");
      expect(readBrainState(dir)).toBeNull();
      fs.writeFileSync(path.join(dir, BRAIN_RUNTIME_FILE), JSON.stringify({ source: "env" }));
      expect(readBrainState(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
