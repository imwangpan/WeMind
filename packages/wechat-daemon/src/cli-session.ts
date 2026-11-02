import { accountDir } from "@wemind/wechat-ilink-core";
import {
  currentSessionIdOf,
  deleteSession,
  listSessions,
  renderSessionList,
  renameSession,
} from "./session-registry.js";
import { brainSessionMapPath, clearSessionPointer, sessionKey } from "./session-map.js";
import {
  agentNameOf,
  bridgeReady,
  daemonAlive,
  ownerOf,
  pickKey,
  requireDaemonAlive,
  splitKeyArg,
  viaBridge,
} from "./cli-context.js";

/**
 * `wemind session <new|list|resume|rename|delete>`。
 * 读写规则：**读**永远可用（直接读登记表）；**写**优先走 daemon（单一写者，且当前会话记录/agent 侧状态都是它的活状态）。
 * 例外：`rename`/`delete` 只动登记表这一个文件，daemon 没跑时直接改也是安全的；`resume` 必须真让 agent load，没 daemon 做不了。
 */
export async function cmdSession(rest: string[]): Promise<string> {
  const argv = [...rest];
  const pi = argv.indexOf("--page");
  let page: number | undefined;
  if (pi >= 0) {
    const raw = argv[pi + 1];
    if (raw === undefined || raw.startsWith("--")) throw new Error("--page 缺少参数值");
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--page 必须是正整数：${raw}`);
    page = n;
    argv.splice(pi, 2);
  }
  const pos = argv.filter((x) => x && !x.startsWith("--"));
  const sub = (pos[0] ?? "").toLowerCase();
  const { args, sel } = splitKeyArg(pos.slice(1));
  const USAGE =
    "用法: session list [--page N] | session new [名字] | session resume <序号|名字|id前缀> | " +
    "session rename <序号|名字> <新名字> | session delete <序号|名字|id前缀>   [<key|label>]";

  if (sub === "list") {
    const key = pickKey(sel);
    // 读优先走桥（daemon 里在用的那个大脑才是真的会话归属）；桥不可用就退回直接读文件——读永远不该失败。
    if (bridgeReady(key)) return await viaBridge(key, { kind: "session.list", page });
    const dir = accountDir(key);
    const agent = agentNameOf(key);
    const userId = ownerOf(key);
    if (!userId) throw new Error(`账号 ${key} 没有 userId（account.json 不全），先重新登录。`);
    const { entries, others, currentSessionId } = listSessions(agent, userId, dir);
    const why = daemonAlive(key)
      ? "（daemon 是升级前启动的旧版本，没法问它：以上按 brain.json/自动探测的「下次会用的大脑」列出；重启 daemon 后以进程内在用的为准。）"
      : "（daemon 未运行：按 brain.json/自动探测得到的「下次会用的大脑」列出。）";
    return (
      renderSessionList(entries, { agent, page, currentSessionId, others, verbose: true }) +
      "\n" +
      why
    );
  }

  if (sub === "new") {
    const key = pickKey(sel);
    const name = args.join(" ").trim() || undefined;
    if (daemonAlive(key))
      return await viaBridge(key, { kind: "session.new", ...(name ? { name } : {}) });
    // 没 daemon：能做的只有「丢掉当前会话记录」——下条消息会开新的。名字要等会话真的建好再 rename。
    const dir = accountDir(key);
    const userId = ownerOf(key);
    if (!userId) throw new Error(`账号 ${key} 没有 userId（account.json 不全），先重新登录。`);
    const cleared = clearSessionPointer(
      brainSessionMapPath(dir),
      sessionKey(agentNameOf(key), userId),
    );
    return [
      cleared ? "已清空当前会话记录" : "当前本来就没有会话记录",
      "（daemon 未运行：下次启动后你发的第一条消息会开一个新会话）",
      name ? `名字等新会话建好后再登记：wemind session rename 1 ${name}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (sub === "resume") {
    const key = pickKey(sel);
    if (!args[0]) throw new Error(USAGE);
    requireDaemonAlive(key); // 恢复要真的让 agent load 那条会话：只有 daemon 里有 ACP 连接，做不了假
    return await viaBridge(key, { kind: "session.resume", ref: args.join(" ") });
  }

  if (sub === "rename" || sub === "delete") {
    const key = pickKey(sel);
    const [ref, ...nameRest] = args;
    if (!ref || (sub === "rename" && !nameRest.length)) throw new Error(USAGE);
    if (bridgeReady(key))
      return await viaBridge(
        key,
        sub === "rename"
          ? { kind: "session.rename", ref, name: nameRest.join(" ") }
          : { kind: "session.delete", ref },
      );
    // 只动登记表（+ 删除时可能清当前会话记录），daemon 不在也不影响它下次读到的结果
    const dir = accountDir(key);
    const userId = ownerOf(key);
    if (!userId) throw new Error(`账号 ${key} 没有 userId（account.json 不全），先重新登录。`);
    const agent = agentNameOf(key);
    if (sub === "delete") {
      const r = deleteSession(agent, userId, ref, { dir });
      if (!r.ok) {
        process.exitCode = 1;
        return `❌ ${r.error}`;
      }
      return `已从列表删除：${r.entry.name ?? r.entry.title ?? r.entry.sessionId.slice(0, 8)}。${
        r.clearedPointer ? "它就是当前会话，下一条消息会开一个新的。" : "当前会话没有变。"
      }`;
    }
    const r = renameSession(agent, userId, ref, nameRest.join(" "), dir);
    if (!r.ok) {
      process.exitCode = 1;
      return `❌ ${r.error}`;
    }
    return `已重命名：${r.entry.name}（当前 brain=${agent} 的会话）`;
  }

  throw new Error(USAGE);
}

/** 当前会话记录（供 CLI 展示；不常用但排查时值钱）。 */
export function cmdSessionCurrent(key: string): string {
  const agent = agentNameOf(key);
  const userId = ownerOf(key);
  const sid = userId ? currentSessionIdOf(agent, userId, accountDir(key)) : undefined;
  return sid
    ? `${key} 当前会话：${sid}（agent=${agent}）`
    : `${key} 当前没有会话记录（下一条消息会开新会话）。agent=${agent}`;
}
