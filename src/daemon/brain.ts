import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

/**
 * daemon 的「大脑」：调 headless kiro-cli 生成回复。
 * 本模块不依赖 iLink/MCP，便于日后随 daemon 一起独立拆出。
 */

/** 解析 kiro-cli 可执行文件：优先 KIRO_CLI_BIN，否则在 PATH 中找，最后回退裸名。 */
function resolveKiroCli(): string {
  const override = process.env.KIRO_CLI_BIN?.trim();
  if (override) return override;
  const exe = process.platform === "win32" ? "kiro-cli.exe" : "kiro-cli";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, exe))) return path.join(dir, exe);
  }
  return "kiro-cli";
}

const KIRO_CLI = resolveKiroCli();
const TIMEOUT_MS = Number(process.env.WECHAT_BRAIN_TIMEOUT_MS) || 120_000;
const HISTORY_MAX = 10; // 每个用户保留的最近条数（user/assistant 合计）

const PREAMBLE =
  "你正在通过微信和用户对话。回复会原样转发到微信，请直接、口语化地回答，" +
  "不要使用 Markdown 代码块或多余前后缀。不要调用任何微信相关工具（如 get_messages/send_text_message）。";

const histories = new Map<string, string[]>();

/** 去除 kiro-cli 输出里的 ANSI 转义码与开头的 "> " 应答标记。 */
function cleanOutput(s: string): string {
  return s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/^\s*>\s?/, "").trim();
}

/** 以 argv 传入 prompt（shell:false），避免命令注入。 */
function askKiro(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      KIRO_CLI,
      ["chat", "--no-interactive", "--trust-all-tools", prompt],
      { shell: false, windowsHide: true },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("kiro-cli timeout"));
    }, TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(cleanOutput(out));
      else reject(new Error(`kiro-cli exited ${code}: ${cleanOutput(err).slice(0, 200)}`));
    });
    child.stdin?.end();
  });
}

/** 带滚动上下文地向 Kiro 提问，返回纯文本回复。 */
export async function askKiroForUser(userId: string, message: string): Promise<string> {
  const h = histories.get(userId) ?? [];
  const prompt = [PREAMBLE, h.join("\n"), `用户: ${message}`, "助手:"]
    .filter(Boolean)
    .join("\n");
  const reply = await askKiro(prompt);
  h.push(`用户: ${message}`, `助手: ${reply}`);
  while (h.length > HISTORY_MAX) h.shift();
  histories.set(userId, h);
  return reply;
}
