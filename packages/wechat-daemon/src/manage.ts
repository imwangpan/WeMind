#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  WEMIND_ROOT,
  accountDir,
  deriveAccountKey,
  listAccounts,
  registerAccount,
  unregisterAccount,
  setLabel,
  getDefaultKey,
  setDefaultKey,
  fetchQRCode,
  pollQRStatus,
  saveQrState,
  saveAccountTo,
  clearSessionPause,
  notifyStart,
  notifyStop,
  addAllowFrom,
  removeAllowFrom,
  readAllowFrom,
  type AccountData,
} from "@wemind/wechat-ilink-core";
import { pm2Start, pm2Stop } from "./pm2-runner.js";
import { watchdogStart } from "./watchdog-runner.js";
import {
  CLI_PID_MARKERS,
  brainPidMarkers,
  commandLines,
  isAlive,
  isOurProcess,
  matchesMarkers,
} from "./proc-identity.js";
import {
  ACP_AGENT_PRESETS,
  AUTO_PROBE_ORDER,
  resolveAgent,
  agentProblem,
  presetAvailable,
  type ResolvedAgent,
} from "./brain-agents.js";
import {
  loadBrainConfig,
  saveBrainConfig,
  clearBrainConfig,
  brainConfigPath,
  type BrainConfig,
} from "./brain-config.js";
import { checkAgent } from "./brain-check.js";
import { CLI_VERSION, versionLine } from "./version.js";

/**
 * WeMind 多账号管理 CLI。
 * 账号 key = 由微信 botId 派生的唯一标识；每个账号独立目录 ~/.wemind/<key>。
 * label = 人类可读别名（可改、可重复）；管理命令可用 key 或 label 选择账号。
 * 推荐用 `login` 一条命令完成：自刷新二维码 → 扫码 → 自动归档（→ 可选自动启动）。
 */

const BASE = process.env.WEMIND_ILINK_BASE?.trim() || "https://ilinkai.weixin.qq.com";
const STAGING = path.join(WEMIND_ROOT, ".staging");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readAccount(dir: string): AccountData | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "account.json"), "utf-8")) as AccountData;
  } catch {
    return null;
  }
}
function readPid(dir: string, name: string): number | null {
  try {
    const n = parseInt(fs.readFileSync(path.join(dir, name), "utf-8").trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
/**
 * 该 pid 是否「活着**且确实是我们自己的** CLI 进程」。
 * 只判存活不够：pid 会复用（尤其重启后），陈旧 pid 文件可能指向**别人的**进程 → 会误杀/误判。
 */
function aliveOurs(pid: number | null, markers: string[][] = CLI_PID_MARKERS): boolean {
  return isOurProcess(pid, markers);
}

/** 阻塞式 sleep（CLI 是同步流程；Atomics.wait 不占 CPU、不比 spawn 一个进程贵）。 */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* ignore */
  }
}

/**
 * 某 pid 的全部后代（POSIX）。Windows 不需要——`taskkill /T` 自己会走进程树。
 * 用 `ps -A -o pid=,ppid=` 一次取全表再在内存里建树，比逐层 `pgrep -P` 少起进程。
 * （导出仅供单测；CLI 内部不对外。）
 */
export function descendantPids(pid: number): number[] {
  try {
    // procps（Linux）与 BSD/macOS 的 ps 都认 `-A`；个别精简环境（BusyBox）只有 `-e`，故兜底一次。
    const psArgs = [
      ["-A", "-o", "pid=,ppid="],
      ["-e", "-o", "pid=,ppid="],
    ];
    let stdout = "";
    for (const args of psArgs) {
      const r = spawnSync("ps", args, { encoding: "utf8", timeout: 5000 });
      if (r.status === 0 && r.stdout) {
        stdout = r.stdout;
        break;
      }
    }
    const childrenOf = new Map<number, number[]>();
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!m) continue;
      const child = Number(m[1]);
      const parent = Number(m[2]);
      const bucket = childrenOf.get(parent);
      if (bucket) bucket.push(child);
      else childrenOf.set(parent, [child]);
    }
    const out: number[] = [];
    const walk = (p: number): void => {
      for (const c of childrenOf.get(p) ?? []) {
        out.push(c);
        walk(c);
      }
    };
    walk(pid);
    return out;
  } catch {
    return [];
  }
}

/**
 * 杀「pid 及其整棵进程树」。
 *
 * Windows：`taskkill /T /F` 本来就连带子树。
 * POSIX：`process.kill(pid)` **只**结束该进程，不动它的子进程——daemon 被停后，它拉起的
 * ACP 大脑 / worker 会留下来继续占着会话与文件句柄（实测只有 Windows 因为 /T 而看不出来）。
 * 所以这里先收集后代、由叶子往根 SIGTERM（daemon 的 SIGTERM 处理器会自己清 pid 文件），
 * 等一小会儿再对仍存活的补 SIGKILL。
 */
function killProcessTrees(pids: number[]): void {
  const unique = [...new Set(pids.filter((p) => isAlive(p)))];
  if (!unique.length) return;
  if (process.platform === "win32") {
    for (const pid of unique)
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true, // 避免瞬时闪出控制台窗口
      });
    return;
  }
  // 先收集所有后代（按叶子优先排序：后出现的更深，反过来就是叶子先）
  const targets: number[] = [];
  for (const pid of unique) targets.push(...descendantPids(pid).reverse(), pid);
  const all = [...new Set(targets)].filter((p) => isAlive(p));
  for (const pid of all) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* ignore */
    }
  }
  sleepSync(800); // 给 SIGTERM 处理器一点时间（daemon 会清 pid 文件、关子进程）
  for (const pid of all) {
    if (!isAlive(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
}
function openFile(p: string): void {
  try {
    if (process.platform === "win32")
      spawn("cmd", ["/c", "start", "", p], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    else
      spawn(process.platform === "darwin" ? "open" : "xdg-open", [p], {
        detached: true,
        stdio: "ignore",
      }).unref();
  } catch {
    /* ignore */
  }
}

/** key 或 label → key（label 唯一匹配才行）。 */
function resolveKey(arg: string): string {
  if (!arg) throw new Error("需要 <key 或 label>");
  const accs = listAccounts();
  if (accs.some((a) => a.key === arg)) return arg;
  const byLabel = accs.filter((a) => a.label === arg);
  if (byLabel.length === 1) return byLabel[0].key;
  if (byLabel.length > 1)
    throw new Error(
      `label「${arg}」对应多个账号，请改用 key：${byLabel.map((a) => a.key).join(", ")}`,
    );
  throw new Error(`未找到账号：${arg}（既不是 key 也不是 label）`);
}

/** 启动某账号的 daemon（方案 a：委托 pm2 常驻，跑 `wemind daemon`，注入 WECHAT_ACCOUNT）。 */
function startDaemon(key: string, runner?: string): void {
  // 用 process.argv[1]（即正在执行的 cli.js 绝对路径），而不是 dirname(import.meta.url)：
  // 发布后 tsdown 把 manage.ts 内联进 dist/cli.js，两者恰好相同；但若将来拆成多 chunk，
  // argv[1] 才是「用户装的那个 bin」，dirname(import.meta.url) 可能是 dist/chunks/ 下。
  const cliPath =
    process.argv[1] || path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
  // start 前先停现有任何 runner（pm2 app / builtin 看门狗），避免同账号双跑抢 token
  stopDaemon(key);
  const useRunner = (runner || process.env.WEMIND_RUNNER || "builtin").toLowerCase();
  console.log((useRunner === "pm2" ? pm2Start(key, cliPath) : watchdogStart(key, cliPath)).msg);
}

/**
 * 停止某账号的常驻：先 pm2 delete（方案 a），再按 pid 兜底杀 wrapper/daemon/brain/worker
 * （兼容直接启动的）。停的是**整条链**：除列出的进程外，还连带它们的子进程树。
 */
function stopDaemon(key: string): string {
  pm2Stop(key); // best-effort：停掉 pm2 托管的 app（若有）
  const dir = accountDir(key);
  const ag = resolveAgent(loadBrainConfig(dir));
  const cand = [
    { pid: readPid(dir, "wrapper.pid"), name: "wrapper", markers: CLI_PID_MARKERS },
    { pid: readPid(dir, "daemon.pid"), name: "daemon", markers: CLI_PID_MARKERS },
    { pid: readPid(dir, "brain.pid"), name: "brain", markers: brainPidMarkers(ag.bin, ag.args) },
    // worker 也是我们拉起的 ACP agent（worker-acp.ts 写 worker.pid）；漏掉它 → POSIX 上
    // 停完 daemon 任务进程还活着、stale worker.pid 一直留着（Windows 靠 /T 连带，看不出来）。
    {
      pid: readPid(dir, "worker.pid"),
      name: "worker",
      markers: brainPidMarkers(ag.bin, ag.args),
    },
  ];
  // 只杀「活着**且身份确认**」的：pid 会被复用，陈旧 pid 文件可能指向别人的进程 → 绝不误杀。
  // 命令行一次批量查（Windows 下较慢）；正常情况（陈旧 pid 早已不存在）根本不会发起查询。
  const lines = commandLines(cand.map((c) => c.pid));
  const stopped: string[] = [];
  const skipped: string[] = [];
  const toKill: number[] = [];
  for (const c of cand) {
    if (!c.pid || !isAlive(c.pid)) continue;
    if (matchesMarkers(lines.get(c.pid), c.markers)) {
      toKill.push(c.pid);
      stopped.push(`${c.name} ${c.pid}`);
    } else {
      skipped.push(`${c.name} ${c.pid}`); // 活着的 pid 但不是我们的（pid 复用）→ 不杀
    }
  }
  // 身份校验都通过了才动手：一次性杀掉这些进程**及其子进程树**（见 killProcessTrees 注释）。
  killProcessTrees(toKill);
  for (const f of ["wrapper.pid", "daemon.pid", "brain.pid", "worker.pid"]) {
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch {
      /* ignore */
    }
  }
  const parts: string[] = [];
  if (stopped.length) parts.push(`已停止 ${stopped.join(" + ")}`);
  if (skipped.length)
    parts.push(`跳过 ${skipped.join(" + ")}（非本程序，未杀；已清陈旧 pid 文件）`);
  return parts.length ? parts.join("；") : "无运行中的进程";
}

/** 把 STAGING 的登录按 botId 归档 + 登记。 */
function finalizeStaging(label?: string): { key: string; msg: string } {
  const acc = readAccount(STAGING);
  if (!acc?.botId) throw new Error(`staging 无有效登录（${STAGING}）`);
  const key = deriveAccountKey(acc.botId);
  const dest = accountDir(key);
  if (fs.existsSync(dest)) {
    fs.rmSync(STAGING, { recursive: true, force: true });
    throw new Error(`账号目录已存在: ${dest}（该微信号此前已登录过；如需重登请先 delete ${key}）`);
  }
  fs.renameSync(STAGING, dest);
  for (const f of [
    "qrcode.png",
    "qrcode.txt",
    "qr_login.json",
    "poll.out",
    "poll.err",
    "auto.out",
    "auto.err",
  ]) {
    try {
      fs.unlinkSync(path.join(dest, f));
    } catch {
      /* ignore */
    }
  }
  const meta = registerAccount({
    key,
    botId: acc.botId,
    userId: acc.userId,
    baseUrl: acc.baseUrl,
    label: label || key,
  });
  if (acc.userId) addAllowFrom(acc.userId, dest); // 配对：扫码登录者自动授权
  return { key, msg: `已归档：key=${key}  label=${meta.label}  botId=${acc.botId}\n目录：${dest}` };
}

/**
 * 懒加载 `qrcode`：只有扫码登录要画二维码，`list` / `brain` / `task` / `daemon` 全用不上。
 * 顶层 `import` 会让**每次**启动都付约 36ms（实测）解析 qrcode + yargs 依赖树；
 * 这里在第一次画码时才加载，之后同进程内复用（登录过程会因过期刷新多次）。
 * 用函数声明而非 `const QRCode = await import(...)`：后者在 ESM 顶层要多一层 TDZ 心智负担。
 */
let qrcodeMod: typeof import("qrcode") | undefined;

async function loadQrCode(): Promise<typeof import("qrcode")> {
  if (!qrcodeMod) {
    try {
      qrcodeMod = await import("qrcode");
    } catch (e) {
      throw new Error(
        `无法加载二维码库 qrcode（依赖缺失或安装损坏）：${e instanceof Error ? e.message : String(e)}\n` +
          "请重试安装：npm i -g @wemind/cli",
      );
    }
  }
  return qrcodeMod;
}

/** 一条命令完成扫码登录：自刷新二维码 + 终端码 + 自动开图 + 自动归档（→ 可选自动启动）。 */
async function cmdLogin(
  label: string | undefined,
  autoStart: boolean,
  runner?: string,
): Promise<void> {
  const QRCode = await loadQrCode(); // 只有登录路径才加载 qrcode
  fs.rmSync(STAGING, { recursive: true, force: true });
  fs.mkdirSync(STAGING, { recursive: true });
  const png = path.join(STAGING, "qrcode.png");
  const overall = Date.now() + 15 * 60 * 1000;
  let code = "";
  let opened = false;

  const refresh = async (): Promise<void> => {
    const qr = await fetchQRCode(BASE);
    code = qr.qrcode;
    saveQrState({ qrcode: qr.qrcode, qrcodeUrl: qr.qrcode_img_content, createdAt: Date.now() });
    await QRCode.toFile(png, qr.qrcode_img_content, { width: 480, margin: 2 });
    const term = await QRCode.toString(qr.qrcode_img_content, { type: "terminal", small: true });
    console.log("\n用要登录的微信扫下面的二维码（过期会自动刷新）：\n");
    console.log(term);
    console.log("图片(已自动打开): " + png);
    console.log("链接: " + qr.qrcode_img_content + "\n");
    if (!opened) {
      openFile(png);
      opened = true;
    }
  };

  await refresh();
  console.log("等待扫码确认…（最多 15 分钟，Ctrl+C 取消）");
  while (Date.now() < overall) {
    let s;
    try {
      s = await pollQRStatus(BASE, code);
    } catch {
      await sleep(2000);
      continue;
    }
    if (s.status === "confirmed") {
      if (!s.bot_token || !s.ilink_bot_id || !s.ilink_user_id)
        throw new Error("confirmed 但数据不全");
      // 走 core 的 saveAccountTo：POSIX 600 + Windows 一次性明文告警。
      // 之前这里是裸 writeFileSync，导致「凭证受权限保护」的安全承诺在 CLI 登录路径上不成立。
      saveAccountTo(STAGING, {
        botToken: s.bot_token,
        botId: s.ilink_bot_id,
        userId: s.ilink_user_id,
        baseUrl: s.baseurl ?? BASE,
        savedAt: Date.now(),
      });
      clearSessionPause(s.ilink_bot_id);
      await notifyStart({ baseUrl: s.baseurl ?? BASE, token: s.bot_token }).catch(() => {});
      for (const f of ["qrcode.png", "qr_login.json"]) {
        try {
          fs.unlinkSync(path.join(STAGING, f));
        } catch {
          /* ignore */
        }
      }
      console.log("\n登录成功，归档中…");
      const { key, msg } = finalizeStaging(label);
      console.log(msg);
      if (autoStart) {
        startDaemon(key, runner);
        console.log(`已启动 daemon（账号 ${key}）。`);
      } else {
        console.log(`启动：wemind start ${key}`);
      }
      return;
    }
    if (s.status === "expired") {
      console.log("二维码过期，自动刷新…");
      await refresh();
      continue;
    }
    await sleep(1500);
  }
  throw new Error("超时（15 分钟）未完成登录");
}

function cmdList(): string {
  const def = getDefaultKey();
  const accs = listAccounts();
  if (!accs.length) return "（无已登记账号）。用 `login` 添加。";
  // 先收集各账号的 pid + 大脑特征，再**一次性**批量查命令行（Windows 下每次查询较慢）；
  // 只凭「pid 活着」显示状态会在重启后 pid 复用时骗人，所以要带身份校验。
  const entries = accs.map((a) => {
    const dir = accountDir(a.key);
    const ag = resolveAgent(loadBrainConfig(dir));
    return {
      a,
      dir,
      dpid: readPid(dir, "daemon.pid"),
      bpid: readPid(dir, "brain.pid"),
      brainMarkers: brainPidMarkers(ag.bin, ag.args),
    };
  });
  const lines = commandLines(entries.flatMap((e) => [e.dpid, e.bpid]));
  const aliveOursIn = (pid: number | null, markers: string[][]): boolean =>
    !!pid && matchesMarkers(lines.get(pid), markers);
  return entries
    .map((e) => {
      const running = aliveOursIn(e.dpid, CLI_PID_MARKERS) ? `运行中(pid ${e.dpid})` : "已停止";
      const brainPid = aliveOursIn(e.bpid, e.brainMarkers) ? `  brain(pid ${e.bpid})` : "";
      return `- ${e.a.key}${e.a.key === def ? " [默认]" : ""}  label=${e.a.label}  botId=${e.a.botId}  agent=${agentLabel(e.dir)}  ${running}${brainPid}`;
    })
    .join("\n");
}

// ===== 大脑（ACP agent）选择：账号级持久配置 brain.json，见 brain-config.ts =====
const BRAIN_SRC_LABEL: Record<ResolvedAgent["source"], string> = {
  env: "环境变量 WEMIND_BRAIN*",
  file: "账号 brain.json",
  auto: "自动探测（未配置）",
};

/** list 用：账号「配置 / 自动探测」得到的大脑标签（不看当前 shell 的 env，避免误导）。 */
function agentLabel(dir: string): string {
  const cfg = loadBrainConfig(dir);
  if (cfg?.agent && cfg.agent.toLowerCase() !== "auto") return cfg.agent;
  const picked = AUTO_PROBE_ORDER.find((k) => presetAvailable(k));
  return picked ? `${picked}（自动）` : "（无可用）";
}

/** `wemind brain`（show）：打印某账号大脑的「配置」与「生效」情况。 */
function describeBrain(key: string): string {
  const dir = accountDir(key);
  const cfg = loadBrainConfig(dir);
  const ag = resolveAgent(cfg);
  const problem = agentProblem(ag);
  const cfgLine = cfg
    ? `brain.json → agent=${cfg.agent}${cfg.bin ? ` bin=${cfg.bin}` : ""}${cfg.args ? ` args=[${cfg.args.join(" ")}]` : ""}${cfg.shell !== undefined ? ` shell=${cfg.shell}` : ""}`
    : "（未设置 brain.json）";
  return [
    `账号 ${key}`,
    `  配置：${cfgLine}`,
    `  请求：${ag.requestedKey}    来源：${BRAIN_SRC_LABEL[ag.source]}`,
    `  生效：name=${ag.name}  bin=${ag.bin}  args=[${ag.args.join(" ")}]  shell=${ag.shell}  home_env=${ag.homeEnvVar ?? "(无)"}`,
    `  可用：${problem ? `❌ ${problem}` : `✅ ${ag.binPath ?? ag.bin}`}`,
    `  预设：${Object.keys(ACP_AGENT_PRESETS).join("、")}`,
    `  自动探测顺序：${AUTO_PROBE_ORDER.join(" → ")}`,
  ].join("\n");
}

/** `wemind brain set <预设|auto>`：把选择按账号落盘（可选 --bin/--args/--shell；--restart 立即重启 daemon）。 */
function cmdBrainSet(
  agentName: string,
  key: string,
  opts: { bin?: string; args?: string; shell?: boolean; restart: boolean },
): string {
  const agent = agentName.trim().toLowerCase();
  if (agent !== "auto" && !ACP_AGENT_PRESETS[agent])
    throw new Error(
      `未知预设「${agentName}」。可选：auto、${Object.keys(ACP_AGENT_PRESETS).join("、")}（自定义二进制用 --bin 搭配任一预设）`,
    );
  const cfg: BrainConfig = { agent };
  if (opts.bin) cfg.bin = opts.bin;
  if (opts.args !== undefined) cfg.args = opts.args.trim() ? opts.args.trim().split(/\s+/) : [];
  if (opts.shell !== undefined) cfg.shell = opts.shell;
  const dir = accountDir(key);
  saveBrainConfig(cfg, dir);
  const lines = [
    `已设置 ${key} 的大脑：agent=${agent}${cfg.bin ? ` bin=${cfg.bin}` : ""}${cfg.args ? ` args=[${cfg.args.join(" ")}]` : ""}`,
    `配置文件：${brainConfigPath(dir)}`,
  ];
  if (opts.restart) {
    const dpid = readPid(dir, "daemon.pid");
    if (aliveOurs(dpid)) {
      startDaemon(key);
      lines.push(`已重启 daemon（账号 ${key}）。`);
    } else {
      lines.push(`daemon 未在运行，未重启（用 wemind start ${key} 启动）。`);
    }
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
  const ag = resolveAgent(loadBrainConfig(accountDir(key)));
  const problem = agentProblem(ag);
  if (problem) return `❌ ${key} 的大脑不可用：${problem}`;
  const r = await checkAgent(ag);
  return `${r.ok ? "✅" : "❌"} ${key} 大脑自检（${ag.name}，bin=${ag.bin}）：${r.detail}（${r.ms}ms）`;
}

/** brain 子命令派发：show（默认）/ set / unset / check。 */
async function cmdBrain(rest: string[]): Promise<string> {
  const argv = [...rest];
  const FLAGS = new Set(["--bin", "--args", "--shell", "--no-shell", "--restart"]);
  const takeFlag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    // `--bin` 后面没值、或紧跟的是另一个开关（`brain set kiro --bin --restart`）时，
    // 以前会静默把 `--restart` 当成 bin 的值，看起来「设置成功」但存进去的是错的。
    // 值本身允许以 `--` 开头（如 `--args "--experimental-acp"`），所以只对已知开关报错。
    if (v === undefined || FLAGS.has(v)) throw new Error(`${name} 缺少参数值`);
    argv.splice(i, 2);
    return v;
  };
  const bin = takeFlag("--bin");
  const argsOverride = takeFlag("--args");
  const restart = argv.includes("--restart");
  if (restart) argv.splice(argv.indexOf("--restart"), 1);
  const shell = argv.includes("--shell") ? true : argv.includes("--no-shell") ? false : undefined;
  for (const f of ["--shell", "--no-shell"]) {
    const i = argv.indexOf(f);
    if (i >= 0) argv.splice(i, 1);
  }
  const pos = argv.filter((x) => x && !x.startsWith("--"));
  const first = (pos[0] || "").toLowerCase();
  const SUBCOMMANDS = new Set(["show", "set", "unset", "check"]);
  if (first && !SUBCOMMANDS.has(first)) {
    // 省略子命令 → 视为 `brain show <key|label>`（如 `wemind brain 主号`）。
    return describeBrain(pickKey(pos[0]));
  }
  const sub = first || "show";
  switch (sub) {
    case "show":
      return describeBrain(pickKey(pos[1]));
    case "set": {
      if (!pos[1])
        throw new Error(
          '用法: brain set <预设|auto> [--bin X] [--args "…"] [--shell|--no-shell] [--restart] [<key|label>]',
        );
      return cmdBrainSet(pos[1], pickKey(pos[2]), { bin, args: argsOverride, shell, restart });
    }
    case "unset":
      return cmdBrainUnset(pickKey(pos[1]));
    case "check":
      return await cmdBrainCheck(pickKey(pos[1]));
    default:
      throw new Error(`未知 brain 子命令「${sub}」（可用：show / set / unset / check）`);
  }
}

function cmdAdopt(key: string, label?: string): string {
  if (!key) throw new Error("用法: adopt <key> [--label 名]");
  const acc = readAccount(accountDir(key));
  if (!acc?.botId) throw new Error(`${accountDir(key)} 无有效 account.json`);
  const meta = registerAccount({
    key,
    botId: acc.botId,
    userId: acc.userId,
    baseUrl: acc.baseUrl,
    label: label || key,
  });
  if (acc.userId) addAllowFrom(acc.userId, accountDir(key)); // 接管时把账号本人种入授权清单
  return `已登记：key=${key}  label=${meta.label}  botId=${acc.botId}`;
}

async function cmdLogout(sel: string): Promise<string> {
  const key = resolveKey(sel);
  const dir = accountDir(key);
  const acc = readAccount(dir);
  const stopMsg = stopDaemon(key);
  if (acc?.botToken) {
    try {
      await notifyStop({ baseUrl: acc.baseUrl, token: acc.botToken });
    } catch {
      /* ignore */
    }
  }
  for (const f of ["account.json", "state.json", "qr_login.json", "qrcode.png", "qrcode.txt"]) {
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch {
      /* ignore */
    }
  }
  return `账号 ${key} 已登出（${stopMsg}）。目录与会话保留，可重新登录。`;
}

function cmdDelete(sel: string): string {
  const key = resolveKey(sel);
  const stopMsg = stopDaemon(key);
  try {
    fs.rmSync(accountDir(key), { recursive: true, force: true });
  } catch (e) {
    throw new Error(`删除目录失败: ${String(e)}`);
  }
  unregisterAccount(key);
  return `账号 ${key} 已删除（${stopMsg}，已移除目录与注册）。`;
}

function cmdStart(sel: string, runner?: string): string {
  const key = resolveKey(sel);
  startDaemon(key, runner);
  return `已启动 daemon（账号 ${key}）。用 list 查看运行状态。`;
}

// ===== 本地任务命令（文件桥）：写 task-inbox/*.json，由 daemon 扫描执行；状态读 task-state.json =====
function taskInboxDir(key: string): string {
  return path.join(accountDir(key), "task-inbox");
}
/** 原子写一个命令文件到收件箱（临时文件 + rename，避免 daemon 读到半截）。 */
function writeTaskCmd(key: string, obj: Record<string, unknown>): void {
  const dir = taskInboxDir(key);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  const tmp = `${fp}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...obj, ts: Date.now() }, null, 2), "utf-8");
  fs.renameSync(tmp, fp);
}
/** 选账号：显式 key/label 优先，否则用默认账号。 */
function pickKey(sel?: string): string {
  if (sel) return resolveKey(sel);
  const d = getDefaultKey();
  if (!d) throw new Error("无默认账号，请指定 <key|label> 或先 login");
  return d;
}
/** 预检 daemon 存活（本地命令需 daemon 在跑才有人消费收件箱）。 */
function requireDaemonAlive(key: string): void {
  const pid = readPid(accountDir(key), "daemon.pid");
  if (!aliveOurs(pid))
    throw new Error(
      `账号 ${key} 的 daemon 未运行。先启动：wemind start ${key}（用 wemind list 查看状态）`,
    );
}

async function cmdTask(text: string, cwd: string | undefined, sel?: string): Promise<string> {
  if (!text) throw new Error('用法: task "<任务描述>" [--cwd 目录] [<key|label>]');
  const key = pickKey(sel);
  requireDaemonAlive(key);
  const useCwd = cwd || process.cwd();
  writeTaskCmd(key, { kind: "dispatch", text, cwd: useCwd });
  // 短轮询 task-state.json 确认已派发（最多 ~3s）
  const stateFile = path.join(accountDir(key), "task-state.json");
  for (let i = 0; i < 15; i++) {
    await sleep(200);
    try {
      if (JSON.parse(fs.readFileSync(stateFile, "utf-8")).active)
        return `已派发任务（worker 运行中，cwd=${useCwd}）。\n用 task-status 看进展、task-reply 回复、task-stop 结束。`;
    } catch {
      /* ignore */
    }
  }
  return `已投递任务（cwd=${useCwd}）。daemon 处理中，用 task-status 查看。`;
}
function cmdTaskReply(text: string, sel?: string): string {
  if (!text) throw new Error('用法: task-reply "<内容>" [<key|label>]');
  const key = pickKey(sel);
  requireDaemonAlive(key);
  writeTaskCmd(key, { kind: "reply", text });
  return `已发送给任务：${text.slice(0, 40)}`;
}
function cmdTaskStop(sel?: string): string {
  const key = pickKey(sel);
  requireDaemonAlive(key);
  writeTaskCmd(key, { kind: "stop" });
  return "已发送「结束任务」指令。";
}
function cmdTaskStatus(sel?: string): string {
  const key = pickKey(sel);
  const stateFile = path.join(accountDir(key), "task-state.json");
  let s: {
    active?: boolean;
    status?: string;
    turns?: number;
    startedAt?: number;
    lastOutput?: string;
  };
  try {
    s = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
  } catch {
    return `账号 ${key}：无任务状态（task-state.json 不存在，daemon 可能未跑过任务）。`;
  }
  if (!s.active) return `账号 ${key}：当前无活跃任务（idle）。`;
  const since = s.startedAt ? `${Math.round((Date.now() - s.startedAt) / 1000)}s` : "?";
  return [
    `账号 ${key} 任务状态：`,
    `  状态：${s.status}  轮次：${s.turns ?? 0}  已运行：${since}`,
    `  最近输出：${s.lastOutput ? s.lastOutput.slice(0, 300) : "（无）"}`,
  ].join("\n");
}

export async function runManage(argv: string[]): Promise<void> {
  const cmd = argv.shift();
  const rest = [...argv];
  const li = rest.indexOf("--label");
  let label: string | undefined;
  if (li >= 0) {
    label = rest[li + 1];
    rest.splice(li, 2);
  }
  const si = rest.indexOf("--start");
  const autoStart = si >= 0;
  if (autoStart) rest.splice(si, 1);
  const ci = rest.indexOf("--cwd");
  let cwd: string | undefined;
  if (ci >= 0) {
    cwd = rest[ci + 1];
    rest.splice(ci, 2);
  }
  const ri = rest.indexOf("--runner");
  let runner: string | undefined;
  if (ri >= 0) {
    runner = rest[ri + 1];
    rest.splice(ri, 2);
  }

  switch (cmd) {
    case "version":
    case "--version":
    case "-v":
      console.log(versionLine());
      break;
    case "login":
      await cmdLogin(label, autoStart, runner);
      break;
    case "list":
      console.log(cmdList());
      break;
    case "brain":
      console.log(await cmdBrain(rest));
      break;
    case "adopt":
      console.log(cmdAdopt(rest[0], label));
      break;
    case "start":
      console.log(cmdStart(rest[0], runner));
      break;
    case "stop": {
      const k = resolveKey(rest[0]);
      console.log(stopDaemon(k));
      break;
    }
    case "task":
      console.log(await cmdTask(rest[0], cwd, rest[1]));
      break;
    case "task-reply":
      console.log(cmdTaskReply(rest[0], rest[1]));
      break;
    case "task-status":
      console.log(cmdTaskStatus(rest[0]));
      break;
    case "task-stop":
      console.log(cmdTaskStop(rest[0]));
      break;
    case "label": {
      const k = resolveKey(rest[0]);
      setLabel(k, rest.slice(1).join(" "));
      console.log(`已设置 ${k} 的别名为「${rest.slice(1).join(" ")}」`);
      break;
    }
    case "set-default": {
      const k = resolveKey(rest[0]);
      setDefaultKey(k);
      console.log(`默认账号 = ${k}`);
      break;
    }
    case "logout":
      console.log(await cmdLogout(rest[0]));
      break;
    case "delete":
      console.log(cmdDelete(rest[0]));
      break;
    case "finalize": {
      const { msg } = finalizeStaging(label);
      console.log(msg);
      break;
    } // 兼容旧流程（staging 已有登录时归档）
    case "allow": {
      const k = resolveKey(rest[0]);
      const uid = rest[1];
      if (!uid) throw new Error("用法: allow <key|label> <userId>");
      const list = addAllowFrom(uid, accountDir(k));
      console.log(`已授权 ${uid} → ${k}\n当前清单(${list.length})：${list.join(", ")}`);
      break;
    }
    case "revoke": {
      const k = resolveKey(rest[0]);
      const uid = rest[1];
      if (!uid) throw new Error("用法: revoke <key|label> <userId>");
      const list = removeAllowFrom(uid, accountDir(k));
      console.log(`已撤销 ${uid} → ${k}\n当前清单(${list.length})：${list.join(", ") || "（空）"}`);
      break;
    }
    case "allowlist": {
      const k = resolveKey(rest[0]);
      const list = readAllowFrom(accountDir(k));
      console.log(
        `${k} 授权用户(${list.length})：\n${list.map((u) => "  - " + u).join("\n") || "  （空）"}`,
      );
      break;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(helpText());
      break;
    default:
      // 拼错命令不能静默成功：脚本里 `wemind strat x` 以前 exit 0，看起来像成功。
      // 提示与帮助都走 stderr（stdout 保持为空），并以 2 退出（2 = 用法错误，与「运行出错」的 1 区分）。
      console.error(`未知命令：${cmd}`);
      console.error(helpText());
      process.exitCode = 2;
  }
}

function helpText(): string {
  return `WeMind 多账号管理（wemind v${CLI_VERSION}）
用法: wemind <command>            其余：wemind version | help

  login [--label 名] [--start]   一条命令完成扫码登录：自刷新二维码 + 自动归档（--start 顺带启动 daemon）
  list                           列出账号、别名、运行状态
  start <key|label>              启动某账号的 daemon
  stop <key|label>               停止某账号的 daemon
  brain [show|set|unset|check] [<key|label>]   查看/切换/清除/自检账号的大脑（ACP agent）
                                 set: brain set <预设|auto> [--bin X] [--args "…"] [--restart] [<key|label>]
                                 大脑选择按账号持久化在 brain.json；环境变量 WEMIND_BRAIN* 为一次性覆盖
  task "<描述>" [--cwd 目录] [<key|label>]   本地派发任务给 worker（默认 cwd=当前终端目录）
  task-reply "<内容>" [<key|label>]          回复/注入当前任务（「task-reply 继续」= 续跑）
  task-status [<key|label>]                  查看当前任务状态与最近输出
  task-stop [<key|label>]                    结束当前任务
  logout <key|label>             停 daemon + 通知下线 + 清凭证（保留目录，可重登）
  delete <key|label>             停 daemon + 删除目录 + 移除注册
  label <key|label> <新别名>     改别名
  set-default <key|label>        设默认账号
  adopt <key> [--label 名]       把已存在的账号目录登记进注册表
  allowlist <key|label>          查看该账号的授权用户清单(allowFrom)
  allow <key|label> <userId>     授权某用户可驱动该账号 bot
  revoke <key|label> <userId>    撤销某用户的授权

说明：key = 由微信 botId 派生的唯一标识（目录名）；label = 人类可读别名。多数命令可用 key 或 label。`;
}
// 入口由 cli.ts 调用 runManage(argv)；此处不再顶层自启。
