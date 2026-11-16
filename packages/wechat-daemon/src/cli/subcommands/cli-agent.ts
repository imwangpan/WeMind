import fs from "node:fs";
import path from "node:path";

import { accountDir } from "@wemind/wechat-ilink-core";

import { checkAgent } from "../../acp/brain-check.js";
import { draftFromProbe, probeAgent, type AgentProbeResult } from "../../acp/agent-probe.js";
import { agentSpecJson, agentSpecMarkdown } from "../../agents/agent-spec.js";
import { preloadAgentAdapterForDefinition } from "../../agents/agent-adapter-loader.js";
import { loadBrainConfig } from "../../agents/brain-config.js";
import {
  ACP_AGENT_PRESETS,
  agentProblem,
  presetAvailable,
  resolveAgentByName,
  resolveAgentFromDefinition,
} from "../../agents/brain-agents.js";
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
import { installAgentPackage, removeAgentDefinition } from "../../agents/agent-install.js";

/**
 * `wemind agent`：agent 定义层的查看、探测与校验。
 *
 * 输出都落到一行一句，便于微信侧把同一段文本回给用户（后续接控制桥时不再写第二套文案）。
 * `probe` 与 `check` 默认会起进程；`check --schema` 是编辑草稿时的快速通道，不 spawn。
 */
const AGENT_USAGE = `用法：
  wemind agent list [--key <key|label>]        列出内置与本机定义、可用性与探测记录
  wemind agent show <name> [--explain] [--key <key|label>]
                                               查看最终生效值；--explain 打印每一层来源
  wemind agent spec [--json]                   规格、字段说明、正反例与校验方式
  wemind agent probe <bin> [--args <JSON数组|空格分隔>] [--shell] [--draft] [--deep] [--json]
                                               探测 ACP 能力；--draft 输出定义草稿，--json 输出完整结果
                                               Windows 的 .cmd/.bat 自动经 shell
  wemind agent check <name|文件.json> [--schema] [--deep]
                                               校验 schema + 真实 ACP 握手；--schema 不启动进程
  wemind agent add <包目录|package.json|定义.json>
                                               复制安装定义（可选 adapter）；运行期不联网
  wemind agent remove <name>                   移除本机/数据包定义（同名内置恢复）`;

type AgentOpts = {
  key?: string;
  explain: boolean;
  json: boolean;
  draft: boolean;
  deep: boolean;
  schemaOnly: boolean;
  args?: string[];
  name?: string;
  shell?: boolean;
  timeoutMs?: number;
  home?: string;
  homeEnv?: string;
  cwd?: string;
  prompt?: string;
  second?: string;
  toolPrompt?: string;
  image: boolean;
  tool: boolean;
  testMcp: boolean;
  mcp?: unknown[];
  sessionMeta?: unknown;
  model?: string;
  reasoning?: string;
  keep: boolean;
  hardKill: boolean;
  rejectPermissions: boolean;
};

function takeValue(rest: string[], i: number, flag: string): string {
  const value = rest[i + 1];
  if (value === undefined || value === "" || value.startsWith("--"))
    throw new Error(`${flag} 缺少参数值`);
  return value;
}

function splitArgs(value: string): string[] {
  if (value.trim().startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch (e) {
      throw new Error(`--args 不是有效 JSON：${e instanceof Error ? e.message : String(e)}`);
    }
    if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== "string"))
      throw new Error("--args 必须是字符串数组（如 '[\"--acp\"]'）");
    return parsed;
  }
  return (value.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((x) =>
    (x.startsWith('"') && x.endsWith('"')) || (x.startsWith("'") && x.endsWith("'"))
      ? x.slice(1, -1)
      : x,
  );
}

function parseJsonValue(value: string, flag: string): unknown {
  try {
    return JSON.parse(value);
  } catch (e) {
    throw new Error(`${flag} 不是有效 JSON：${e instanceof Error ? e.message : String(e)}`);
  }
}

function parseOpts(rest: string[]): { opts: AgentOpts; pos: string[] } {
  const opts: AgentOpts = {
    explain: false,
    json: false,
    draft: false,
    deep: false,
    schemaOnly: false,
    image: false,
    tool: false,
    testMcp: true,
    keep: false,
    hardKill: false,
    rejectPermissions: false,
  };
  const pos: string[] = [];
  for (let i = 0; i < rest.length; ) {
    const arg = rest[i];
    if (!arg.startsWith("--")) {
      pos.push(arg);
      i++;
      continue;
    }
    switch (arg) {
      case "--key":
        opts.key = takeValue(rest, i, arg);
        i += 2;
        break;
      case "--explain":
        opts.explain = true;
        i++;
        break;
      case "--json":
        opts.json = true;
        i++;
        break;
      case "--draft":
        opts.draft = true;
        i++;
        break;
      case "--deep":
        opts.deep = true;
        i++;
        break;
      case "--schema":
        opts.schemaOnly = true;
        i++;
        break;
      case "--image":
        opts.image = true;
        i++;
        break;
      case "--tool":
        opts.tool = true;
        i++;
        break;
      case "--no-mcp-test":
        opts.testMcp = false;
        i++;
        break;
      case "--keep":
        opts.keep = true;
        i++;
        break;
      case "--hard-kill":
        opts.hardKill = true;
        i++;
        break;
      case "--reject-permissions":
        opts.rejectPermissions = true;
        i++;
        break;
      case "--args":
        opts.args = splitArgs(takeValue(rest, i, arg));
        i += 2;
        break;
      case "--name":
        opts.name = takeValue(rest, i, arg);
        i += 2;
        break;
      case "--shell":
        opts.shell = true;
        i++;
        break;
      case "--timeout": {
        const value = Number(takeValue(rest, i, arg));
        if (!Number.isInteger(value) || value <= 0) throw new Error("--timeout 应为正整数（毫秒）");
        opts.timeoutMs = value;
        i += 2;
        break;
      }
      case "--home":
        opts.home = takeValue(rest, i, arg);
        i += 2;
        break;
      case "--home-env":
        opts.homeEnv = takeValue(rest, i, arg);
        i += 2;
        break;
      case "--cwd":
        opts.cwd = takeValue(rest, i, arg);
        i += 2;
        break;
      case "--prompt":
        opts.prompt = takeValue(rest, i, arg);
        i += 2;
        break;
      case "--second":
        opts.second = takeValue(rest, i, arg);
        i += 2;
        break;
      case "--tool-prompt":
        opts.toolPrompt = takeValue(rest, i, arg);
        i += 2;
        break;
      case "--model":
        opts.model = takeValue(rest, i, arg);
        i += 2;
        break;
      case "--reasoning":
        opts.reasoning = takeValue(rest, i, arg);
        i += 2;
        break;
      case "--mcp": {
        const value = parseJsonValue(takeValue(rest, i, arg), arg);
        if (!Array.isArray(value)) throw new Error("--mcp 必须是 JSON 数组");
        opts.mcp = value;
        i += 2;
        break;
      }
      case "--session-meta":
        opts.sessionMeta = parseJsonValue(takeValue(rest, i, arg), arg);
        i += 2;
        break;
      default:
        throw new Error(`未知参数：${arg}\n${AGENT_USAGE}`);
    }
  }
  return { opts, pos };
}

function sourceLabel(agent: string): string {
  const source = findAgentDefinitionSource(agent);
  if (!source) return "（无有效定义）";
  const kind = source.kind === "builtin" ? "内置" : source.kind === "package" ? "数据包" : "本机";
  return `${kind}  ${source.file}`;
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
    `${name.padEnd(width)}  ${source?.kind === "package" ? "数据包" : source?.kind === "local" ? "本机" : "内置"}    ${available ? "✅" : "❌"}  ${probeText}`,
  ];
  if (source && source.kind !== "builtin") lines.push(`  定义：${source.file}`);
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
  const local = Object.values(registry.sources).filter((s) => s.kind !== "builtin").length;
  const lines = [
    `agent 定义目录：${dir}${fs.existsSync(dir) ? "" : "（不存在）"}`,
    `内置 ${builtinDefinitionNames().length} 个；本机/数据包 ${local} 个；损坏 ${Object.keys(registry.broken).length} 个${opts.key ? `；可用性按账号 ${opts.key} 的启动覆盖判断` : ""}`,
  ];
  if (registry.dirError) lines.push(`⚠️ ${registry.dirError}`);
  lines.push("");
  for (const name of names) lines.push(...listLine(name, width, opts, cfg));
  lines.push("");
  lines.push(
    "查看：wemind agent show <name> [--explain]；规格：wemind agent spec；校验：wemind agent check <name|文件>",
  );
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
  const def = findAgentDefinition(name);
  const local = findAgentDefinitionSource(name);
  const builtinFile = `definitions/${name}.json`;
  const isBuiltin = builtinDefinitionNames().includes(name);
  const builtinShadowed = isBuiltin && local !== undefined && local.kind !== "builtin";
  const lines = [
    "",
    "来源链（优先级从低到高，同名整条替换、不做字段合并）：",
    `  1. 内置：${isBuiltin ? (builtinShadowed ? `${builtinFile}（被本机定义整条覆盖）` : builtinFile) : "（无）"}`,
    `  2. 本机/数据包：${local && local.kind !== "builtin" ? `${local.kind === "package" ? "数据包" : "本机"} ${local.file}` : "（无）"}`,
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
    ...(ACP_AGENT_PRESETS[name]?.hooks?.env?.binOverrideNames ?? []),
  ]
    .filter((k) => process.env[k] !== undefined && process.env[k] !== "")
    .map((k) => `${k}=${process.env[k]}`);
  lines.push(`  4. 环境变量：${env.length ? env.join("；") : "（无）"}`);
  lines.push("", "生效值：");
  lines.push(...effectiveLines(ag));
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
  if (def.adapter)
    lines.push(
      "",
      `adapter：${def.adapter.module}（会执行代码${ag.adapterSource && ag.adapterSource !== def.adapter.module ? `；实际来源 ${ag.adapterSource}` : ""}）`,
    );
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

type ReadDefinitionResult =
  | { ok: true; abs: string; def: AgentDefinition; warning?: string }
  | { ok: false; abs: string; text: string };

function readDefinitionFile(file: string): ReadDefinitionResult {
  const abs = path.resolve(file);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(abs, "utf-8").replace(/^\uFEFF/, ""));
  } catch (e) {
    return {
      ok: false,
      abs,
      text: `❌ 读不了或不是有效 JSON：${abs}\n  ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const result = validateAgentDefinition(raw);
  if (!result.ok) {
    return {
      ok: false,
      abs,
      text: [
        `❌ 定义不合法：${abs}`,
        ...formatAgentDefinitionProblems(result.problems).map((p) => `  - ${p}`),
      ].join("\n"),
    };
  }
  const def = result.value;
  const base = path.basename(abs);
  if (!base.toLowerCase().endsWith(".json")) {
    return { ok: false, abs, text: `❌ 定义文件必须以 .json 结尾：${abs}` };
  }
  const stem = base.slice(0, -".json".length);
  const expected = `${def.name}.json`;
  if (stem !== def.name) {
    const inAgentsDir = path.resolve(agentsDir()) === path.dirname(abs);
    const msg = `文件名是「${base}」，定义里的 name 是「${def.name}」——安装到 ${agentsDir()} 时必须命名为 ${expected}`;
    if (inAgentsDir) return { ok: false, abs, text: `❌ ${msg}` };
    return { ok: true, abs, def, warning: msg };
  }
  return { ok: true, abs, def };
}

async function runHandshake(
  ag: ReturnType<typeof resolveAgentFromDefinition>,
  label: string,
  opts: AgentOpts,
): Promise<{ ok: boolean; text: string }> {
  const problem = agentProblem(ag);
  if (problem) return { ok: false, text: `❌ ${label}：${problem}` };
  const result = await checkAgent(ag, opts.timeoutMs, {
    deep: opts.deep,
  });
  return {
    ok: result.ok,
    text: `${result.ok ? "✅" : "❌"} ${label}：${result.detail}（${result.ms}ms）`,
  };
}

async function checkFile(file: string, opts: AgentOpts): Promise<string> {
  const read = readDefinitionFile(file);
  if (!read.ok) {
    process.exitCode = 1;
    return read.text;
  }
  const warning = read.warning ? `⚠️ ${read.warning}\n` : "";
  if (opts.schemaOnly) {
    return [
      `${warning}✅ 数据面有效（schemaVersion ${AGENT_DEFINITION_SCHEMA_VERSION}）：${read.abs}`,
      `  name=${read.def.name}  bin=${read.def.bin}  args=[${read.def.args.join(" ")}]`,
    ].join("\n");
  }
  let ag: ReturnType<typeof resolveAgentFromDefinition>;
  try {
    if (read.def.adapter) {
      const loaded = await preloadAgentAdapterForDefinition(read.def, read.abs);
      if (!loaded.ok) {
        process.exitCode = 1;
        return `${warning}❌ ${loaded.error}`;
      }
    }
    ag = resolveAgentFromDefinition(read.def, { definitionFile: read.abs });
  } catch (e) {
    process.exitCode = 1;
    return `${warning}❌ 定义无法解析：${e instanceof Error ? e.message : String(e)}`;
  }
  const result = await runHandshake(ag, `定义 ${read.abs}`, opts);
  if (!result.ok) process.exitCode = 1;
  return warning + result.text;
}

async function checkName(name: string, opts: AgentOpts): Promise<string> {
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
  if (opts.schemaOnly) {
    return [
      `✅ 数据面有效（schemaVersion ${AGENT_DEFINITION_SCHEMA_VERSION}）：${sourceLabel(key)}`,
      `  name=${def.name}  bin=${def.bin}  args=[${def.args.join(" ")}]`,
    ].join("\n");
  }
  let ag: ReturnType<typeof resolveAgentFromDefinition>;
  try {
    const source = findAgentDefinitionSource(key);
    if (def.adapter) {
      const file = source?.kind === "builtin" ? "" : (source?.file ?? "");
      const loaded = await preloadAgentAdapterForDefinition(def, file);
      if (!loaded.ok) {
        process.exitCode = 1;
        return `❌ ${loaded.error}`;
      }
    }
    const resolveOpts = source && source.kind !== "builtin" ? { definitionFile: source.file } : {};
    ag = resolveAgentFromDefinition(def, resolveOpts);
  } catch (e) {
    process.exitCode = 1;
    return `❌ 定义无法解析：${e instanceof Error ? e.message : String(e)}`;
  }
  const result = await runHandshake(ag, `agent ${key}（${sourceLabel(key)}）`, opts);
  if (!result.ok) process.exitCode = 1;
  return result.text;
}

function probeSummary(r: AgentProbeResult): string[] {
  const lines = [
    `agent probe：${r.ok ? "✅" : "❌"} ${r.bin} ${r.args.length ? `args=[${r.args.join(" ")}]` : "（无 args）"}`,
    `  cwd=${r.cwd}${r.homeEnv ? `  ${r.homeEnv}` : ""}`,
    `  initialize：loadSession=${r.declared.loadSession} resume=${r.declared.resume} image声明=${r.declared.images}`,
    `  session/new：${r.sessionId ? `ok sessionId=${r.sessionId}` : "失败"}`,
  ];
  if (r.sessionModes.length) lines.push(`  模式候选：${r.sessionModes.join("、")}`);
  if (r.configOptions.length)
    lines.push(
      `  configOptions：${r.configOptions
        .map((o: any) => String(o?.id ?? "?"))
        .filter(Boolean)
        .join("、")}`,
    );
  if (r.mcpServers.tested) {
    lines.push(
      `  ACP mcpServers：${r.mcpServers.accepted === true ? "接受（不代表实际加载）" : r.mcpServers.accepted === false ? "拒绝" : "未完成"}`,
    );
  } else {
    lines.push("  ACP mcpServers：未测试");
  }
  if (r.restore.used) lines.push(`  会话恢复：${r.restore.used}`);
  else {
    const errors = [r.restore.load?.error, r.restore.resume?.error].filter(Boolean);
    lines.push(`  会话恢复：失败${errors.length ? `（${errors[0]}）` : ""}`);
  }
  if (r.deep?.prompt1) {
    lines.push(
      `  prompt1：${r.deep.prompt1.ok ? "成功" : "失败"} firstFrame=${r.deep.prompt1.firstFrameMs ?? "?"}ms answer=${JSON.stringify(r.deep.prompt1.answer.slice(0, 80))}`,
    );
  }
  if (r.deep?.image)
    lines.push(
      `  图片：${r.deep.image.ok ? "接受" : `拒绝/失败（${r.deep.image.error ?? "无文本"}）`}`,
    );
  if (r.deep?.tool)
    lines.push(
      `  工具：${r.deep.tool.ok ? "成功" : "失败"} permission=${r.deep.tool.permissionRequests} fileWritten=${r.deep.tool.fileWritten}`,
    );
  if (r.deep?.prompt2)
    lines.push(
      `  prompt2：${r.deep.prompt2.ok ? "成功" : "失败"} contextKept=${r.deep.contextKept === true} replayFrames=${r.restore.replayFrames ?? 0}`,
    );
  if (r.reverseRequests.length)
    lines.push(`  反向请求：${[...new Set(r.reverseRequests)].join("、")}`);
  if (r.fatal) lines.push(`  fatal：${r.fatal}`);
  lines.push("");
  lines.push(
    r.ok
      ? "下一步：wemind agent probe ... --draft 产草稿；补领域字段后用 wemind agent check <文件> 验握手。"
      : "先修上面的失败项；没有真实 prompt 的结果不能当作完整适配。",
  );
  return lines;
}

async function cmdProbe(pos: string[], opts: AgentOpts): Promise<string> {
  const bin = pos[0];
  if (!bin) throw new Error(`需要二进制名或路径\n${AGENT_USAGE}`);
  if (pos.length > 1) throw new Error(`probe 只接受一个二进制参数：${pos.slice(1).join(" ")}`);
  if (!opts.deep && (opts.image || opts.tool || opts.prompt || opts.second || opts.toolPrompt)) {
    throw new Error(
      `--image / --tool / --prompt / --second / --tool-prompt 需要同时加 --deep（会发真实 prompt、可能产生费用）\n${AGENT_USAGE}`,
    );
  }
  const result = await probeAgent({
    bin,
    args: opts.args ?? [],
    ...(opts.shell !== undefined ? { shell: opts.shell } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.home ? { home: opts.home } : {}),
    ...(opts.homeEnv ? { homeEnv: opts.homeEnv } : {}),
    ...(opts.deep ? { deep: true } : {}),
    ...(opts.image ? { image: true } : {}),
    ...(opts.tool ? { tool: true } : {}),
    ...(opts.prompt ? { prompt: opts.prompt } : {}),
    ...(opts.second ? { secondPrompt: opts.second } : {}),
    ...(opts.toolPrompt ? { toolPrompt: opts.toolPrompt } : {}),
    ...(opts.mcp ? { mcpServers: opts.mcp } : {}),
    ...(opts.sessionMeta !== undefined ? { sessionMeta: opts.sessionMeta } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.keep ? { keep: true } : {}),
    ...(opts.hardKill ? { hardKill: true } : {}),
    ...(opts.rejectPermissions ? { rejectPermissions: true } : {}),
    testMcp: opts.testMcp,
    onLog: (line) => process.stderr.write(`[wemind agent probe] ${line}\n`),
  });
  if (!result.ok) process.exitCode = 1;
  if (opts.draft) {
    if (result.fatal) return `❌ 探测失败，未生成草稿：${result.fatal}`;
    const draft = draftFromProbe(result, opts.name ? { name: opts.name } : {});
    const validation = validateAgentDefinition(draft);
    if (!validation.ok)
      return [
        "❌ 探针结论无法生成合法草稿：",
        ...formatAgentDefinitionProblems(validation.problems).map((p) => `  - ${p}`),
      ].join("\n");
    return JSON.stringify(validation.value, null, 2);
  }
  if (opts.json) return JSON.stringify(result, null, 2);
  return probeSummary(result).join("\n");
}

export async function cmdAgent(rest: string[]): Promise<string> {
  const sub = (rest.shift() ?? "list").toLowerCase();
  if (sub === "help" || sub === "--help" || sub === "-h") return AGENT_USAGE;
  const { opts, pos } = parseOpts(rest);
  if (sub === "list") {
    if (pos.length) throw new Error(`list 不接受位置参数：${pos.join(" ")}`);
    return cmdList(opts);
  }
  if (sub === "show") return cmdShow(pos[0], opts);
  if (sub === "spec") {
    if (pos.length) throw new Error(`spec 不接受位置参数：${pos.join(" ")}`);
    return opts.json ? JSON.stringify(agentSpecJson(), null, 2) : agentSpecMarkdown();
  }
  if (sub === "probe") return cmdProbe(pos, opts);
  if (sub === "check") {
    if (!pos[0]) throw new Error(`需要 agent 名或定义文件\n${AGENT_USAGE}`);
    if (pos.length > 1) throw new Error(`check 只接受一个名字或文件：${pos.slice(1).join(" ")}`);
    const known =
      findAgentDefinition(pos[0]) !== undefined || findBrokenAgentDefinition(pos[0]) !== undefined;
    return !known && looksLikeFile(pos[0]) ? checkFile(pos[0], opts) : checkName(pos[0], opts);
  }
  if (sub === "add") {
    if (!pos[0]) throw new Error(`需要包目录、package.json 或定义文件\n${AGENT_USAGE}`);
    if (pos.length > 1) throw new Error(`add 只接受一个来源：${pos.slice(1).join(" ")}`);
    const result = await installAgentPackage(pos[0]);
    if (!result.ok) process.exitCode = 1;
    return result.text;
  }
  if (sub === "remove") {
    if (!pos[0]) throw new Error(`需要 agent 名\n${AGENT_USAGE}`);
    if (pos.length > 1) throw new Error(`remove 只接受一个 agent 名：${pos.slice(1).join(" ")}`);
    const result = removeAgentDefinition(pos[0]);
    if (!result.ok) process.exitCode = 1;
    return result.text;
  }
  throw new Error(`未知 agent 子命令「${sub}」\n${AGENT_USAGE}`);
}

export { AGENT_USAGE };
