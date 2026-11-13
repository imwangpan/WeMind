import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { accountDir } from "@wemind/wechat-ilink-core";

import { loadBrainConfig } from "../../agents/brain-config.js";
import { resolveAgentFor } from "../../agents/brain-agents.js";
import { ACP_AGENT_PRESETS } from "../../agents/brain-presets.js";
import {
  configFileFormat,
  getConfigPath,
  mutateConfigFile,
  parseCliValue,
  readConfigObject,
  resolveAgentConfigFileByName,
} from "../../agents/config/agent-config-writer.js";
import {
  captureEnvSnapshot,
  clearEnvSnapshot,
  envSnapshotPath,
  readEnvSnapshot,
  writeEnvSnapshot,
} from "../../agents/config/env-snapshot.js";
import {
  homeModeDescription,
  homeModePath,
  readHomeMode,
  writeHomeMode,
  normalizeHomeMode,
  type HomeMode,
} from "../../agents/config/home-mode.js";
import { overlayPath, readOverlay, writeOverlay } from "../../agents/config/overlay.js";
import {
  defaultWorkspacePath,
  loadWorkspaceConfig,
  resolveWorkspace,
  updateWorkspace,
  WORKSPACE_CHANGE_NOTICE,
} from "../../agents/config/workspace.js";
import { addMcp, catalogNames, loadActive, removeMcp } from "../../agents/sandbox/mcp-sandbox.js";
import { bridgeReady, pickKey, viaBridge } from "../cli-context.js";

type Opts = { key?: string; file?: string; role?: "brain" | "worker" };

function takeOpt(rest: string[], flag: string): string | undefined {
  const i = rest.indexOf(flag);
  if (i < 0) return undefined;
  const v = rest[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`${flag} 缺少参数值`);
  rest.splice(i, 2);
  return v;
}

function parseOpts(rest: string[]): Opts {
  const opts: Opts = {};
  opts.key = takeOpt(rest, "--key");
  opts.file = takeOpt(rest, "--file");
  const role = takeOpt(rest, "--role");
  if (role && role !== "brain" && role !== "worker")
    throw new Error("--role 只能是 brain 或 worker");
  if (role === "brain" || role === "worker") opts.role = role;
  return opts;
}

function openEditor(file: string): void {
  const editor =
    process.env.VISUAL?.trim() ||
    process.env.EDITOR?.trim() ||
    (process.platform === "win32" ? "notepad" : "vi");
  if (!fs.existsSync(file)) fs.writeFileSync(file, "{}\n", "utf-8");
  const argv = editor.split(/\s+/).filter(Boolean);
  const r = spawnSync(argv[0], [...argv.slice(1), file], { stdio: "inherit", shell: false });
  if (r.error) throw new Error(`无法启动编辑器「${editor}」：${r.error.message}`);
  if (r.status !== 0) throw new Error(`编辑器退出码 ${r.status ?? "unknown"}`);
}

function jsonText(value: unknown): string {
  return value === undefined ? "（未设置）" : JSON.stringify(value, null, 2);
}

function showConfig(dir: string, key: string): string {
  const cfg = loadBrainConfig(dir);
  const mode = readHomeMode(dir);
  const brain = cfg?.agent ?? "auto";
  const worker = cfg?.worker?.agent ?? brain;
  const ws = loadWorkspaceConfig(dir);
  const brainWs = resolveWorkspace("brain", dir);
  const workerWs = resolveWorkspace("worker", dir);
  const env = readEnvSnapshot(dir);
  const lines = [
    `账号 ${key}`,
    `homeMode：${mode} — ${homeModeDescription(mode)}`,
    "说明：direct 不写 Agent 配置；需要账号隔离时切 sandbox。",
    `runtime.json：${homeModePath(dir)}`,
    `brain：${brain}；worker：${worker}`,
    `brain realHome：${realHomeOf(brain)}`,
    `brain 工作区：${brainWs.mode} ${brainWs.path}${brainWs.problem ? `（${brainWs.problem}）` : ""}`,
    `worker 工作区：${workerWs.mode} ${workerWs.path}${workerWs.problem ? `（${workerWs.problem}）` : ""}`,
    `workspace.json：${path.join(dir, "workspace.json")}${ws.problem ? `（${ws.problem}）` : ""}`,
    `overlay：${path.join(dir, "agent-overrides")}`,
    `env.json：${Object.keys(env).length ? Object.keys(env).join(", ") : "（未捕获，继承 daemon 环境）"}`,
    `brain MCP 激活集：${path.join(dir, "brain-mcps.json")}`,
  ];
  return lines.join("\n");
}

function realHomeOf(agent: string): string {
  const key = agent.toLowerCase();
  if (key === "auto") return "（自动探测）";
  const preset = ACP_AGENT_PRESETS[key];
  if (!preset) return "（未知 agent）";
  return (
    process.env.WEMIND_BRAIN_REAL_HOME?.trim() ||
    process.env.WECHAT_REAL_KIRO_HOME?.trim() ||
    preset.realHome ||
    "（无）"
  );
}

async function cmdOverlay(rest: string[], opts: Opts, dir: string, agent: string): Promise<string> {
  const sub = (rest.shift() ?? "show").toLowerCase();
  const read = readOverlay(agent, dir);
  if (read.problems.length) throw new Error(read.problems.join("；"));
  if (sub === "show") {
    return [
      `agent：${agent}`,
      `overlay：${overlayPath(agent, dir)}`,
      jsonText(read.overlay),
      "提示：微信侧 overlay 只支持 mcp.disable / mcp.extra（会话级、不落盘）。修改 Agent 真实配置用 `wemind config agent ...`；默认改真实配置，只有明确说“微信侧/仅微信”时才用 overlay。",
    ].join("\n");
  }
  if (sub === "edit") {
    openEditor(overlayPath(agent, dir));
    return `已关闭编辑器。overlay：${overlayPath(agent, dir)}\n下一条新会话生效（当前会话不热改）。`;
  }
  throw new Error(
    "微信侧 overlay 只支持 mcp.disable / mcp.extra：用 `config wechat edit <agent>` 直接编辑；" +
      "要改 Agent 配置请用 `config agent ...`（默认改真实配置）。",
  );
}

function cmdRealAgent(rest: string[], opts: Opts, dir: string, agent: string): string {
  const sub = (rest.shift() ?? "show").toLowerCase();
  const file = resolveAgentConfigFileByName(agent, opts.file);
  if (sub === "show") {
    return [
      `agent：${agent}`,
      `真实配置：${file}`,
      `格式：${configFileFormat(file)}`,
      "提示：这里直接改 Agent 真实配置，微信侧与终端共用；只有明确说“微信侧/仅微信”时才用 `config wechat`。",
    ].join("\n");
  }
  if (sub === "edit") {
    openEditor(file);
    return `已关闭编辑器。真实配置：${file}\n下一次启动/新会话生效（具体取决于 agent）。`;
  }
  if (sub !== "get" && sub !== "set" && sub !== "unset")
    throw new Error("用法：config agent show|get|set|unset|edit <agent> <键路径> [值]");
  const keyPath = rest.shift();
  if (!keyPath) throw new Error("需要 <键路径>");
  if (sub === "get") {
    return jsonText(getConfigPath(readConfigObject(file), keyPath));
  }
  const rawValue = sub === "set" ? rest.shift() : undefined;
  if (sub === "set" && rawValue === undefined) throw new Error("需要值");
  const value = sub === "set" ? parseCliValue(rawValue as string) : undefined;
  const r = mutateConfigFile(file, keyPath, value);
  return [
    `已写入真实配置：${r.file}`,
    `键：${keyPath}`,
    `备份：${r.backup ?? "（原文件不存在，未备份）"}`,
    "下一次启动/新会话生效（具体取决于 agent）。",
  ].join("\n");
}

export async function cmdConfig(rest: string[]): Promise<string> {
  const opts = parseOpts(rest);
  const key = pickKey(opts.key);
  const dir = accountDir(key);
  const sub = (rest.shift() ?? "show").toLowerCase();
  if (sub === "show") return showConfig(dir, key);
  if (sub === "home-mode") {
    const raw = rest.shift();
    if (!raw)
      return `账号 ${key} 的 homeMode：${readHomeMode(dir)}（${homeModeDescription(readHomeMode(dir))}）`;
    const mode = normalizeHomeMode(raw);
    if (!mode) throw new Error("homeMode 只能是 direct / sandbox");
    writeHomeMode(mode as HomeMode, dir);
    return `账号 ${key} 的 homeMode 已设为 ${mode}。重启 daemon 后生效：wemind stop ${key} && wemind start ${key}`;
  }
  if (sub === "reload") {
    if (bridgeReady(key)) return await viaBridge(key, { kind: "config.reload" });
    throw new Error(`账号 ${key} 的 daemon 未运行，无法重载；下次启动会重新读取配置。`);
  }
  if (sub === "agent") {
    const agent = rest.shift();
    if (!agent) throw new Error("需要 agent 名");
    return cmdRealAgent(rest, opts, dir, agent);
  }
  if (sub === "wechat") {
    const agent = rest.shift();
    if (!agent) throw new Error("需要 agent 名");
    return cmdOverlay(rest, opts, dir, agent);
  }
  if (sub === "mcp") {
    return cmdMcp(rest, key);
  }
  throw new Error("用法：config show|home-mode|reload|agent|wechat|mcp");
}

export function cmdWorkspace(rest: string[]): string {
  const opts = parseOpts(rest);
  const key = pickKey(opts.key);
  const dir = accountDir(key);
  const sub = (rest.shift() ?? "show").toLowerCase();
  if (sub === "show") {
    const b = resolveWorkspace("brain", dir);
    const w = resolveWorkspace("worker", dir);
    return [
      `账号 ${key}`,
      `brain：${b.mode} ${b.path}${b.problem ? `（${b.problem}）` : ""}`,
      `worker：${w.mode} ${w.path}${w.problem ? `（${w.problem}）` : ""}`,
      `默认 managed 路径：brain=${defaultWorkspacePath("brain", dir)}  worker=${defaultWorkspacePath("worker", dir)}`,
    ].join("\n");
  }
  const role = opts.role ?? "brain";
  if (sub === "set") {
    const p = rest.shift();
    if (!p) throw new Error("需要绝对路径");
    updateWorkspace(role, p, dir);
    return `账号 ${key} 的 ${role} 工作区已设为 ${path.resolve(p)}。\n${WORKSPACE_CHANGE_NOTICE}`;
  }
  if (sub === "reset") {
    updateWorkspace(role, null, dir);
    return `账号 ${key} 的 ${role} 工作区已恢复默认 ${defaultWorkspacePath(role, dir)}。\n${WORKSPACE_CHANGE_NOTICE}`;
  }
  throw new Error("用法：workspace show|set <绝对路径>|reset [--role brain|worker]");
}

export function cmdEnv(rest: string[]): string {
  const opts = parseOpts(rest);
  const key = pickKey(opts.key);
  const dir = accountDir(key);
  const sub = (rest.shift() ?? "show").toLowerCase();
  const dryRun = rest.includes("--dry-run");
  if (sub === "capture") {
    const snap = captureEnvSnapshot();
    if (!dryRun) writeEnvSnapshot(snap, dir);
    return [
      `${dryRun ? "（预览，未写入）" : "已写入"} ${envSnapshotPath(dir)}`,
      `捕获键：${Object.keys(snap.keys).join(", ") || "（空）"}`,
      "只含白名单非敏感变量；API key/token/密码不会落盘。",
    ].join("\n");
  }
  if (sub === "show") {
    const env = readEnvSnapshot(dir);
    return Object.keys(env).length
      ? Object.entries(env)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n")
      : "（无快照；daemon 继承自身环境）";
  }
  if (sub === "clear") {
    return clearEnvSnapshot(dir) ? "已删除 env.json" : "env.json 不存在或删除失败";
  }
  throw new Error("用法：env capture [--dry-run]|show|clear");
}

export function cmdMcp(rest: string[], keySel?: string): string {
  const opts = parseOpts(rest);
  const key = pickKey(opts.key ?? keySel);
  const dir = accountDir(key);
  const sub = (rest.shift() ?? "list").toLowerCase();
  const ag = resolveAgentFor(loadBrainConfig(dir), "brain", dir);
  if (sub === "list") {
    const active = loadActive(ag.name, dir);
    const ov = readOverlay(ag.name, dir).overlay;
    return [
      `账号 ${key}`,
      `可选：${catalogNames(ag, dir).join(", ") || "（无）"}`,
      `brain 已激活：${active.join(", ") || "（空）"}`,
      `overlay disable：${ov.mcp?.disable?.join(", ") || "（无）"}`,
      `overlay extra：${Object.keys(ov.mcp?.extra ?? {}).join(", ") || "（无）"}`,
      `当前 brain：${ag.name}`,
    ].join("\n");
  }
  if (sub === "enable") {
    const name = rest.shift();
    if (!name) throw new Error("需要 MCP 名字");
    const r = addMcp(name, ag, dir);
    return r.ok
      ? `${r.text}\n用 \`wemind config reload --key ${key}\` 让 daemon 重启大脑。`
      : r.text;
  }
  if (sub === "disable") {
    const name = rest.shift();
    if (!name) throw new Error("需要 MCP 名字");
    const ov = readOverlay(ag.name, dir).overlay;
    const disable = [...new Set([...(ov.mcp?.disable ?? []), name])];
    writeOverlay(ag.name, { ...ov, mcp: { ...ov.mcp, disable } }, dir);
    const r = removeMcp(name, ag, dir);
    const how = r.ok ? `已从当前集合卸载（${r.text}）` : r.text;
    return `已禁用「${name}」：${how}。用 \`wemind config reload --key ${key}\` 让 daemon 重启大脑。`;
  }
  if (sub === "add") {
    const name = rest.shift();
    const raw = rest.shift();
    if (!name || !raw) throw new Error("用法：mcp add <名字> '<JSON 定义>'");
    const def = JSON.parse(raw) as unknown;
    const ov = readOverlay(ag.name, dir).overlay;
    writeOverlay(
      ag.name,
      {
        ...ov,
        mcp: { ...ov.mcp, extra: { ...ov.mcp?.extra, [name]: def } },
      },
      dir,
    );
    return `已写入 overlay.mcp.extra：${name}。brain 还需 \`加载 ${name}\` 才生效。`;
  }
  if (sub === "remove") {
    const name = rest.shift();
    if (!name) throw new Error("需要 MCP 名字");
    const ov = readOverlay(ag.name, dir).overlay;
    const extra = { ...ov.mcp?.extra };
    delete extra[name];
    writeOverlay(ag.name, { ...ov, mcp: { ...ov.mcp, extra } }, dir);
    return `已从 overlay.mcp.extra 移除：${name}。`;
  }
  throw new Error("用法：mcp list|enable|disable|add|remove");
}
