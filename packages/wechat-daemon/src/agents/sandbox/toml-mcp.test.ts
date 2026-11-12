import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseTomlMcpServers } from "./toml-mcp.js";
import { assertNoForbiddenNativeMcp, nativeMcpServers } from "./mcp-sandbox.js";

const tmpDirs: string[] = [];
function codexHomeWith(toml: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-codex-home-"));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, "config.toml"), toml, "utf-8");
  return { name: "codex", realHome: dir, catalogFile: "config.toml" } as any;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Codex config.toml 只读 MCP 解析", () => {
  it("解析 command / args / 内联 env / 引号表名 / 子表 env", () => {
    const parsed = parseTomlMcpServers(`
model = "gpt-5"

[mcp_servers.files]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "D:\\\\work"]
env = { "API_KEY" = "abc", DEBUG = "1" } # 行内注释

[mcp_servers."my-server"]
command = "node"
args = ["server.js"]

[mcp_servers."my-server".env]
TOKEN = "t0ken"

[mcp_servers.remote]
url = "https://example.com/mcp"
`);
    expect(parsed.mcpServers).toMatchObject({
      files: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "D:\\work"],
        env: { API_KEY: "abc", DEBUG: "1" },
      },
      "my-server": { command: "node", args: ["server.js"], env: { TOKEN: "t0ken" } },
      remote: { url: "https://example.com/mcp" },
    });
  });

  it("忽略数组表与不认识的值，不影响其余条目", () => {
    const parsed = parseTomlMcpServers(`
[[profiles]]
name = "x"

[mcp_servers.ok]
command = "node"
args = [
  "a.js",
  "b.js",
]
`);
    expect(Object.keys(parsed.mcpServers)).toEqual(["ok"]);
    expect((parsed.mcpServers.ok as any).args).toEqual(["a.js", "b.js"]);
  });

  it("没有 mcp_servers 时返回空表", () => {
    expect(parseTomlMcpServers('model = "x"\n')).toEqual({ mcpServers: {} });
  });

  it("只对 Codex（.toml 目录）读原生 MCP；含 wechat 时拒绝启动", () => {
    const ok = codexHomeWith('[mcp_servers.fake]\ncommand = "node"\n');
    expect(Object.keys(nativeMcpServers(ok))).toEqual(["fake"]);
    expect(() => assertNoForbiddenNativeMcp(ok)).not.toThrow();

    const bad = codexHomeWith(
      '[mcp_servers.wechat]\ncommand = "npx"\nargs = ["-y", "@wemind/wechat-mcp"]\n',
    );
    expect(() => assertNoForbiddenNativeMcp(bad)).toThrow(/微信 MCP/);

    // 非 .toml 目录（其它 agent 的 JSON 配置）不归这里管：WeMind 会生成隔离后的副本
    expect(
      nativeMcpServers({
        name: "kiro",
        realHome: "/nope",
        catalogFile: "settings/mcp.json",
      } as any),
    ).toEqual({});
  });
});
