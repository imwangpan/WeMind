import { createLogger, DATA_DIR, clearSessionPause, loadAccount } from "@wemind/wechat-ilink-core";
import {
  askBrainTurn,
  isTurnInFlight,
  newSession,
  restartForMcpChange,
  resumeSession,
} from "../acp/acp-brain.js";
import { agentConfigFor, loadBrainConfig } from "../agents/brain-config.js";
import {
  presetAvailable,
  presetNames,
  resolvePresetByName,
  type ResolvedAgent,
} from "../agents/brain-agents.js";
import { getAgent, setAgent } from "../agents/agent-slot.js";
import { preflightSwitch, switchBrain, switchInFlightTarget } from "../acp/brain-switch.js";
import { renderHelp, type ChatCommand } from "../ipc/chat-commands.js";
import type { ControlRequest } from "../ipc/control-bridge.js";
import { currentSessionIdOf } from "../sessions/session-registry.js";
import {
  deleteSessionCmd,
  newSessionCmd,
  renameSessionCmd,
  resumeSessionCmd,
  sessionsCmd,
  type SessionCtx,
} from "../sessions/session-manager.js";
import { addMcp, ensureBrainHome, listMcp, removeMcp } from "../agents/sandbox/mcp-sandbox.js";
import { ensureWorkerHome } from "../agents/sandbox/worker-sandbox.js";
import {
  defaultWorkspacePath,
  resolveWorkspace,
  updateWorkspace,
  WORKSPACE_CHANGE_NOTICE,
} from "../agents/config/workspace.js";
import { overlayPath, readOverlay } from "../agents/config/overlay.js";
import {
  HANDOFF_PROMPT,
  HANDOFF_TTL_MS,
  HANDOFF_VERSION,
  saveHandoff,
} from "../sessions/handoff.js";
import { LONG_REPLY_THRESHOLD } from "./messaging/md-reply.js";
import { armSensitiveAllow } from "./messaging/sensitive-allow.js";
import { hasActiveTask, taskPoolSummary } from "../tasks/task-manager.js";
import { killIdle as killIdleConns } from "../tasks/worker-pool.js";
const log = createLogger("wechat-daemon");

/** 切脑结果/来源的中文说法（`AI` 总览与答复共用一套词，避免两处说法不一致）。 */
const SOURCE_LABEL: Record<ResolvedAgent["source"], string> = {
  env: "环境变量",
  file: "brain.json",
  auto: "自动探测",
};

function agentLine(ag: ResolvedAgent): string {
  return `${ag.name}（来源：${SOURCE_LABEL[ag.source]}）`;
}

/** `AI` / `/ai`：可选 agent（带「装了没」）+ 当前对话大脑/默认任务大脑 + 池中进程。 */
function agentOverview(): string {
  const cfg = loadBrainConfig();
  const brain = getAgent("brain");
  const worker = getAgent("worker");
  const list = presetNames()
    .map((k) => `${k}${presetAvailable(k, cfg) ? "✅" : "❌"}`)
    .join("、");
  const pool = taskPoolSummary();
  const lines = [
    "🤖 AI 配置",
    `对话大脑：${agentLine(brain)}`,
    `默认任务大脑：${agentLine(worker)}${worker.name === brain.name ? "（随对话大脑）" : ""}`,
    pool.length
      ? `池中 worker：${pool.map((p) => `${p.agent} 忙${p.busy}${p.taskIds.length ? `(#${p.taskIds.join("/")})` : ""}/闲${p.idle}`).join(" ｜ ")}`
      : undefined,
    `可选 agent：${list}、auto`,
    "切换：`切换大脑 <agent 名>` ｜ `切换任务大脑 <agent 名>`",
  ].filter((x): x is string => x !== undefined);
  return lines.join("\n");
}

/**
 * 切对话大脑：先回 ack，启动新大脑在后台跑、结果补发（决策⑦：切换可能要几十秒，不能让用户干等等不到一句回话）。
 * 这里**不** await 整段切换——启动新大脑期间的入站消息会自己在 acp-brain 门口等新大脑就绪（有界），不会双起进程。
 */
async function switchBrainAck(target: string, userId: string, ctx: ControlCtx): Promise<string> {
  const running = switchInFlightTarget();
  if (running) return `正在切到「${running}」，等它完成后再发一次。`;
  const pre = preflightSwitch(target, DATA_DIR);
  if (!pre.ok) return `❌ ${pre.problem}`;
  if (pre.already) {
    // 已经是它（只是把选择落到 brain.json）：亚毫秒级，直接等它，不用 ack/补发两段
    const out = await switchBrain(target, { userId, dir: DATA_DIR });
    return out.ok ? out.notice : `❌ ${out.problem}`;
  }
  void switchBrain(target, { userId, dir: DATA_DIR })
    .then((out) => (out.ok ? out.notice : `❌ ${out.problem}`))
    .catch((e) => `❌ 切换出错：${String(e)}`)
    .then(async (r) => {
      (r.startsWith("❌") ? log.warn : log.info)("brain switch:", r.replace(/\n/g, " | "));
      await ctx.notify(r).catch((e) => log.warn("switch notice failed:", String(e)));
    });
  return `⏳ 正在切到「${pre.agent.name}」…（正在启动新大脑，成功或失败稍后补发消息；这期间发来的消息会等新大脑就绪）`;
}

/** `切换任务大脑`：只改本进程的默认任务大脑（本次运行内一直生效，不写 brain.json）。 */
function setTaskBrain(target: string): string {
  const key = target.trim().toLowerCase();
  const cfg = loadBrainConfig(DATA_DIR);
  const r = resolvePresetByName(key, agentConfigFor(cfg, "worker"));
  if (!r.ok) return `❌ ${r.problem}`;
  const cur = getAgent("worker");
  // 与 brain-switch 的 sameAgent 同一条判据（name/bin/args/model）：任一项不同都算一次真切换，
  // 否则「改完再切」会被判成「已经是它」，新任务继续用旧二进制/旧参数/旧模型。
  if (
    cur.name === r.agent.name &&
    cur.bin === r.agent.bin &&
    cur.args.join("\u0000") === r.agent.args.join("\u0000") &&
    cur.model === r.agent.model
  )
    return `默认任务大脑已经是「${r.agent.name}」，无需切换。`;
  setAgent("worker", r.agent);
  const busy = hasActiveTask();
  killIdleConns(); // 池里的空闲连接属于旧默认：留着没用（下次按新 agent 取），有任务在跑的那些不动
  const note = "（不写 brain.json，重启后回到配置里的默认）";
  return busy
    ? `✅ 默认任务大脑：${cur.name} → ${r.agent.name}${note}。\n在跑的任务继续用它自己起的 agent 跑完；**之后的新任务**用新大脑。`
    : `✅ 默认任务大脑：${cur.name} → ${r.agent.name}${note}。`;
}

type ControlCtx = {
  /** 登录者 id（帮助文案据此裁剪）。 */
  owner: string;
  /** 补发一条「必须送达」的消息（用于切脑的 ack/结果两段答复）。 */
  notify: (text: string) => Promise<void>;
  /** 补发一份长内容（交接摘要这类「要给用户留着」的文本走 .md 文件，不刷屏）。 */
  notifyFile?: (text: string) => Promise<void>;
  /** 「允许敏感文件」开窗后补发之前被拦下的附件；快车道注入，CLI 路径没有。 */
  releaseSensitive?: () => Promise<{ sent: number; failed: number }>;
};

/**
 * `交接`：让当前大脑把上下文写成摘要，写入磁盘 + 回复给用户（长则另发 .md）。
 * 先回一条「在做」的提示：写摘要要走一整个模型回合（可能一两分钟），没有进度提示会让人以为卡死。
 */
async function runHandoff(userId: string, ctx: ControlCtx, deadline?: number): Promise<string> {
  const before = getAgent("brain").name;
  if (!currentSessionIdOf(before, userId, DATA_DIR))
    return "ℹ️ 当前大脑还没有和你的对话记录，没什么可交接的。先聊几句再来交接。";
  await ctx
    .notify(`⏳ 正在让「${before}」把当前上下文写成交接摘要…（可能要一两分钟）`)
    .catch(() => {});
  let text: string;
  let from: string;
  try {
    const r = await askBrainTurn(userId, HANDOFF_PROMPT, undefined, undefined, { deadline });
    text = r.text.trim();
    from = r.agent; // 排队期间可能刚好切完脑：记实际答话的那个
  } catch (e) {
    return `❌ 生成交接摘要失败：${String(e)}`;
  }
  if (!text) return "❌ 大脑这次没给出摘要内容（空回复），没有保存。可以再试一次。";
  const now = Date.now();
  saveHandoff(
    {
      version: HANDOFF_VERSION,
      fromAgent: from,
      userId,
      text,
      createdAt: now,
      expiresAt: now + HANDOFF_TTL_MS,
    },
    DATA_DIR,
  );
  const head =
    `✅ 交接摘要已保存（${text.length} 字，来自「${from}」）。\n` +
    `切到别的大脑后，你发的第一条消息会自动带上它（答完即用掉，只带一次；切回「${from}」不带上）。`;
  if (text.length > LONG_REPLY_THRESHOLD && ctx.notifyFile) {
    await ctx.notifyFile(text).catch((e) => log.warn("handoff md send failed:", String(e)));
    return `${head}\n（摘要较长，已另发 .md 文件。）`;
  }
  return `${head}\n\n${text}`;
}

export async function handleControl(
  c: ChatCommand,
  userId: string,
  ctx: ControlCtx,
): Promise<string> {
  if (c.kind === "list") return listMcp();
  // 会话类指令的共用上下文：谁、当前对话大脑、数据目录（登记表按 agent 分开存，切换后自然按新大脑列）
  const sc = (): SessionCtx => ({ agent: getAgent("brain").name, userId, dir: DATA_DIR });
  if (c.kind === "new") return await newSessionCmd({ ...sc(), name: c.name, create: newSession });
  if (c.kind === "sessions") return sessionsCmd({ ...sc(), page: c.page });
  if (c.kind === "resume") return await resumeSessionCmd({ ...sc(), resume: resumeSession }, c.ref);
  if (c.kind === "rename") return renameSessionCmd(sc(), c.ref, c.name);
  if (c.kind === "delete") return deleteSessionCmd(sc(), c.ref);
  if (c.kind === "add" || c.kind === "remove") {
    const r = c.kind === "add" ? addMcp(c.name) : removeMcp(c.name);
    if (!r.ok || !r.changed) return r.text; // 失败/没变化都不重启大脑
    // 切换进行中先等它结束再重启，别把正在预热的新大脑杀在半路
    if (!(await restartForMcpChange()))
      return `${r.text}\n（大脑正在切换中，这次没有重启它；切换完成后请再发一次这条指令，让新 MCP 列表生效。）`;
    return r.text;
  }
  if (c.kind === "ai") return agentOverview();
  if (c.kind === "brain")
    return c.target
      ? await switchBrainAck(c.target, userId, ctx)
      : `当前对话大脑：${agentLine(getAgent("brain"))}。切换用 \`切换大脑 <agent 名>\`（可选：${presetNames().join("、")}、auto）。`;
  if (c.kind === "workerBrain")
    return c.target
      ? setTaskBrain(c.target)
      : `当前默认任务大脑：${agentLine(getAgent("worker"))}。切换用 \`切换任务大脑 <agent 名>\`。`;
  if (c.kind === "help") return renderHelp(userId === ctx.owner ? "owner" : "user", "wechat");
  if (c.kind === "allowSensitive") {
    const { until, minutes } = armSensitiveAllow(c.minutes);
    const at = new Date(until).toLocaleTimeString("zh-CN", { hour12: false });
    // 先开窗再补发：之前被拦下的附件不用让大脑重新发一遍。补发出错不改变「窗口已开」这个事实。
    let extra = "";
    if (ctx.releaseSensitive) {
      try {
        const r = await ctx.releaseSensitive();
        if (r.sent > 0)
          extra = `\n📎 已补发 ${r.sent} 个之前被拦下的附件${r.failed ? `（另有 ${r.failed} 个失败）` : ""}。`;
        else if (r.failed > 0)
          extra = `\n📎 之前拦下的 ${r.failed} 个附件补发失败（文件可能已移动、超出上限或额度不足）。`;
      } catch (e) {
        log.error("release pending sensitive failed:", String(e));
        extra = "\n（补发之前拦下的附件时出错，可让大脑重新发一次。）";
      }
    }
    return (
      `✅ 已允许发送敏感文件，窗口 ${minutes} 分钟（到 ${at}）。${extra}\n` +
      "这期间大脑回复里的 [附件] 链接可以发 account.json 等凭证/状态文件；" +
      "网络路径、NTFS 数据流与大小上限仍然生效。窗口只在本 daemon 进程内，重启即失效。"
    );
  }
  if (c.kind === "workspace") {
    if (c.path !== undefined) {
      try {
        updateWorkspace("brain", c.path, DATA_DIR);
      } catch (e) {
        return `❌ ${e instanceof Error ? e.message : String(e)}`;
      }
      return `✅ ${WORKSPACE_CHANGE_NOTICE}\n新工作区：${c.path}`;
    }
    if (c.reset) {
      updateWorkspace("brain", null, DATA_DIR);
      return `✅ brain 工作区已恢复默认：${defaultWorkspacePath("brain", DATA_DIR)}\n${WORKSPACE_CHANGE_NOTICE}`;
    }
    const ws = resolveWorkspace("brain", DATA_DIR);
    return `brain 默认工作区：${ws.mode} ${ws.path}${ws.problem ? `（${ws.problem}）` : ""}\n切换用 \`设置工作区 <绝对路径>\`，恢复用 \`重置工作区\`；已有会话保持原 cwd。`;
  }
  if (c.kind === "wechatConfig") {
    const ag = c.agent.toLowerCase();
    if (!presetNames().includes(ag))
      return `❌ 未知 agent「${ag}」。可用：${presetNames().join(", ")}`;
    const read = readOverlay(ag, DATA_DIR);
    if (read.problems.length) return `❌ ${read.problems.join("；")}`;
    return `微信侧 overlay（${overlayPath(ag, DATA_DIR)}）：\n${JSON.stringify(read.overlay, null, 2)}\n修改请用本机 CLI：wemind config wechat edit ${ag}（只支持 mcp.disable / mcp.extra）。要改 Agent 真实配置，直接对大脑说清要改的内容即可（默认改真实配置）。`;
  }
  if (c.kind === "handoff") return await runHandoff(userId, ctx);
  // 兜底：指令表新增了 kind 但这里还没接通时（正常情况下 TS 会先把这里判成不可达），别静默吞掉
  return `「${(c as { kind: string }).kind}」这条指令还没接通（当前版本请先用 CLI 对应命令）。`;
}

/**
 * 执行一条 CLI 桥请求，返回要打印给用户的那句话。
 * 与微信指令**共用同一批实现函数**（switchBrain / session-manager / task-manager），
 * 所以「CLI 与微信行为一致」不是靠约定，而是同一段代码。
 * 这里的 `owner` 就是登录者：本地命令没有「谁发的」的概念，一律作用于本人。
 */
export async function handleControlRequest(req: ControlRequest, owner: string): Promise<string> {
  const sc = (): SessionCtx => ({ agent: getAgent("brain").name, userId: owner, dir: DATA_DIR });
  switch (req.kind) {
    case "brain.switch": {
      if (!req.target) return "❌ 用法：brain switch <agent 名|auto>";
      const pre = preflightSwitch(req.target, DATA_DIR);
      if (!pre.ok) return `❌ ${pre.problem}`;
      // 注意：这里**不用** ack/补发两段（那是微信侧的写法）。CLI 在等应答，直接等完整结果更实在。
      const out = await switchBrain(req.target, { userId: owner, dir: DATA_DIR });
      return out.ok ? out.notice : `❌ ${out.problem}`;
    }
    case "brain.worker":
      if (!req.target)
        return `当前默认任务大脑：${agentLine(getAgent("worker"))}。切换用 \`wemind brain switch <agent 名> --worker\`。`;
      return setTaskBrain(req.target);
    case "brain.handoff":
      return await runHandoff(owner, { owner, notify: async () => {} }, req.expiresAt);
    case "config.reload": {
      ensureBrainHome();
      ensureWorkerHome();
      killIdleConns();
      if (!(await restartForMcpChange()))
        return "Agent 配置已重新读取，但大脑正在切换中，这次没有重启；切换完成后用 `wemind config reload` 再试一次。";
      if (isTurnInFlight())
        return "Agent 配置已重新读取，重启已排队：当前回合结束后生效（不打断正在生成的回复）。";
      return "Agent 配置已重新读取，常驻大脑已重启；下一条消息使用新配置。已有会话会在重启后自动 session/load 恢复。";
    }
    case "session.new":
      return await newSessionCmd({
        ...sc(),
        name: req.name,
        create: (uid) => newSession(uid, { deadline: req.expiresAt }),
      });
    case "session.list":
      return sessionsCmd({ ...sc(), page: req.page });
    case "session.resume":
      if (!req.ref) return "❌ 用法：session resume <序号|名字|id前缀>";
      return await resumeSessionCmd(
        {
          ...sc(),
          resume: (uid, sid) => resumeSession(uid, sid, { deadline: req.expiresAt }),
        },
        req.ref,
      );
    case "session.rename":
      if (!req.ref || !req.name) return "❌ 用法：session rename <序号|名字> <新名字>";
      return renameSessionCmd(sc(), req.ref, req.name);
    case "session.delete":
      if (!req.ref) return "❌ 用法：session delete <序号|名字|id前缀>";
      return deleteSessionCmd(sc(), req.ref);
    case "session.unpause": {
      // 控制桥入口没有外层 `account` 变量（`runDaemon` 里那份是局部的）；这里按当前凭证重新取 botId。
      const botId = loadAccount()?.botId;
      if (!botId) return "❌ 没有登录凭证；先登录再解除冷却。";
      clearSessionPause(botId);
      log.info("control(cli): 已解除 -14 冷却，继续轮询");
      return "✅ 已解除会话过期冷却，继续轮询。";
    }
  }
}
