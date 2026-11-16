import fs from "node:fs";
import path from "node:path";

import { accountDir } from "@wemind/wechat-ilink-core";

import { loadBrainConfig } from "../../agents/brain-config.js";
import { agentProblem, presetAvailable, resolveAgentByName } from "../../agents/brain-agents.js";
import {
  AGENT_DEFINITION_SCHEMA_VERSION,
  formatAgentDefinitionProblems,
  validateAgentDefinition,
  type AgentDefinition,
} from "../../agents/agent-definition.js";
import {
  agentsDir,
  brokenAgentDefinitionMessage,
  builtinDefinitionNames,
  findAgentDefinition,
  findAgentDefinitionSource,
  findBrokenAgentDefinition,
  getAgentRegistry,
} from "../../agents/agent-registry.js";
import { pickKey } from "../cli-context.js";

/**
 * `wemind agent`：agent 定义层的查看与校验。
 *
 * P1 只做 list / show / check（schema）。`spec` / `probe` / `add` / `remove` 分别在 P2 / P4。
 * 所有输出都落到一行一句，便于微信侧把同一段文本回给用户（后续接控制桥时不再写第二套文案）。
 */
const AGENT_USAGE = `用法：
  wemind agent list [--key <key|label>]        列出内置与本机定义、可用性与探测记录
  wemind agent show <name> [--explain] [--key <key|label>]
                                               查看最终生效值；--explain 打印每一层来源
  wemind agent check <name|文件.json>          校验数据面（schema + 文件名校验；不启动进程）`;

type AgentOpts = { key?: string; explain: boolean };

function takeOpt(rest: string[], flag: string): string | undefined {
  const i = rest.indexOf(flag);
  if (i < 0) return undefined;
  const v = rest[i + 1];
  if (v === undefined || v === "" || v.startsWith("--")) throw new Error(`${flag} 缺少参数值`);
  rest.splice(i, 2);
  return v;
}

function parseOpts(rest: string[]): AgentOpts {
  const key = takeOpt(rest, "--key");
  const explain = rest.includes("--explain");
  if (explain) rest.splice(rest.indexOf("--explain"), 1);
  const unknown = rest.filter((x) => x.startsWith("--"));
  if (unknown.length) throw new Error(`未知参数：${unknown.join(" ")}\n${AGENT_USAGE}`);
  return { key, explain };
}

function sourceLabel(agent: string): string {
  const source = findAgentDefinitionSource(agent);
  if (!source) return "（无有效定义）";
  return `${source.kind === "builtin" ? "内置" : "本机"}  ${source.file}`;
}

function orderedNames(): string[] {
  const registry = getAgentRegistry();
  const names = new Set<string>([
    ...builtinDefinitionNames(),
    ...Object.keys(registry.definitions),
    ...Object.keys(registry.broken),
  ]);
  const builtin = builtinDefinitionNames().filter((n) => names.has(n));
  const rest = [...names].filter((n) => !builtin.includes(n)).sort();
  return [...builtin, ...rest];
}

function listLine(
  name: string,
  width: number,
  opts: AgentOpts,
  cfg: ReturnType<typeof loadBrainConfig>,
): string[] {
  const broken = findBrokenAgentDefinition(name);
  if (broken) {
    const lines = [`${name.padEnd(width)}  本机    ❌  定义损坏`];
    lines.push(`  文件：${broken.file}`);
    lines.push(`  - ${formatAgentDefinitionProblems(broken.problems)[0]}`);
    lines.push(`  修复：改好或删掉该文件，再运行 wemind agent check ${name}`);
    return lines;
  }
  const source = findAgentDefinitionSource(name);
  const def = findAgentDefinition(name);
  const available = presetAvailable(name, cfg);
  const probe = def?.probe;
  const probeText = probe
    ? `${probe.at}${probe.agentVersion ? `（agent ${probe.agentVersion}）` : ""}`
    : "（未探测）";
  const lines = [
    `${name.padEnd(width)}  ${source?.kind === "local" ? "本机" : "内置"}    ${available ? "✅" : "❌"}  ${probeText}`,
  ];
  if (source?.kind === "local") lines.push(`  定义：${source.file}`);
  if (def?.adapter) lines.push(`  adapter：${def.adapter.module}（会执行代码）`);
  if (opts.key && !available) {
    const reason = agentProblem(resolveAgentByName(name, cfg));
    if (reason) lines.push(`  原因：${reason.split("\n")[0]}`);
  }
  return lines;
}

function cmdList(opts: AgentOpts): string {
  const dir = agentsDir();
  const registry = getAgentRegistry();
  const cfg = opts.key ? loadBrainConfig(accountDir(pickKey(opts.key))) : null;
  const names = orderedNames();
  const width = Math.max(4, ...names.map((n) => n.length)) + 2;
  const local = Object.values(registry.sources).filter((s) => s.kind === "local").length;
  const lines = [
    `agent 定义目录：${dir}${fs.existsSync(dir) ? "" : "（不存在）"}`,
    `内置 ${builtinDefinitionNames().length} 个；本机 ${local} 个；损坏 ${Object.keys(registry.broken).length} 个${opts.key ? `；可用性按账号 ${opts.key} 的启动覆盖判断` : ""}`,
  ];
  if (registry.dirError) lines.push(`⚠️ ${registry.dirError}`);
  lines.push("");
  for (const name of names) lines.push(...listLine(name, width, opts, cfg));
  lines.push("");
  lines.push("查看：wemind agent show <name> [--explain]；校验：wemind agent check <name|文件>");
  return lines.join("\n");
}

function effectiveLines(ag: ReturnType<typeof resolveAgentByName>): string[] {
  return [
    `  bin=${ag.bin}`,
    `  binPath=${ag.binPath ?? "(未找到)"}`,
    `  args=[${ag.args.join(" ")}]`,
    `  shell=${ag.shell}  homeEnvVar=${ag.homeEnvVar ?? "(无)"}`,
    `  realHome=${ag.realHome ?? "(无)"}  configSubdir=${ag.configSubdir || "(根)"}`,
    `  mcpFormat=${ag.mcpFormat}  mcpDelivery=${ag.mcpDelivery}  acpMcpServers=${ag.acpMcpServers}`,
    `  restore=${ag.restore ?? "(新建)"}  replayOnLoad=${ag.replayOnLoad}  images=${ag.images}`,
    `  model=${ag.model ?? "(agent 默认)"}  sessionMode=${ag.sessionMode ?? "(无)"}`,
    `  inheritDirs=[${ag.inheritDirs.join(" ")}]  requiresBins=[${ag.requiresBins.join(" ")}]`,
  ];
}

function definitionText(def: AgentDefinition): string {
  const { notes, ...rest } = def;
  const lines = [JSON.stringify(rest, null, 2)];
  if (notes?.length) {
    lines.push("", "说明：");
    for (const note of notes) lines.push(`  - ${note}`);
  }
  return lines.join("\n");
}

function explainText(
  name: string,
  ag: ReturnType<typeof resolveAgentByName>,
  cfg: ReturnType<typeof loadBrainConfig>,
): string[] {
  const registry = getAgentRegistry();
  const local = findAgentDefinitionSource(name);
  const builtinFile = `definitions/${name}.json`;
  const isBuiltin = builtinDefinitionNames().includes(name);
  const builtinShadowed = isBuiltin && local?.kind === "local";
  const lines = [
    "",
    "来源链（优先级从低到高，同名整条替换、不做字段合并）：",
    `  1. 内置：${isBuiltin ? (builtinShadowed ? `${builtinFile}（被本机定义整条覆盖）` : builtinFile) : "（无）"}`,
    `  2. 本机：${local?.kind === "local" ? local.file : "（无）"}`,
  ];
  if (cfg) {
    const top = [
      cfg.bin ? `bin=${cfg.bin}` : "",
      cfg.args ? `args=[${cfg.args.join(" ")}]` : "",
      cfg.extraArgs ? `extraArgs=[${cfg.extraArgs.join(" ")}]` : "",
      cfg.shell !== undefined ? `shell=${cfg.shell}` : "",
      cfg.homeEnvVar ? `homeEnvVar=${cfg.homeEnvVar}` : "",
      cfg.model ? `model=${cfg.model}` : "",
    ].filter(Boolean);
    const preset = cfg.presets?.[name];
    lines.push(
      `  3. brain.json：agent=${cfg.agent}${top.length ? `；本段覆盖 ${top.join(" ")}` : ""}${preset ? `；presets.${name}=${JSON.stringify(preset)}` : ""}`,
    );
  } else {
    lines.push("  3. brain.json：（未指定 --key，未读取账号配置）");
  }
  const env = [
    "WEMIND_BRAIN",
    "WEMIND_BRAIN_BIN",
    "WEMIND_BRAIN_ARGS",
    "WEMIND_BRAIN_EXTRA_ARGS",
    "WEMIND_BRAIN_SHELL",
    "WEMIND_BRAIN_HOME_ENV",
    "WEMIND_BRAIN_REAL_HOME",
    "WEMIND_BRAIN_INHERIT_DIRS",
    "WEMIND_ACP_SESSION_MODE",
    ...(name === "kiro" ? ["KIRO_CLI_BIN"] : []),
  ]
    .filter((k) => process.env[k] !== undefined && process.env[k] !== "")
    .map((k) => `${k}=${process.env[k]}`);
  lines.push(`  4. 环境变量：${env.length ? env.join("；") : "（无）"}`);
  lines.push("", "生效值：");
  lines.push(...effectiveLines(ag));
  const def = findAgentDefinition(name);
  if (def) lines.push("", "定义本体（数据面）：", definitionText(def));
  if (registry.dirError) lines.push("", `⚠️ ${registry.dirError}`);
  return lines;
}

function cmdShow(name: string | undefined, opts: AgentOpts): string {
  if (!name) throw new Error(`需要 agent 名\n${AGENT_USAGE}`);
  const key = name.trim().toLowerCase();
  const broken = findBrokenAgentDefinition(key);
  if (broken) {
    process.exitCode = 1;
    return `❌ ${brokenAgentDefinitionMessage(broken)}`;
  }
  const def = findAgentDefinition(key);
  if (!def) {
    process.exitCode = 1;
    return `❌ 未知 agent「${name}」。可用：${orderedNames().join("、")}\n（本机定义目录：${agentsDir()}）`;
  }
  const cfg = opts.key ? loadBrainConfig(accountDir(pickKey(opts.key))) : null;
  const dataDir = opts.key ? accountDir(pickKey(opts.key)) : undefined;
  const ag = resolveAgentByName(key, cfg, dataDir);
  const problem = agentProblem(ag);
  const lines = [
    `agent：${key}`,
    `定义：${sourceLabel(key)}`,
    `可用：${problem ? `❌ ${problem}` : `✅ ${ag.binPath ?? ag.bin}`}`,
    "",
    "最终生效：",
    ...effectiveLines(ag),
  ];
  if (def.adapter) lines.push("", `adapter：${def.adapter.module}（会执行代码）`);
  if (def.probe)
    lines.push(
      "",
      `探测：${def.probe.at}${def.probe.agentVersion ? `（agent ${def.probe.agentVersion}）` : ""}`,
    );
  if (def.notes?.length) {
    lines.push("", "说明：");
    for (const note of def.notes) lines.push(`  - ${note}`);
  }
  if (opts.explain) lines.push(...explainText(key, ag, cfg));
  return lines.join("\n");
}

function looksLikeFile(arg: string): boolean {
  return (
    fs.existsSync(arg) ||
    arg.toLowerCase().endsWith(".json") ||
    arg.includes("/") ||
    arg.includes("\\")
  );
}

function checkFile(file: string): string {
  const abs = path.resolve(file);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(abs, "utf-8").replace(/^\uFEFF/, ""));
  } catch (e) {
    process.exitCode = 1;
    return `❌ 读不了或不是有效 JSON：${abs}\n  ${e instanceof Error ? e.message : String(e)}`;
  }
  const result = validateAgentDefinition(raw);
  if (!result.ok) {
    process.exitCode = 1;
    return [
      `❌ 定义不合法：${abs}`,
      ...formatAgentDefinitionProblems(result.problems).map((p) => `  - ${p}`),
    ].join("\n");
  }
  const def = result.value;
  const base = path.basename(abs);
  if (!base.toLowerCase().endsWith(".json")) {
    process.exitCode = 1;
    return `❌ 定义文件必须以 .json 结尾：${abs}`;
  }
  const stem = base.slice(0, -".json".length);
  const expected = `${def.name}.json`;
  if (stem !== def.name) {
    const inAgentsDir = path.resolve(agentsDir()) === path.dirname(abs);
    const msg = `文件名是「${base}」，定义里的 name 是「${def.name}」——安装到 ${agentsDir()} 时必须命名为 ${expected}`;
    if (inAgentsDir) {
      process.exitCode = 1;
      return `❌ ${msg}`;
    }
    return `✅ 数据面有效（schemaVersion ${AGENT_DEFINITION_SCHEMA_VERSION}）：${abs}\n⚠️ ${msg}`;
  }
  return `✅ 数据面有效（schemaVersion ${AGENT_DEFINITION_SCHEMA_VERSION}）：${abs}\n  name=${def.name}  bin=${def.bin}  args=[${def.args.join(" ")}]`;
}

function checkName(name: string): string {
  const key = name.trim().toLowerCase();
  const broken = findBrokenAgentDefinition(key);
  if (broken) {
    process.exitCode = 1;
    return `❌ ${brokenAgentDefinitionMessage(broken)}`;
  }
  const def = findAgentDefinition(key);
  if (!def) {
    process.exitCode = 1;
    return `❌ 未知 agent「${name}」。可用：${orderedNames().join("、")}\n（本机定义目录：${agentsDir()}）`;
  }
  return [
    `✅ 数据面有效（schemaVersion ${AGENT_DEFINITION_SCHEMA_VERSION}）：${sourceLabel(key)}`,
    `  name=${def.name}  bin=${def.bin}  args=[${def.args.join(" ")}]`,
    "说明：这里只校验数据面；ACP 握手自检用 `wemind brain check`（对当前大脑）或后续版本的 `agent check --deep`。",
  ].join("\n");
}

export function cmdAgent(rest: string[]): string {
  const sub = (rest.shift() ?? "list").toLowerCase();
  if (sub === "help" || sub === "--help" || sub === "-h") return AGENT_USAGE;
  const opts = parseOpts(rest);
  const pos = rest.filter((x) => !x.startsWith("--"));
  if (sub === "list") {
    if (pos.length) throw new Error(`list 不接受位置参数：${pos.join(" ")}`);
    return cmdList(opts);
  }
  if (sub === "show") return cmdShow(pos[0], opts);
  if (sub === "check") {
    if (!pos[0]) throw new Error(`需要 agent 名或定义文件\n${AGENT_USAGE}`);
    const known =
      findAgentDefinition(pos[0]) !== undefined || findBrokenAgentDefinition(pos[0]) !== undefined;
    return !known && looksLikeFile(pos[0]) ? checkFile(pos[0]) : checkName(pos[0]);
  }
  throw new Error(`未知 agent 子命令「${sub}」\n${AGENT_USAGE}`);
}

export { AGENT_USAGE };
