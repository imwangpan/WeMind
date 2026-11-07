import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { launcherEnv, stableExecPath } from "./launcher-env.js";

const HOME = path.join(os.homedir(), ".wemind");

describe("launcherEnv", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("覆盖 WECHAT_ACCOUNT，保留 WEMIND_HOME", () => {
    const env = launcherEnv("myaccount", { WEMIND_HOME: "/custom/root", WECHAT_ACCOUNT: "old" });
    expect(env.WECHAT_ACCOUNT).toBe("myaccount");
    expect(env.WEMIND_HOME).toBe("/custom/root");
  });

  it("保留其余环境变量（密钥等需要透传）", () => {
    const env = launcherEnv("acc", { DEEPSEEK_API_KEY: "sk-test", WEMIND_RUNNER: "pm2" });
    expect(env.DEEPSEEK_API_KEY).toBe("sk-test");
    expect(env.WEMIND_RUNNER).toBe("pm2");
  });

  it("P0：丢弃父进程的 WECHAT_DATA_DIR", () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const env = launcherEnv("acc", { WECHAT_DATA_DIR: "/wrong/dir" });
    expect(env.WECHAT_DATA_DIR).toBeUndefined();
    expect("WECHAT_DATA_DIR" in env).toBe(false);
    expect(errSpy).toHaveBeenCalled();
  });

  it("提示里包含账号、旧目录、预期目录与迁移指引", () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    launcherEnv("acc", { WECHAT_DATA_DIR: "/wrong/dir", WEMIND_HOME: "/custom/root" });
    const text = errSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(text).toContain("WECHAT_DATA_DIR=/wrong/dir");
    expect(text).toContain(`acc`);
    expect(text).toContain(path.join("/custom/root", "acc"));
    expect(text).toContain("处理方式");
  });

  it("WECHAT_DATA_DIR 恰好等于预期目录时不打扰用户（但同样丢弃）", () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const env = launcherEnv("acc", { WECHAT_DATA_DIR: path.join(HOME, "acc") });
    expect(env.WECHAT_DATA_DIR).toBeUndefined();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("尾斜杠差异不算不一致", () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    launcherEnv("acc", { WECHAT_DATA_DIR: path.join(HOME, "acc") + path.sep });
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("空串 / 纯空白视为未设置", () => {
    for (const v of ["", "   ", "\t\n"]) {
      const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const env = launcherEnv("acc", { WECHAT_DATA_DIR: v });
      expect(env.WECHAT_DATA_DIR).toBeUndefined();
      expect(errSpy).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    }
  });

  it("不修改传入的 parentEnv 对象（纯函数语义）", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const parent = { WECHAT_DATA_DIR: "/wrong", WECHAT_ACCOUNT: "old" };
    const env = launcherEnv("acc", parent);
    expect(parent.WECHAT_DATA_DIR).toBe("/wrong");
    expect(parent.WECHAT_ACCOUNT).toBe("old");
    expect(env).not.toBe(parent);
  });

  it("默认使用 process.env", () => {
    process.env.WEMIND_TEST_MARKER = "v";
    try {
      const env = launcherEnv("acc");
      expect(env.WEMIND_TEST_MARKER).toBe("v");
      expect(env.WECHAT_ACCOUNT).toBe("acc");
    } finally {
      delete process.env.WEMIND_TEST_MARKER;
    }
  });
});

describe("stableExecPath", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("把 fnm 的临时 shell 路径解析到真实安装位置", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-stable-path-"));
    dirs.push(root);

    const installDir = path.join(root, "node-versions", "v24.21.0", "installation");
    fs.mkdirSync(installDir, { recursive: true });
    const realNode = path.join(installDir, "node.exe");
    fs.writeFileSync(realNode, "");

    const shimDir = path.join(root, "fnm_multishells", "24708_1794048466500");
    fs.mkdirSync(path.dirname(shimDir), { recursive: true });
    fs.symlinkSync(installDir, shimDir, process.platform === "win32" ? "junction" : "dir");

    const shimNode = path.join(shimDir, "node.exe");
    expect(stableExecPath(shimNode)).toBe(fs.realpathSync(realNode));
    expect(stableExecPath(shimNode)).not.toBe(shimNode);
  });

  it("路径不存在时原样返回，不吞掉错误也不换成别的路径", () => {
    const missing = path.join(os.tmpdir(), `wemind-stable-missing-${process.pid}`, "node.exe");
    expect(stableExecPath(missing)).toBe(missing);
  });
});
