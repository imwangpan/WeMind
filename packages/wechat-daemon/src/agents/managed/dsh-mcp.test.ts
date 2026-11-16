import { describe, expect, it } from "vitest";

import { parseDshMcpServers, stripAllDshMcpEntries } from "./dsh-mcp.js";

const profile = [
  "- id: agent-default-model",
  "  config:",
  "    provider: magpie",
  "    model: auto/deepseek",
  "- id: mcp-github",
  "  name: '@deepseek-ai/dsh-mcp-client'",
  "  config:",
  "    serverName: github",
  "    transport: stdio",
  "    command: npx",
  "    args: ['-y', '@modelcontextprotocol/server-github']",
  "    env:",
  "      GITHUB_TOKEN: demo-token",
  "- insert:",
  "    - id: mcp-remote",
  "      name: '@deepseek-ai/dsh-mcp-client'",
  "      config:",
  "        serverName: remote",
  "        transport: http",
  "        url: https://example.invalid/mcp",
  "        headers:",
  "          Authorization: Bearer x",
  "",
].join("\n");

describe("DSH profile MCP 解析", () => {
  it("读 stdio 与 http 条目（含嵌套在 insert 下）", () => {
    expect(parseDshMcpServers(profile)).toEqual({
      github: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: "demo-token" },
      },
      remote: {
        url: "https://example.invalid/mcp",
        headers: { Authorization: "Bearer x" },
      },
    });
  });

  it("没有 mcp-client 条目时返回空表", () => {
    expect(parseDshMcpServers("- id: acp\n  config:\n    provider: x\n    model: y\n")).toEqual({});
  });

  it("剥离全部 MCP，并清掉变空的 insert 父项", () => {
    const { text, removed } = stripAllDshMcpEntries(profile);
    expect(removed.sort()).toEqual(["github", "remote"]);
    expect(text).not.toContain("@deepseek-ai/dsh-mcp-client");
    expect(text).not.toContain("- insert:");
    expect(text).toContain("- id: agent-default-model");
  });

  it("insert 里还有别的条目时只删 MCP 子项", () => {
    const mixed = [
      "- insert:",
      "    - id: mcp-github",
      "      name: '@deepseek-ai/dsh-mcp-client'",
      "      config:",
      "        serverName: github",
      "        command: npx",
      "    - id: other-plugin",
      "      name: '@deepseek-ai/other'",
      "",
    ].join("\n");
    const { text } = stripAllDshMcpEntries(mixed);
    expect(text).toContain("- insert:");
    expect(text).toContain("- id: other-plugin");
    expect(text).not.toContain("mcp-github");
  });
});
