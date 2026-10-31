import fs from "node:fs";
import path from "node:path";

import type { ResolvedAgent } from "./brain-agents.js";

/**
 * daemon 启动/热切换成功后，把「这一刻真正生效的对话大脑」写进 `<账号目录>/brain-runtime.json`。
 *
 * 为什么还需要这个文件：`brain.pid` 只在 **ACP 子进程真的 spawn 之后**才有内容，而大脑是懒启动的——
 * 刚启动、还没收到消息时没有 pid 记录。此前 `wemind list` 的 `agent=` 只能显示 `brain.json`（有意「不看
 * 当前 shell 的环境变量」），于是用 `WEMIND_BRAIN=cline` 启动的 daemon 会一直显示成配置里的 deepseek，
 * 让人以为切换没生效。
 *
 * 这个文件记录的是 **daemon 进程自己的解析结果**（含来源 env/file/auto），与 CLI 端环境变量无关；
 * daemon 没运行时 `manage.ts` 不会采信它（`stop` 也会清掉），所以不会把旧状态当成现在时。
 */
export const BRAIN_RUNTIME_FILE = "brain-runtime.json";

export type BrainRuntime = {
  /** 实际生效的 agent 名（如 `cline`）。 */
  agent: string;
  /** 选择来源：环境变量 / brain.json / 自动探测。 */
  source: "env" | "file" | "auto";
  bin: string;
  args: string[];
  startedAt: number;
};

/** 写入运行时大脑（原子替换；失败静默——显示用，不该影响收发）。 */
export function writeBrainState(dir: string, ag: ResolvedAgent): void {
  const body: BrainRuntime = {
    agent: ag.name,
    source: ag.source,
    bin: ag.bin,
    args: ag.args,
    startedAt: Date.now(),
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, BRAIN_RUNTIME_FILE);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", "utf-8");
    fs.renameSync(tmp, file);
  } catch {
    /* best-effort */
  }
}

/** 读运行时大脑；没有/损坏/字段不对 → null（调用方按「没有运行时信息」处理）。 */
export function readBrainState(dir: string): BrainRuntime | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, BRAIN_RUNTIME_FILE), "utf-8")) as Record<
      string,
      unknown
    >;
    if (typeof j?.agent !== "string" || !j.agent) return null;
    const src = j.source;
    const source: BrainRuntime["source"] =
      src === "env" || src === "auto" ? src : src === "file" ? "file" : "file";
    return {
      agent: j.agent,
      source,
      bin: typeof j.bin === "string" ? j.bin : "",
      args: Array.isArray(j.args)
        ? (j.args as unknown[]).filter((x): x is string => typeof x === "string")
        : [],
      startedAt: Number(j.startedAt) || 0,
    };
  } catch {
    return null;
  }
}

/** 停止 daemon 时清掉，避免下次「已停止」还显示上一次的运行时大脑。 */
export function clearBrainState(dir: string): void {
  try {
    fs.unlinkSync(path.join(dir, BRAIN_RUNTIME_FILE));
  } catch {
    /* 不存在即可 */
  }
}
