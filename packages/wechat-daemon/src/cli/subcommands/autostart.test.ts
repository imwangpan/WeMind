import { describe, it, expect } from "vitest";
import type { AccountMeta } from "@wemind/wechat-ilink-core";
import { autostartHelpRequested, resolveAutostartKeys } from "./autostart.js";

/**
 * resolveAutostartKeys 是 `wemind autostart install` 选择目标账号的唯一入口：
 * 选错账号 = 给错误的账号装自启，因此每个分支都要有明确断言。
 */

function acc(key: string, label = key): AccountMeta {
  return { key, label, botId: `bot-${key}`, userId: `user-${key}`, baseUrl: "", addedAt: 0 };
}

const accounts = [acc("aaa111", "工作号"), acc("bbb222", "生活号"), acc("ccc333", "工作号")];

describe("resolveAutostartKeys", () => {
  it("默认（无参数）安装所有已登记账号，并标记 all", () => {
    expect(resolveAutostartKeys([], accounts)).toEqual({
      keys: ["aaa111", "bbb222", "ccc333"],
      all: true,
    });
  });

  it("--all 与默认一致", () => {
    expect(resolveAutostartKeys(["--all"], accounts)).toEqual({
      keys: ["aaa111", "bbb222", "ccc333"],
      all: true,
    });
  });

  it("--key 精确指定单个账号，且不代表 all", () => {
    expect(resolveAutostartKeys(["--key", "bbb222"], accounts)).toEqual({
      keys: ["bbb222"],
      all: false,
    });
  });

  it("--key 不存在时报错并指向 list", () => {
    const r = resolveAutostartKeys(["--key", "nope"], accounts);
    expect("error" in r && r.error).toContain("nope");
    expect("error" in r && r.error).toContain("wemind list");
  });

  it("--label 唯一时解析到对应 key，且不代表 all", () => {
    expect(resolveAutostartKeys(["--label", "生活号"], accounts)).toEqual({
      keys: ["bbb222"],
      all: false,
    });
  });

  it("--label 重复时报错并提示改用 --key", () => {
    const r = resolveAutostartKeys(["--label", "工作号"], accounts);
    expect("error" in r && r.error).toContain("多个账号");
    expect("error" in r && r.error).toContain("aaa111");
    expect("error" in r && r.error).toContain("ccc333");
    expect("error" in r && r.error).toContain("--key");
  });

  it("--label 不存在时报错", () => {
    const r = resolveAutostartKeys(["--label", "不存在"], accounts);
    expect("error" in r && r.error).toContain("不存在");
  });

  it("--key 缺少参数值时报错", () => {
    const r = resolveAutostartKeys(["--key"], accounts);
    expect("error" in r && r.error).toContain("--key");
    expect("error" in r && r.error).toContain("缺少参数值");
  });

  it("--label 后紧跟另一个开关视为缺值", () => {
    const r = resolveAutostartKeys(["--label", "--all"], accounts);
    expect("error" in r && r.error).toContain("--label");
    expect("error" in r && r.error).toContain("缺少参数值");
  });

  it("--key 优先于 --label", () => {
    expect(resolveAutostartKeys(["--label", "生活号", "--key", "aaa111"], accounts)).toEqual({
      keys: ["aaa111"],
      all: false,
    });
  });

  it("单账号机器上明确 --key 也不能退化成 all（否则以后新增账号会被自动拉起）", () => {
    expect(resolveAutostartKeys(["--key", "solo"], [acc("solo")])).toEqual({
      keys: ["solo"],
      all: false,
    });
    expect(resolveAutostartKeys([], [acc("solo")])).toEqual({ keys: ["solo"], all: true });
  });

  it("注册表为空时报错（--all 也一样）", () => {
    for (const argv of [[], ["--all"]]) {
      const r = resolveAutostartKeys(argv, []);
      expect("error" in r && r.error).toContain("wemind login");
    }
  });

  it("拼错的开关直接报错，不静默变成「装全部账号」", () => {
    const r = resolveAutostartKeys(["--labal", "工作号"], accounts);
    expect("error" in r && r.error).toContain("未知参数");
    expect("error" in r && r.error).toContain("--labal");
  });

  it("裸 key 位置参数报错并提示改用 --key", () => {
    const r = resolveAutostartKeys(["aaa111"], accounts);
    expect("error" in r && r.error).toContain("未知参数");
    expect("error" in r && r.error).toContain("--key");
  });
});

describe("autostartHelpRequested", () => {
  it("子命令后的 --help / -h / help 只打印用法", () => {
    expect(autostartHelpRequested(["install", "--help"])).toBe(true);
    expect(autostartHelpRequested(["uninstall", "-h"])).toBe(true);
    expect(autostartHelpRequested(["status", "help"])).toBe(true);
  });

  it("正常参数不触发帮助", () => {
    expect(autostartHelpRequested(["install"])).toBe(false);
    expect(autostartHelpRequested(["install", "--key", "aaa111"])).toBe(false);
    expect(autostartHelpRequested(["help"])).toBe(false); // 由 cmdAutostart 的分支处理
  });
});
