import { DATA_DIR } from "@wemind/wechat-ilink-core";

import { getAgent, setAgent } from "./agent-slot.js";
import { resolvePresetByName, type ResolvedAgent } from "./brain-agents.js";
import { loadBrainConfig, updateBrainConfig } from "./brain-config.js";
import { ensureBrainHome } from "./mcp-sandbox.js";
import { beginSwitch, drainTurn, endSwitch, restart, warmup } from "./acp-brain.js";

/**
 * 运行时切换对话大脑。
 *
 * 为什么需要它：agent 过去是模块级常量（进程启动时冻结），切脑只能 `wemind brain set X --restart`——
 * 重启整个 daemon，打断在途任务与回合。现在槽位可变（agent-slot.ts），于是「切脑」可以是一等命令。
 *
 * 流程与取舍（每一步都在防一种具体的坏结果）：
 *  1. 解析目标预设：**绕开环境变量**（用户此刻的明确意图该压过一次性 env 覆盖），不可用直接答复失败，不 spawn。
 *  2. `beginSwitch()` → `drainTurn()`：等在跑的回合结束（默认 30s）。超时**诚实失败**，绝不半路砍回合丢答案。
 *  3. `ensureBrainHome(新 agent)` → `restart()`（杀旧进程）→ `warmup()`（initialize + session/load|new，硬上限 120s）。
 *  4. 成功才 `setAgent()` + 写 brain.json —— **持久化放最后**，于是「退回」不需要撤销任何东西：
 *     失败路径只做 `restart()`（清掉半截进程与 pid 记录），槽位仍指旧大脑，下一条消息懒重建它（上下文从磁盘 load 回来）。
 *  5. 同一目标的并发请求复用同一次切换；不同目标直接拒绝（不排队，避免「连点两下切到 A」这类歧义）。
 *
 * 已知边界：`WEMIND_BRAIN` 环境变量优先级高于 brain.json，命令绕开了它（进程内真的切了），
 * 但**重启后会回到 env 指的大脑** —— 答复里如实警告，不装作没这回事。
 */

const DRAIN_MS = Number(process.env.WEMIND_SWITCH_DRAIN_MS) || 30_000;
const TIMEOUT_MS = Number(process.env.WEMIND_SWITCH_TIMEOUT_MS) || 120_000;

export type SwitchOutcome =
  | {
      ok: true;
      agent: ResolvedAgent;
      /** 是否真的换了（false = 本来就是它）。 */
      changed: boolean;
      ms: number;
      /** 面向用户的答复（含 env 覆盖等警告）。 */
      notice: string;
    }
  | { ok: false; problem: string };

let inFlight: { target: string; promise: Promise<SwitchOutcome> } | null = null;

/** 正在切换的目标（没有则 null）——`/ai` 与答复文案用。 */
export function switchInFlightTarget(): string | null {
  return inFlight?.target ?? null;
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** 环境变量若压着命令结果，答复里必须说清楚（否则用户会以为切换没生效，或下次重启后莫名回到旧的）。 */
function envNote(key: string): string {
  const env = process.env.WEMIND_BRAIN?.trim();
  if (!env || env.toLowerCase() === key) return "";
  return `\n⚠️ 环境变量 WEMIND_BRAIN=${env} 仍在生效（优先级高于 brain.json）：本次已切到 ${key}，但**重启后会回到 ${env}**。想长期用 ${key}，请去掉这个环境变量。`;
}

function sameAgent(a: ResolvedAgent, b: ResolvedAgent): boolean {
  return a.name === b.name && a.bin === b.bin && a.args.join("\u0000") === b.args.join("\u0000");
}

/**
 * 预检一个切换目标：名字 → 可用 agent，并告诉你「是不是本来就已经是它」。
 * **不 spawn、不碰磁盘**（只读配置），所以调用方可以在发 ack 之前先判一次——
 * 避免对「未知 agent / 已装不上」也回一句「正在切换」，再补一条失败。
 */
export function preflightSwitch(target: string, dir: string = DATA_DIR): PreflightResult {
  const key = (target ?? "").trim().toLowerCase();
  if (!key) return { ok: false, problem: "需要指定 agent 名（或 `auto` 重新自动探测）。" };
  const r = resolvePresetByName(key, loadBrainConfig(dir));
  if (!r.ok) return { ok: false, problem: r.problem };
  const current = getAgent("brain");
  return { ok: true, key, agent: r.agent, current, already: sameAgent(current, r.agent) };
}

export type PreflightResult =
  | { ok: true; key: string; agent: ResolvedAgent; current: ResolvedAgent; already: boolean }
  | { ok: false; problem: string };

/**
 * 切到某个 agent（`auto` 表示重新自动探测）。`userId` 是启动新大脑时按谁恢复会话（缺省不建会话）。
 * `persist=false`：只在本进程生效、不写 brain.json（CLI 的「仅本次」场景）。
 */
export async function switchBrain(
  target: string,
  opts: { userId?: string; dir?: string; persist?: boolean } = {},
): Promise<SwitchOutcome> {
  const key = (target ?? "").trim().toLowerCase();
  if (!key) return { ok: false, problem: "需要指定 agent 名（或 `auto` 重新自动探测）。" };
  if (inFlight) {
    if (inFlight.target === key) return inFlight.promise; // 同一目标：复用同一次切换（重复请求不会切两遍）
    return { ok: false, problem: `正在切到「${inFlight.target}」，等它完成后再试。` };
  }
  const promise = runSwitch(key, opts);
  inFlight = { target: key, promise };
  try {
    return await promise;
  } finally {
    if (inFlight?.promise === promise) inFlight = null;
  }
}

async function runSwitch(
  key: string,
  opts: { userId?: string; dir?: string; persist?: boolean },
): Promise<SwitchOutcome> {
  const dir = opts.dir ?? DATA_DIR;
  const pre = preflightSwitch(key, dir);
  if (!pre.ok) return { ok: false, problem: pre.problem };
  const target = pre.agent;
  const current = pre.current;
  const note = envNote(key);

  if (pre.already) {
    // 已经是它：不重启进程（免得白白打断上下文），只把选择落实到磁盘
    if (opts.persist !== false) updateBrainConfig({ agent: key }, dir);
    return {
      ok: true,
      agent: target,
      changed: false,
      ms: 0,
      notice: `当前对话大脑已经是「${target.name}」，无需切换。${note}`,
    };
  }

  beginSwitch();
  try {
    const idle = await drainTurn(DRAIN_MS);
    if (!idle)
      return {
        ok: false,
        problem: `当前有回合正在进行（等了 ${Math.round(DRAIN_MS / 1000)} 秒仍未结束），这次切换没有执行——稍后再发一次即可。`,
      };

    const t0 = Date.now();
    try {
      ensureBrainHome(target); // 先备沙箱（只往新 agent 的配置目录里加东西，失败退回无需撤销）
      restart(); // 杀掉旧进程；旧会话在磁盘上，切回来时 session/load 恢复
      await withTimeout(warmup(target, opts.userId ?? ""), TIMEOUT_MS, warmupTimeoutMsg());
      setAgent("brain", target); // 成功之后才更新槽位
      if (opts.persist !== false) updateBrainConfig({ agent: key }, dir); // 持久化放最后：失败无需撤销
      const ms = Date.now() - t0;
      return {
        ok: true,
        agent: target,
        changed: true,
        ms,
        notice: `✅ 已切换对话大脑：${current.name} → ${target.name}（${(ms / 1000).toFixed(1)}s）。${note}`,
      };
    } catch (e) {
      restart(); // 清掉半截进程与 pid 记录
      const why = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        problem: `切换失败，已退回原来那个「${current.name}」：${why}\n下一条消息会自动重启旧大脑（上下文从磁盘恢复），不用手动处理。`,
      };
    }
  } finally {
    endSwitch();
  }
}

function warmupTimeoutMsg(): string {
  return `新大脑启动超时（${Math.round(TIMEOUT_MS / 1000)}s 内没有完成 initialize/会话）`;
}
