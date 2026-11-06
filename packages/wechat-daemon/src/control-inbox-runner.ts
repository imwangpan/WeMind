import fs from "node:fs";
import path from "node:path";

import {
  controlInboxDir,
  isControlRequestExpired,
  readControlInbox,
  sweepControlOut,
  writeControlResponse,
  type ControlRequest,
} from "./ipc/control-bridge.js";

export type ControlInboxDeps = {
  /** 执行一条已校验且未过期的请求；返回给 CLI 的文本（`❌` 开头表示失败）。 */
  handle: (req: ControlRequest, owner: string) => Promise<string>;
  log: (...args: unknown[]) => void;
  now?: () => number;
};

/**
 * 控制桥收件箱扫描器。同一时刻只处理一条：切换/恢复本来就要串行（它们争的是同一个 ACP 连接），
 * 处理期间再来一次扫描直接返回。
 *
 * 抽成类是为了让「过期请求不执行 / 失败一定写应答 / 单条异常不拖垮后面」这些编排可单测（见 `control-inbox-runner.test.ts`）。
 */
export class ControlInboxRunner {
  private readonly dir: string;
  private readonly deps: Required<ControlInboxDeps>;
  private busy = false;

  constructor(dir: string, deps: ControlInboxDeps) {
    this.dir = dir;
    this.deps = { ...deps, now: deps.now ?? Date.now };
  }

  async scan(owner: string): Promise<void> {
    if (this.busy) return;
    sweepControlOut(3_600_000, this.deps.now(), this.dir);
    const items = readControlInbox(this.dir);
    if (!items.length) return;
    this.busy = true;
    try {
      for (const { file, req } of items) {
        try {
          fs.unlinkSync(path.join(controlInboxDir(this.dir), file));
        } catch {
          /* ignore */
        } // 先删，避免重复处理
        if (!req) {
          this.deps.log("control: 非法请求（未知 kind / 坏 JSON），已丢弃:", file);
          continue;
        }
        // CLI 已经等到超时并放弃：不要再执行（否则「CLI 说没等到、daemon 却照做」）。
        if (isControlRequestExpired(req, this.deps.now())) {
          this.deps.log("control: 请求已超时，跳过执行:", req.kind, file);
          writeControlResponse(
            {
              id: req.id,
              at: this.deps.now(),
              ok: false,
              text: "❌ 请求已超时（CLI 已不再等待），本次未执行。",
            },
            this.dir,
          );
          continue;
        }
        this.deps.log(
          "control(cli):",
          req.kind,
          JSON.stringify({ target: req.target, ref: req.ref }),
        );
        let text: string;
        try {
          text = await this.deps.handle(req, owner);
        } catch (e) {
          text = `❌ 处理出错：${String(e)}`;
        }
        // 约定：❌ 开头即失败（CLI 据此定退出码）。应答一定写——不写的话 CLI 会白等到超时。
        writeControlResponse(
          { id: req.id, at: this.deps.now(), ok: !text.startsWith("❌"), text },
          this.dir,
        );
      }
    } finally {
      this.busy = false;
    }
  }
}
