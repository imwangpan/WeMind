import fs from "node:fs";
import path from "node:path";

import { taskInboxDir } from "./task-inbox.js";

/** 收件箱命令执行方：由 daemon 注入 task-manager 的真实实现（测试可注入假实现）。 */
export type TaskInboxOps = {
  dispatch: (
    owner: string,
    text: string,
    opts: { cwd?: string; agentKey?: string; ackId?: string },
  ) => string;
  inject: (owner: string, text: string, id?: number, ackId?: string) => string;
  stop: (owner: string, id?: number | "all", ackId?: string) => string;
  writeAck: (ackId: string | undefined, text: string) => void;
  log: (...args: unknown[]) => void;
};

/**
 * 扫描 `task-inbox/`：按文件名（时间戳前缀）升序逐个读、分发到 task-manager、先删文件再执行。
 * 抽成注入式函数是为了让「坏文件丢弃 / 出错回 ack / 继续处理下一条」这些编排可单测（见 `task-inbox-runner.test.ts`）。
 */
export function scanTaskInbox(dataDir: string, owner: string, ops: TaskInboxOps): void {
  const dir = taskInboxDir(dataDir);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  } // 目录不存在/读失败：跳过
  if (!files.length) return;
  files.sort(); // 文件名带时间戳前缀，字典序即时间序
  for (const f of files) {
    const fp = path.join(dir, f);
    let cmd: {
      kind?: string;
      text?: string;
      cwd?: string;
      agent?: string;
      id?: number | string;
      ack?: string;
    };
    try {
      cmd = JSON.parse(fs.readFileSync(fp, "utf-8"));
    } catch {
      try {
        fs.unlinkSync(fp);
      } catch {
        /* ignore */
      }
      continue;
    } // 坏文件丢弃
    try {
      fs.unlinkSync(fp);
    } catch {
      /* ignore */
    } // 先删，避免重复处理
    try {
      if (cmd.kind === "dispatch") {
        // 答复由 task-manager 在**起进程有结果之后**发（达上限/起不来都是那时才知道），这里只把 ack id 递进去
        ops.log(
          "local task dispatch:",
          ops
            .dispatch(owner, String(cmd.text ?? ""), {
              ...(cmd.cwd ? { cwd: String(cmd.cwd) } : {}),
              ...(cmd.agent ? { agentKey: String(cmd.agent) } : {}),
              ...(cmd.ack ? { ackId: String(cmd.ack) } : {}),
            })
            .slice(0, 60),
        );
      } else if (cmd.kind === "reply") {
        const id = Number(cmd.id) > 0 ? Number(cmd.id) : undefined;
        const ackId = cmd.ack === undefined ? undefined : String(cmd.ack);
        const r = ops.inject(owner, String(cmd.text ?? ""), id, ackId);
        ops.log(
          "local task reply:",
          id ? `#${id}` : "-",
          String(cmd.text ?? "").slice(0, 40),
          r.slice(0, 40),
        );
      } else if (cmd.kind === "stop") {
        ops.log(
          "local task stop:",
          ops.stop(
            owner,
            cmd.id === "all" ? "all" : Number(cmd.id) > 0 ? Number(cmd.id) : undefined,
            cmd.ack === undefined ? undefined : String(cmd.ack),
          ),
        );
      } else {
        ops.log("unknown task-inbox cmd:", cmd.kind);
        ops.writeAck(
          cmd.ack === undefined ? undefined : String(cmd.ack),
          `❌ 不认识的任务命令：${cmd.kind}`,
        );
      }
    } catch (e) {
      ops.log("task-inbox dispatch error:", String(e));
      ops.writeAck(
        cmd.ack === undefined ? undefined : String(cmd.ack),
        `❌ 命令执行出错：${String(e)}`,
      );
    }
  }
}
