import { accountDir } from "@wemind/wechat-ilink-core";
import {
  ACP_AGENT_PRESETS,
  AUTO_PROBE_ORDER,
  resolveAgent,
  agentProblem,
  presetAvailable,
  acpArgsWarning,
  type ResolvedAgent,
} from "./brain-agents.js";
import {
  loadBrainConfig,
  updateBrainConfig,
  clearBrainConfig,
  brainConfigPath,
  type BrainConfig,
} from "./brain-config.js";
import { checkAgent } from "./brain-check.js";
import { acpModelHint, acpOverrideHint } from "./profile-model.js";
import {
  aliveOurs,
  bridgeReady,
  daemonAlive,
  pickKey,
  readPid,
  requireDaemonAlive,
  viaBridge,
} from "./cli-context.js";
import type { BrainRuntime } from "./brain-state.js";

// ===== 大脑（ACP agent）选择：账号级持久配置 brain.json，见 brain-config.ts =====
const BRAIN_SRC_LABEL: Record<ResolvedAgent["source"], string> = {
  env: "环境变量 WEMIND_BRAIN*",
  file: "账号 brain.json",
  auto: "自动探测（未配置）",
};

/** list 用：账号「配置 / 自动探测」得到的大脑标签（不看当前 shell 的 env，避免误导）。 */
function configAgentLabel(dir: string): string {
  const cfg = loadBrainConfig(dir);
  if (cfg?.agent && cfg.agent.toLowerCase() !== "auto") return cfg.agent;
  const picked = AUTO_PROBE_ORDER.find((k) => presetAvailable(k));
  return picked ? `${picked}（自动）` : "（无可用）";
}

/**
 * list 用的 agent 列：daemon **在跑**时优先显示它实际生效的大脑（`brain-runtime.json`，
 * 来自 daemon 自己的解析，含 `WEMIND_BRAIN` 覆盖/热切换结果）；daemon 没跑时仍只显示配置/自动探测。
 * 运行时与配置不一致时把两者都写出来，避免「看着是 deepseek、实际在跑 cline」。
 */
export function agentLabel(dir: string, runtime: BrainRuntime | null = null): string {
  const cfg = configAgentLabel(dir);
  if (!runtime?.agent?.trim()) return cfg;
  const name = runtime.agent.trim();
  const cfgName = cfg.replace(/（[^）]*）$/, "");
  if (name === cfgName) return cfg;
  return `${name}（运行，来源 ${runtime.source}；配置 ${cfg}）`;
}

/** `wemind brain`（show）：打印某账号大脑的「配置」与「生效」情况。 */
function describeBrain(key: string): string {
  const dir = accountDir(key);
  const cfg = loadBrainConfig(dir);
  const ag = resolveAgent(cfg, dir);
  const problem = agentProblem(ag);
  const cfgLine = cfg
    ? `brain.json → agent=${cfg.agent}${cfg.bin ? ` bin=${cfg.bin}` : ""}${cfg.args ? ` args=[${cfg.args.join(" ")}]` : ""}${cfg.extraArgs ? ` extra_args=[${cfg.extraArgs.join(" ")}]` : ""}${cfg.shell !== undefined ? ` shell=${cfg.shell}` : ""}${cfg.model ? ` model=${cfg.model}` : ""}`
    : "（未设置 brain.json）";
  const lines = [
    `账号 ${key}`,
    `  配置：${cfgLine}`,
    `  请求：${ag.requestedKey}    来源：${BRAIN_SRC_LABEL[ag.source]}`,
    `  生效：name=${ag.name}  bin=${ag.bin}  args=[${ag.args.join(" ")}]  shell=${ag.shell}  home_env=${ag.homeEnvVar ?? "(无)"}  model=${ag.model ?? "(agent 默认)"}  session_mode=${ag.sessionMode ?? "(无)"}`,
    `  可用：${problem ? `❌ ${problem}` : `✅ ${ag.binPath ?? ag.bin}`}`,
    `  可选 agent：${Object.keys(ACP_AGENT_PRESETS).join("、")}`,
    `  自动探测顺序：${AUTO_PROBE_ORDER.join(" → ")}`,
  ];
  // D：整段替换 args 后漏了 ACP 模式参数时提醒（只是提醒；运行时另有握手失败的诊断提示）
  const argsWarn = acpArgsWarning(ag.name, ag.args, ag.binOverridden);
  if (argsWarn) lines.push(`  ⚠️ ${argsWarn}`);
  // 用户层 profile 缺 `- id: acp`（或它的 model 已被桌面端模型目录淘汰）时给出「你自己改」的提示（WeMind 只读，不替 agent 合成）
  const hint =
    ag.realProfile && ag.realHome && ag.inherit
      ? (acpOverrideHint(ag.realHome, ag.realProfile) ?? acpModelHint(ag.realHome, ag.realProfile))
      : null;
  if (hint) lines.push("", hint);
  return lines.join("\n");
}

/** `wemind brain set <agent 名|auto>`：把选择按账号写入磁盘（可选 --bin/--args/--extra-args/--shell/--model；--restart 立即重启 daemon）。 */
async function cmdBrainSet(
  agentName: string,
  key: string,
  opts: {
    bin?: string;
    args?: string;
    extraArgs?: string;
    shell?: boolean;
    model?: string;
    restart: boolean;
  },
  deps: BrainCliDeps,
): Promise<string> {
  const agent = agentName.trim().toLowerCase();
  if (agent !== "auto" && !ACP_AGENT_PRESETS[agent])
    throw new Error(
      `未知 agent「${agentName}」。可选：auto、${Object.keys(ACP_AGENT_PRESETS).join("、")}（自定义二进制用 --bin 搭配任一 agent）`,
    );
  // auto 不绑定具体 agent：写进 presets.auto 永远读不到，顶层覆盖会下发给探测到的任意 agent（把 A 的 bin/args 发给 B）。
  if (
    agent === "auto" &&
    (opts.bin !== undefined ||
      opts.args !== undefined ||
      opts.extraArgs !== undefined ||
      opts.shell !== undefined)
  )
    throw new Error(
      "`auto` 是「自动探测」，不绑定具体 agent，不能配 --bin/--args/--extra-args/--shell；请指定具体 agent（如 brain set kiro --bin …）",
    );
  if (opts.model !== undefined) {
    if (!opts.model.trim()) throw new Error("--model 缺少参数值（清空/跟随默认请写 --model auto）");
    // auto 只是「自动探测」，解析时会被替换成探测到的具体 agent：写进 presets.auto 永远读不到，
    // 顶层的 model 又会下发给探测出来的任意 agent（把 DSH 的模型值发给 opencode 之类）。
    if (agent === "auto")
      throw new Error(
        "`auto` 是「自动探测」，不绑定具体 agent，不能配 --model；请指定具体 agent（如 brain set deepseek --model …）",
      );
  }
  const dir = accountDir(key);
  const customized =
    opts.bin !== undefined ||
    opts.args !== undefined ||
    opts.extraArgs !== undefined ||
    opts.shell !== undefined ||
    opts.model !== undefined;
  // 只选 agent（没带自定义启动参数）+ 没要求重启时，写入磁盘和「热切换」其实是同一件事：daemon 在跑且认桥就交给它一次做完——
  // 它先启动新大脑、成功才写 brain.json（失败退回，盘上不留半截结果），这比「写入磁盘 + 等下次重启」对用户更实在（决策⑪）。
  // 带 --bin/--args/--shell/--model 则**不能**当场应用：控制桥只接受 agent 名（见 control-bridge.ts 的安全边界）。
  if (!opts.restart && !customized && bridgeReady(key)) {
    const r = await cmdBrainSwitch(agent, key, false);
    // 热切换失败时**没有写入磁盘**（持久化放最后，见 brain-switch.ts）：把这点说清楚，否则用户会以为 brain.json 已经改了。
    return r.startsWith("❌")
      ? `${r}\n（brain.json **没有被改写**：换大脑失败就不写入磁盘——这是「失败就退回原来那个」的代价。想强制写入再重启：wemind brain set ${agent} --restart）`
      : r;
  }
  const patch: BrainConfig = { agent };
  if (opts.bin) patch.bin = opts.bin;
  if (opts.args !== undefined) patch.args = opts.args.trim() ? opts.args.trim().split(/\s+/) : [];
  if (opts.extraArgs !== undefined)
    patch.extraArgs = opts.extraArgs.trim() ? opts.extraArgs.trim().split(/\s+/) : [];
  if (opts.shell !== undefined) patch.shell = opts.shell;
  if (opts.model !== undefined) patch.model = opts.model.trim();
  // 读-改-写：保留 worker 段（任务侧独立选择）与 presets 段（按 agent 名存的启动覆盖），旧 agent 的覆盖自动迁移。
  const before = loadBrainConfig(dir);
  const cfg = updateBrainConfig(patch, dir);
  const lines = [
    `已设置 ${key} 的大脑：agent=${agent}${cfg.bin ? ` bin=${cfg.bin}` : ""}${cfg.args ? ` args=[${cfg.args.join(" ")}]` : ""}${cfg.extraArgs ? ` extra_args=[${cfg.extraArgs.join(" ")}]` : ""}${cfg.model ? ` model=${cfg.model}` : ""}`,
    `配置文件：${brainConfigPath(dir)}`,
  ];
  // D：整段替换 args 时检查 ACP 模式标记（只提醒，不阻止写入）
  if (opts.args !== undefined) {
    const binOverridden =
      opts.bin !== undefined ||
      !!before?.presets?.[agent]?.bin ||
      (before?.agent?.trim().toLowerCase() === agent && !!before?.bin);
    const warn = acpArgsWarning(agent, cfg.args ?? [], binOverridden);
    if (warn) lines.push(`⚠️ ${warn}`);
  }
  if (opts.restart) {
    const dpid = readPid(dir, "daemon.pid");
    if (aliveOurs(dpid)) {
      deps.startDaemon(key);
      lines.push(`已重启 daemon（账号 ${key}）。`);
    } else {
      lines.push(`daemon 未在运行，未重启（用 wemind start ${key} 启动）。`);
    }
  } else if (customized && bridgeReady(key)) {
    // --bin/--args/--extra-args/--model 的改动其实可以由 `brain switch <同名 agent>` 当场应用（sameAgent 按这几项判「是不是同一个」）；--shell 不在判据里，只能重启。
    const viaSwitch =
      opts.bin !== undefined ||
      opts.args !== undefined ||
      opts.extraArgs !== undefined ||
      opts.model !== undefined;
    lines.push(
      `（带 --bin/--args/--extra-args/--shell/--model 的改动不能由 brain set 当场应用：控制桥只认 agent 名。重启后生效——wemind stop ${key} && wemind start ${key}${viaSwitch ? `；不想重启的话，接着执行 wemind brain switch ${agent} 也能当场应用（它按 name/bin/args/model 判断是不是同一个，改过就会真切换）` : ""}）`,
    );
  } else if (daemonAlive(key)) {
    lines.push(
      `（daemon 在跑但不是当前版本（不认控制桥）：盘已写好，重启一次才生效——wemind stop ${key} && wemind start ${key}）`,
    );
  } else {
    lines.push(`（daemon 需重启才生效：wemind start ${key}）`);
  }
  return lines.join("\n");
}

/** `wemind brain unset`：清除账号级配置，回退到自动探测/默认。 */
function cmdBrainUnset(key: string): string {
  const ok = clearBrainConfig(accountDir(key));
  return ok
    ? `${key} 已清除 brain.json（回退到自动探测/默认）。daemon 需重启才生效。`
    : `${key} 未设置 brain.json（无需清除）。`;
}

/** `wemind brain check`：真起一个进程跑 ACP 握手，验证大脑「不仅找得到、而且能说 ACP」。 */
async function cmdBrainCheck(key: string): Promise<string> {
  const dir = accountDir(key);
  const ag = resolveAgent(loadBrainConfig(dir), dir);
  const problem = agentProblem(ag);
  if (problem) {
    process.exitCode = 1; // 自检失败必须让脚本/CI 看得见（以前只打印 ❌，退出码仍是 0）
    return `❌ ${key} 的大脑不可用：${problem}`;
  }
  const r = await checkAgent(ag);
  if (!r.ok) process.exitCode = 1;
  return `${r.ok ? "✅" : "❌"} ${key} 大脑自检（${ag.name}，bin=${ag.bin}）：${r.detail}（${r.ms}ms）`;
}

export type BrainCliDeps = {
  /** `--restart` 重启账号 daemon：由入口注入，避免 CLI 模块反向依赖 manage.ts。 */
  startDaemon: (key: string) => void;
};

/** brain 子命令派发：show（默认）/ set / unset / check / switch / handoff。 */
export async function cmdBrain(rest: string[], deps: BrainCliDeps): Promise<string> {
  const argv = [...rest];
  const FLAGS = new Set([
    "--bin",
    "--args",
    "--extra-args",
    "--shell",
    "--no-shell",
    "--model",
    "--restart",
  ]);
  const takeFlag = (name: string): string | undefined => {
    // 同时认 `--model X` 与 `--model=X`：以前只按整 token 匹配 `--model`，等号写法会被当成未知开关静默丢掉（命令还报成功）。
    const eq = argv.find((t) => t.startsWith(`${name}=`));
    if (eq !== undefined) {
      const v = eq.slice(name.length + 1);
      if (!v) throw new Error(`${name} 缺少参数值`);
      argv.splice(argv.indexOf(eq), 1);
      return v;
    }
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    // `--bin` 后面没值、或紧跟的是另一个开关（`brain set kiro --bin --restart`）时，以前会静默把 `--restart` 当成 bin 的值，看起来「设置成功」但存进去的是错的。
    // 值本身允许以 `--` 开头（如 `--args "--experimental-acp"`），所以只对已知开关报错。
    if (v === undefined || FLAGS.has(v)) throw new Error(`${name} 缺少参数值`);
    argv.splice(i, 2);
    return v;
  };
  const bin = takeFlag("--bin");
  const argsOverride = takeFlag("--args");
  const extraArgsOverride = takeFlag("--extra-args");
  const model = takeFlag("--model");
  const restart = argv.includes("--restart");
  if (restart) argv.splice(argv.indexOf("--restart"), 1);
  const shell = argv.includes("--shell") ? true : argv.includes("--no-shell") ? false : undefined;
  for (const f of ["--shell", "--no-shell"]) {
    const i = argv.indexOf(f);
    if (i >= 0) argv.splice(i, 1);
  }
  while (argv.includes("--worker")) argv.splice(argv.indexOf("--worker"), 1); // 只对 switch 有意义（用 rest 判断），不留成未知开关
  // 未知开关直接报错：以前一律被 pos 的过滤静默丢掉，`--modle` 这种拼错会「看起来设置成功」。
  const unknown = argv.filter((x) => x.startsWith("--"));
  if (unknown.length)
    throw new Error(
      `未知参数：${unknown.join(" ")}（可用：--bin --args --extra-args --shell --no-shell --model --restart）`,
    );
  const pos = argv.filter((x) => x && !x.startsWith("--"));
  const first = (pos[0] || "").toLowerCase();
  const SUBCOMMANDS = new Set(["show", "set", "unset", "check", "switch", "handoff"]);
  if (first && !SUBCOMMANDS.has(first)) {
    // 省略子命令 → 视为 `brain show <key|label>`（如 `wemind brain 工作号`）。
    return describeBrain(pickKey(pos[0]));
  }
  const sub = first || "show";
  switch (sub) {
    case "show":
      return describeBrain(pickKey(pos[1]));
    case "set": {
      if (!pos[1])
        throw new Error(
          '用法: brain set <agent 名|auto> [--bin X] [--args "…"] [--extra-args "…"] [--shell|--no-shell] [--model X|auto] [--restart] [<key|label>]',
        );
      return await cmdBrainSet(
        pos[1],
        pickKey(pos[2]),
        { bin, args: argsOverride, extraArgs: extraArgsOverride, shell, model, restart },
        deps,
      );
    }
    case "switch": {
      // 桥只接受**agent 名**（安全边界：见 control-bridge.ts）。带 --bin/--args/--shell/--model 就走 set（只写入磁盘；--bin/--args/--model 可随后用同名 switch 当场应用，--shell 只能重启）。
      if (
        bin !== undefined ||
        argsOverride !== undefined ||
        extraArgsOverride !== undefined ||
        shell !== undefined ||
        model !== undefined
      )
        throw new Error(
          "`brain switch` 只接受 agent 名（换大脑是「换一个已装好的 agent」，不能带 --bin/--args/--extra-args/--model）。\n" +
            "需要自定义二进制用 `brain set <agent 名> --bin …`（那是配置变更，只写入磁盘——之后 `wemind brain switch <同名 agent>` 可当场应用，或重启 daemon）；追加参数用 `brain set <agent 名> --extra-args …`；换模型用 `brain set <agent 名> --model …`。",
        );
      if (!pos[1]) throw new Error("用法: brain switch <agent 名|auto> [--worker] [<key|label>]");
      const worker = rest.includes("--worker");
      return await cmdBrainSwitch(pos[1], pickKey(pos[2]), worker);
    }
    case "handoff":
      return await cmdBrainHandoff(pickKey(pos[1]));
    case "unset":
      return cmdBrainUnset(pickKey(pos[1]));
    case "check":
      return await cmdBrainCheck(pickKey(pos[1]));
    default:
      throw new Error(
        `未知 brain 子命令「${sub}」（可用：show / set / switch / handoff / unset / check）`,
      );
  }
}

/**
 * `brain switch <agent 名|auto>`：**热切换**——daemon 在跑就走控制桥（不重启、不打断在途回合）；
 * daemon 没在跑就只写 brain.json（下次启动生效）。
 * `--worker` 设默认任务大脑：那是 daemon 进程内才有的状态（不写入磁盘），没有 daemon 就没有意义，必须先启动。
 */
async function cmdBrainSwitch(agentName: string, key: string, worker: boolean): Promise<string> {
  const agent = agentName.trim().toLowerCase();
  if (agent !== "auto" && !ACP_AGENT_PRESETS[agent])
    throw new Error(
      `未知 agent「${agentName}」。可选：auto、${Object.keys(ACP_AGENT_PRESETS).join("、")}`,
    );
  const dir = accountDir(key);
  if (worker) {
    requireDaemonAlive(key); // 「默认任务大脑」是进程内状态，不写入磁盘
    return await viaBridge(key, { kind: "brain.worker", target: agent });
  }
  if (daemonAlive(key)) return await viaBridge(key, { kind: "brain.switch", target: agent });
  updateBrainConfig({ agent }, dir);
  return `daemon 未在运行：已把 ${key} 的大脑写进 brain.json（agent=${agent}，下次启动生效）。\n运行中换大脑：先 wemind start ${key}`;
}

/** `wemind brain handoff`：让当前大脑写一份交接摘要（与微信「交接」同一段实现）。 */
async function cmdBrainHandoff(key: string): Promise<string> {
  requireDaemonAlive(key);
  return await viaBridge(key, { kind: "brain.handoff" });
}
