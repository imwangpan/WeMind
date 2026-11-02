import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  WEMIND_ROOT,
  accountDir,
  deriveAccountKey,
  registerAccount,
  fetchQRCode,
  pollQRStatus,
  saveQrState,
  saveAccountTo,
  clearSessionPause,
  notifyStart,
  addAllowFrom,
  loadAccount as readAccount,
} from "@wemind/wechat-ilink-core";
import { bridgeReady, viaBridge } from "./cli-context.js";

const BASE = process.env.WEMIND_ILINK_BASE?.trim() || "https://ilinkai.weixin.qq.com";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

export type LoginCliDeps = {
  /** 登录成功后自动启动（`--start`）：由入口注入，模块不反向依赖 manage.ts。 */
  startDaemon: (key: string, runner?: string) => void;
};

/**
 * 每次登录一个独立暂存目录：两个 `wimind login` 并发时不能互删二维码/凭证。
 * 用 `mkdtemp`（POSIX 0700）而不是固定 `.staging/`，也不写进任何已登记账号的数据目录。
 * 导出仅供单测。
 */
export function createLoginStagingDir(): string {
  fs.mkdirSync(WEMIND_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(WEMIND_ROOT, ".staging-"));
}

/** 把本次登录的暂存目录按 botId 收进账号目录 + 登记。 */
export function finalizeStaging(staging: string, label?: string): { key: string; msg: string } {
  const acc = readAccount(staging);
  if (!acc?.botId) throw new Error(`staging 无有效登录（${staging}）`);
  const key = deriveAccountKey(acc.botId);
  const dest = accountDir(key);
  if (fs.existsSync(dest)) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(`账号目录已存在: ${dest}（该微信号此前已登录过；如需重登请先 delete ${key}）`);
  }
  fs.renameSync(staging, dest);
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
  return { key, msg: `已登录：key=${key}  label=${meta.label}  botId=${acc.botId}\n目录：${dest}` };
}

/**
 * 懒加载 `qrcode`：只有扫码登录要画二维码，`list` / `brain` / `task` / `daemon` 全用不上。
 * 顶层 `import` 会让**每次**启动都付约 36ms（实测）解析 qrcode + yargs 依赖树；这里在第一次画码时才加载，之后同进程内复用（登录过程会因过期刷新多次）。
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

/** 一条命令完成扫码登录：自刷新二维码 + 终端码 + 自动开图 + 自动登记（→ 可选自动启动）。 */
export async function cmdLogin(
  label: string | undefined,
  autoStart: boolean,
  runner: string | undefined,
  deps: LoginCliDeps,
): Promise<void> {
  const staging = createLoginStagingDir();
  try {
    await loginInto(staging, label, autoStart, runner, deps);
  } finally {
    // 归档成功时目录已被 rename 走（这里是空操作）；超时/Ctrl+C/失败时清掉二维码与临时凭证。
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

async function loginInto(
  staging: string,
  label: string | undefined,
  autoStart: boolean,
  runner: string | undefined,
  deps: LoginCliDeps,
): Promise<void> {
  const QRCode = await loadQrCode(); // 只有登录路径才加载 qrcode
  const png = path.join(staging, "qrcode.png");
  const overall = Date.now() + 15 * 60 * 1000;
  let code = "";
  let opened = false;

  const refresh = async (): Promise<void> => {
    const qr = await fetchQRCode(BASE);
    code = qr.qrcode;
    saveQrState(
      { qrcode: qr.qrcode, qrcodeUrl: qr.qrcode_img_content, createdAt: Date.now() },
      staging,
    );
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
      saveAccountTo(staging, {
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
          fs.unlinkSync(path.join(staging, f));
        } catch {
          /* ignore */
        }
      }
      console.log("\n登录成功，正在登记…");
      const { key, msg } = finalizeStaging(staging, label);
      console.log(msg);
      await unpauseIfRunning(key);
      if (autoStart) {
        deps.startDaemon(key, runner);
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

/** 登录成功后让**正在运行的** daemon 解除 -14 冷却（`clearSessionPause` 是进程内状态，CLI 自己清不到它）。 */
async function unpauseIfRunning(key: string): Promise<void> {
  if (!bridgeReady(key)) return;
  try {
    await viaBridge(key, { kind: "session.unpause" });
  } catch {
    /* 尽力而为：daemon 忙/正在退出/旧版本不认识，都不影响登录本身 */
  }
}
