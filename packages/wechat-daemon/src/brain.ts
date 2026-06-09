import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

import { BRAIN_HOME } from "./mcp-sandbox.js";

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

/**
 * 提取 kiro-cli 的最终回复：它把回复用带色的 "> " 标记前缀，工具调用旁白在其之前。
 * 取最后一个标记之后的内容（丢弃旁白），再去 ANSI、去残留 "> "。
 */
function cleanOutput(s: string): string {
  const markerRe = /\u001b\[[0-9;]*m>\s\u001b\[0m/g;
  let lastEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(s)) !== null) lastEnd = m.index + m[0].length;
  const answer = lastEnd >= 0 ? s.slice(lastEnd) : s;
  return answer.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/^\s*>\s?/, "").trim();
}

/** 以 argv 传入 prompt（shell:false），避免命令注入。 */
function askKiro(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      KIRO_CLI,
      ["chat", "--no-interactive", "--trust-all-tools", prompt],
      {
        shell: false,
        windowsHide: true,
        cwd: BRAIN_HOME,
        // 用沙箱 KIRO_HOME 隔离全局 mcp.json（默认空 MCP，杜绝 wechat 回环）。
        // auth 在平台数据目录、不随 KIRO_HOME 移动，故 brain 仍是登录态。
        env: { ...process.env, KIRO_HOME: BRAIN_HOME },
      },
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
