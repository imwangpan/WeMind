import { describe, it, expect } from "vitest";
import { buildLaunchAgentPlist, buildSystemdUnit } from "./posix-autostart.js";

/**
 * 只测生成内容（纯函数），不碰真的 systemctl / launchctl：
 * POSIX 分支当前没有真机，单元内容是否正确只能靠这些断言守住。
 */

describe("buildSystemdUnit", () => {
  const env = {
    PATH: "/usr/local/bin:/opt/node bin",
    WEMIND_HOME: "/data/wemind root",
  };
  const unit = buildSystemdUnit("aaa111", "/opt/node bin/node", "/repo/cli.js", env);

  it("单元跑前台 daemon，不跑 start", () => {
    expect(unit).toContain("ExecStart=");
    expect(unit).toContain(" daemon");
    expect(unit).not.toMatch(/ExecStart=.*\bstart\b/);
  });

  it("带上账号、根目录和安装时的 PATH（值有空格时加引号）", () => {
    expect(unit).toContain("Environment=WECHAT_ACCOUNT=aaa111");
    expect(unit).toContain("Environment=WECHAT_DATA_DIR=");
    expect(unit).toContain('Environment="WEMIND_HOME=/data/wemind root"');
    expect(unit).toContain('Environment="PATH=/usr/local/bin:/opt/node bin"');
  });

  it("退出码 75 / 78 不重拉，与 builtin / pm2 一致", () => {
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("RestartPreventExitStatus=75 78");
  });

  it("没有 WEMIND_HOME 时不写该行", () => {
    const plain = buildSystemdUnit("aaa111", "/usr/bin/node", "/repo/cli.js", { PATH: "/usr/bin" });
    expect(plain).not.toContain("WEMIND_HOME");
  });
});

describe("buildLaunchAgentPlist", () => {
  const env = {
    PATH: "/usr/local/bin",
    WEMIND_HOME: "/data/wemind & root",
  };
  const plist = buildLaunchAgentPlist(
    "aaa111",
    "/usr/bin/node",
    "/repo/cli.js",
    "/data/wemind & root/aaa111/daemon.log",
    env,
  );

  it("ProgramArguments 跑 daemon，不跑 start", () => {
    expect(plist).toContain("<string>daemon</string>");
    expect(plist).not.toContain("<string>start</string>");
  });

  it("带上账号、根目录和 PATH，并转义 XML 特殊字符", () => {
    expect(plist).toContain("<key>WECHAT_ACCOUNT</key>");
    expect(plist).toContain("<key>WECHAT_DATA_DIR</key>\n    <string></string>");
    expect(plist).toContain("<key>WEMIND_HOME</key>");
    expect(plist).toContain("<string>/data/wemind &amp; root</string>");
    expect(plist).toContain("<key>PATH</key>");
  });

  it("日志路径同时用于 stdout 与 stderr", () => {
    expect(plist.match(/<key>Standard(?:Out|Error)Path<\/key>/g)).toHaveLength(2);
  });

  it("没有 WEMIND_HOME 时不写该键", () => {
    const plain = buildLaunchAgentPlist("aaa111", "/usr/bin/node", "/repo/cli.js", "/tmp/a.log", {
      PATH: "/usr/bin",
    });
    expect(plain).not.toContain("<key>WEMIND_HOME</key>");
  });
});
