import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAppDeclaration, writeAppDeclaration } from "./pm2-runner.js";
import { BRAIN_CONFIG_EXIT_CODE } from "./brain-agents.js";

/*
 * 只测「声明怎么生成」——不调 pm2、不需要装 pm2。
 *
 * 为什么值得测：`--runner pm2` 这条路线此前用 `pm2 start … -- daemon` 命令行参数启动，既不设重启延迟（pm2 默认 0 → 崩溃就立刻重拉，撞上 iLink 限流/重启风暴），也不认退出码 78（大脑配置错误会被重拉到 max_restarts，每 5s 刷一条日志）。声明一旦写错，只有真机装了 pm2 才会暴露；这里把「与 builtin 看护进程 / ecosystem.config.cjs 对齐」的那几个键钉死。
 */
describe("pm2 app 声明", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  const decl = (key = "acc1", cli = "C:\\Program Files\\wemind\\cli.js", log = "/tmp/d.log") =>
    buildAppDeclaration(key, cli, log);

  it("app 名、脚本、参数、解释器", () => {
    const d = decl();
    expect(d.name).toBe("wemind-acc1");
    expect(d.script).toBe("C:\\Program Files\\wemind\\cli.js");
    // args 是字符串（pm2 的声明格式），不是 `-- daemon` 分隔符
    expect(d.args).toBe("daemon");
    expect(d.interpreter).toBe("node");
  });

  it("与 builtin 看护进程 / ecosystem.config.cjs 对齐的保活项", () => {
    const d = decl();
    expect(d.autorestart).toBe(true);
    expect(d.restart_delay).toBe(5000); // 不是 pm2 默认的 0
    expect(d.max_restarts).toBe(50);
    expect(d.stop_exit_codes).toEqual([BRAIN_CONFIG_EXIT_CODE]);
    expect(BRAIN_CONFIG_EXIT_CODE).toBe(78);
  });

  it("日志合并到账号 daemon.log，不监听文件", () => {
    const d = decl("k", "/x/cli.js", "/home/u/.wemind/k/daemon.log");
    expect(d.out_file).toBe("/home/u/.wemind/k/daemon.log");
    expect(d.error_file).toBe("/home/u/.wemind/k/daemon.log");
    expect(d.merge_logs).toBe(true);
    expect(d.watch).toBe(false);
  });

  it("注入 WECHAT_ACCOUNT（多账号隔离；只声明这一个键，其余继承 pm2 进程环境）", () => {
    expect(decl("acc9").env).toEqual({ WECHAT_ACCOUNT: "acc9" });
  });

  it("cwd 固定为主目录，不继承 `pm2 start` 时的 shell 目录", () => {
    expect(decl().cwd).toBe(os.homedir());
  });

  it("写入磁盘：<账号目录>/pm2.app.json，是 { apps: [ ... ] } 的合法 JSON", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-pm2-"));
    tmpDirs.push(dir);
    const file = writeAppDeclaration("acc2", "/x/cli.js", "/x/daemon.log", dir);
    expect(file).toBe(path.join(dir, "pm2.app.json"));
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      apps: Array<Record<string, unknown>>;
    };
    expect(parsed.apps).toHaveLength(1);
    expect(parsed.apps[0]).toEqual(buildAppDeclaration("acc2", "/x/cli.js", "/x/daemon.log"));
  });

  it("写入磁盘：目录不存在时自动创建（首个账号也直接可用）", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-pm2-"));
    tmpDirs.push(root);
    const nested = path.join(root, "a", "b");
    const file = writeAppDeclaration("k", "/x/cli.js", "/x/d.log", nested);
    expect(fs.existsSync(file)).toBe(true);
  });
});
