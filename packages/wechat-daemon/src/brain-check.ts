import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { agentEnv, authHint, type ResolvedAgent } from "./brain-agents.js";
import { copyProfilePatch } from "./profile-model.js";
import { spawnAgent } from "./spawn-agent.js";

/**
 * 「大脑连通性自检」：真正起一个 ACP agent 进程并跑完 initialize / session/new 握手，用来证明「这个大脑不只是找得到，而且能说 ACP」——比单纯「文件存在」更硬的证据。
 *
 * 用**临时沙箱目录**（避免污染真实配置与账号沙箱），结束后杀进程、删临时目录。
 * 供 `wemind brain check` 使用；不影响正在运行的 daemon（各起各的进程）。
 */
export type CheckResult = { ok: boolean; detail: string; ms: number };

export async function checkAgent(ag: ResolvedAgent, timeoutMs = 60_000): Promise<CheckResult> {
  const started = Date.now();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-brain-check-"));
  const env = agentEnv(ag, home); // 父进程 env → 临时沙箱目录 → 预设 env → 预设 envDefaults（与 daemon 的 spawn 口径一致）

  // 需要登录的 agent（DSH / Qoder）缺凭据会在 session/new 报认证失败——把凭据带进临时沙箱，否则自检会把「没登录」误报成「二进制不可用」。标识类文件（如 Qoder 的 machine_id）必须一致。
  const cfgDir = path.join(home, ag.configSubdir);
  for (const f of [...ag.credentialFiles, ...ag.identityFiles]) {
    try {
      const src = path.join(ag.realHome ?? "", f);
      if (!ag.realHome || !fs.existsSync(src)) continue;
      fs.mkdirSync(path.dirname(path.join(cfgDir, f)), { recursive: true });
      fs.copyFileSync(src, path.join(cfgDir, f));
    } catch {
      /* best-effort */
    }
  }

  // 与 daemon 的大脑沙箱对齐：配了 realProfile 的 agent（DSH）启动时就解析 profiles/<名>/cordis.patch.yml，
  // 语法错误会直接 exit 1（initialize 都不会发生）。不复制的话，坏 profile 上自检仍报 ✅，而 daemon 每条消息都起不来。
  if (ag.inherit && ag.realProfile && ag.realHome) {
    try {
      const rel = path.join("profiles", ag.realProfile, "cordis.patch.yml");
      if (fs.existsSync(path.join(ag.realHome, rel)))
        copyProfilePatch(ag.realHome, ag.realProfile, home);
    } catch {
      /* best-effort（与 daemon 的 syncProfilePatch 一致） */
    }
  }

  const proc = spawnAgent(ag, { cwd: home, env });

  let buf = "";
  let seq = 0;
  const pending = new Map<number, (frame: any) => void>();
  const settleAll = (msg: string): void => {
    for (const [id, done] of pending) {
      pending.delete(id);
      done({ id, error: { message: msg } });
    }
  };

  proc.stdout!.on("data", (d) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let frame: any;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof frame.id === "number" && pending.has(frame.id)) {
        const done = pending.get(frame.id)!;
        pending.delete(frame.id);
        done(frame);
      }
    }
  });
  const stderrTail: string[] = [];
  proc.stderr!.on("data", (d) => {
    stderrTail.push(d.toString());
    if (stderrTail.length > 20) stderrTail.shift();
  });
  proc.on("error", (e) => settleAll(`无法启动：${String(e)}`));
  proc.on("exit", (code) => settleAll(`进程已退出（code=${code}）`));

  const req = (method: string, params: unknown): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const t = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      pending.set(id, (frame) => {
        clearTimeout(t);
        if (frame?.error)
          reject(
            new Error(typeof frame.error === "string" ? frame.error : JSON.stringify(frame.error)),
          );
        else resolve(frame?.result);
      });
      proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  try {
    await req("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const s = (await req("session/new", { cwd: home, mcpServers: [] })) as { sessionId?: string };
    // 预设声明了 sessionMode（免审批）就一并验证：不发这一步的话，模式不可用（如 claude-code 以 root 跑且没设 IS_SANDBOX=1）在这里永远显示 ✅
    let modeNote = "";
    if (ag.sessionMode && s?.sessionId) {
      try {
        await req("session/set_mode", { sessionId: s.sessionId, modeId: ag.sessionMode });
        modeNote = `，mode=${ag.sessionMode}`;
      } catch (e) {
        modeNote = `，但 session/set_mode ${ag.sessionMode} 失败（${e instanceof Error ? e.message : String(e)}）——免审批模式可能不可用，回合仍可跑但会按 agent 自己的审批流程走`;
      }
    }
    return {
      ok: true,
      detail: `ACP 握手成功（initialize + session/new，sessionId=${s?.sessionId ?? "?"}${modeNote}）`,
      ms: Date.now() - started,
    };
  } catch (e) {
    // 只留末尾会把「Error: dsh: failed to parse overlay … YAMLException」这种头行切掉（栈尾看不出原因），
    // 所以同时保留第一行错误信息与末尾上下文。
    const all = stderrTail.join("").trim();
    const lines = all
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const head =
      lines.find((l) => /^(Error|YAMLException)\b/.test(l)) ??
      lines.find((l) => /failed to parse|YAMLException/i.test(l)) ??
      lines[0];
    const msg = e instanceof Error ? e.message : String(e);
    const hint = authHint(ag.name, msg);
    const tail = all.slice(-400);
    const detail = `${msg}${head ? `\n  stderr: ${head}` : ""}${tail && !head?.includes(tail.trim()) ? `\n  …${tail}` : ""}${hint ? `\n  提示：${hint}` : ""}`;
    return {
      ok: false,
      detail,
      ms: Date.now() - started,
    };
  } finally {
    try {
      if (process.platform === "win32" && proc.pid)
        spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      else proc.kill();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
