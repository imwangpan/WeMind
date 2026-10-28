import { resolveAgentFor, type ResolvedAgent } from "./brain-agents.js";
import { loadBrainConfig, type AgentRole, type BrainConfig } from "./brain-config.js";

/**
 * 角色的 agent「槽位」：把「当前用哪个 agent」从**模块级常量**（改造前 `acp-brain.ts:25`、
 * `worker-acp.ts:28`、`mcp-sandbox.ts:21`、`worker-sandbox.ts:22` 都是 import 时解析一次就冻死）
 * 变成**运行时可变状态**——否则「热切换大脑」只能靠重启整个 daemon。
 *
 * 两个刻意的设计：
 *  - **懒解析 + 记忆化**：模块加载期不读配置，第一次真正用到才解析。沙箱测试靠「先设环境变量、再动态 import」
 *    来构造场景（`sandbox-qoder.test.ts`），加载期解析会让这些用例变成时序敏感。`runDaemon` 开头会
 *    `seedSlots()` 显式种入，所以「启动即定」的语义没变。
 *  - **变更只有一个入口**：`setAgent` 只由切换流程调用；运行中的回合一律**显式持有并传递**自己的 agent
 *    （见 acp-brain 的 `ensureProcess(ag)/ensureSession(ag,…)/promptRequest(ag,…)`），过程内不再读槽位——
 *    于是「握手到一半换了 agent」在结构上不可能发生，不需要加锁。
 */

const slots = new Map<AgentRole, ResolvedAgent>();

/** 取某角色当前的 agent（懒解析 + 记忆化）。 */
export function getAgent(role: AgentRole): ResolvedAgent {
  const hit = slots.get(role);
  if (hit) return hit;
  const ag = resolveAgentFor(loadBrainConfig(), role);
  slots.set(role, ag);
  return ag;
}

/** 只看不清：没种过返回 undefined（**不**触发解析）。用于「展示当前状态」这类不该有副作用的路径。 */
export function peekAgent(role: AgentRole): ResolvedAgent | undefined {
  return slots.get(role);
}

/** 启动时种入（runDaemon）：按给定配置把两个角色定下来。 */
export function seedSlots(cfg: BrainConfig | null = loadBrainConfig()): void {
  slots.set("brain", resolveAgentFor(cfg, "brain"));
  slots.set("worker", resolveAgentFor(cfg, "worker"));
}

/** 覆盖槽位（切换成功后才调用）。传 null 清掉缓存，下次 `getAgent` 重新解析。 */
export function setAgent(role: AgentRole, ag: ResolvedAgent | null): void {
  if (ag) slots.set(role, ag);
  else slots.delete(role);
}

/** 仅供测试：清空槽位，让下一次解析重新读环境变量与配置。 */
export function resetSlotsForTest(): void {
  slots.clear();
}
