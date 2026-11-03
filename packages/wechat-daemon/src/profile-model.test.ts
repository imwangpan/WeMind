import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  readProfileDefaultModel,
  acpOverrideHint,
  acpModelHint,
  stripWechatMcpEntries,
} from "./profile-model.js";

/**
 * 从 dsh 的 profile 用户层读默认模型：优先用户自己写的 `- id: acp`（ACP 路径真正生效的），否则 `agent-default-model`。
 * 定点解析（不引 YAML 依赖），读不到/没条目一律 null（调用方回退预设值）。测试覆盖真实文件里会出现的写法：注释、引号、CRLF、后面的条目。
 * 另外覆盖「缺 `- id: acp` 时给用户的提示」——WeMind 只提示、不替用户改配置。
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-profile-model-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function writeProfile(name: string, body: string): string {
  const home = path.join(root, name);
  fs.mkdirSync(path.join(home, "profiles", "acp"), { recursive: true });
  fs.writeFileSync(path.join(home, "profiles", "acp", "cordis.patch.yml"), body, "utf-8");
  return home;
}

let realHome = "";
beforeAll(() => {
  realHome = writeProfile(
    "real-dsh",
    [
      "# Your patch layer for this dsh profile",
      "- id: llm-pi-ai # magpie",
      "  name: '@deepseek-ai/dsh-llm-pi-ai'",
      "  config:",
      "    providers:",
      "      magpie:",
      "        models:",
      "          - id: auto/deepseek-v4.1-flash",
      "            name: DeepSeek-V4.1-Flash · routing group",
      "- id: agent-default-model # magpie",
      "  config:",
      "    provider: magpie",
      '    model: "auto/deepseek-v4.1-flash"',
      "- id: web-search-deepseek # magpie",
      "  config:",
      "    model: another/should-not-win",
      "",
    ].join("\r\n"),
  );
});

describe("readProfileDefaultModel", () => {
  it("抽出 agent-default-model 的 provider/model（引号/注释/CRLF 都处理）", () => {
    expect(readProfileDefaultModel(realHome, "acp")).toBe('["magpie","auto/deepseek-v4.1-flash"]');
  });

  it("profile 或文件不存在 → null", () => {
    expect(readProfileDefaultModel(realHome, "nope")).toBeNull();
    expect(readProfileDefaultModel(path.join(root, "no-home"), "acp")).toBeNull();
    expect(readProfileDefaultModel("", "acp")).toBeNull();
  });

  it("没有该条目 / 缺 provider 或 model → null", () => {
    const noEntry = writeProfile(
      "no-entry",
      ["- id: llm-pi-ai", "  config:", "    model: x", ""].join("\n"),
    );
    expect(readProfileDefaultModel(noEntry, "acp")).toBeNull();

    const half = writeProfile(
      "half",
      ["- id: agent-default-model", "  config:", "    provider: magpie", ""].join("\n"),
    );
    expect(readProfileDefaultModel(half, "acp")).toBeNull();
  });

  it("只读该条目，不会串到后面的条目", () => {
    const after = writeProfile(
      "after",
      [
        "- id: agent-default-model",
        "  config:",
        "    provider: magpie",
        "    model: auto/one",
        "- id: web-search-deepseek",
        "  config:",
        "    model: should-not-win",
        "",
      ].join("\n"),
    );
    expect(readProfileDefaultModel(after, "acp")).toBe('["magpie","auto/one"]');
  });
});

describe("用户层自己有 - id: acp 时（Agent 自己的配置优先）", () => {
  const withAcp = (acpModel: string, defModel: string) =>
    [
      "- id: agent-default-model",
      "  config:",
      "    provider: magpie",
      `    model: ${defModel}`,
      "- id: acp",
      "  config:",
      "    provider: magpie",
      `    model: ${acpModel}`,
      "",
    ].join("\n");

  it("readProfileDefaultModel 优先取 - id: acp 的 provider/model（那才是 ACP 路径真正生效的）", () => {
    const home = writeProfile("acp-yes", withAcp("auto/from-acp", "auto/from-default"));
    expect(readProfileDefaultModel(home, "acp")).toBe('["magpie","auto/from-acp"]');
  });

  it("- id: acp 缺 provider/model → 退回 agent-default-model", () => {
    const body = [
      "- id: agent-default-model",
      "  config:",
      "    provider: magpie",
      "    model: auto/from-default",
      "- id: acp",
      "  config:",
      "    provider: deepseek-official",
      "",
    ].join("\n");
    const home = writeProfile("acp-half", body);
    expect(readProfileDefaultModel(home, "acp")).toBe('["magpie","auto/from-default"]');
  });

  it("flow 式 config（`config: {provider: …, model: …}`）也读得到——DSH 一样会采用它", () => {
    const body = [
      "- id: agent-default-model",
      "  config:",
      "    provider: magpie",
      "    model: auto/from-default",
      "- id: acp",
      "  config: {provider: magpie, model: auto/from-acp}",
      "",
    ].join("\n");
    const home = writeProfile("acp-flow", body);
    expect(readProfileDefaultModel(home, "acp")).toBe('["magpie","auto/from-acp"]');
    expect(acpOverrideHint(home, "acp")).toBeNull();
  });

  it("acpOverrideHint：已配置 → null；缺 → 给出可直接粘贴的片段（值取自 agent-default-model）；名字里带 acp 不算已配置", () => {
    expect(
      acpOverrideHint(writeProfile("hint-yes", withAcp("auto/x", "auto/y")), "acp"),
    ).toBeNull();
    // 只有 `- id: acp-app-startup` / `name: '…/dsh-acp'` 这种「名字里带 acp」的，不算用户写了 acp 覆盖 → 仍要提示
    expect(
      acpOverrideHint(
        writeProfile(
          "hint-false-positive",
          [
            "name: '@deepseek-ai/dsh-acp'",
            "- id: acp-app-startup",
            "  config:",
            "    model: x",
            "",
          ].join("\n"),
        ),
        "acp",
      ),
    ).not.toBeNull();
    const hint = acpOverrideHint(
      writeProfile(
        "hint-no",
        [
          "- id: agent-default-model",
          "  config:",
          "    provider: magpie",
          "    model: auto/from-default",
          "",
        ].join("\n"),
      ),
      "acp",
    );
    expect(hint).toContain("没有配置 - id: acp");
    expect(hint).toContain(
      '- id: acp\n  config:\n    provider: "magpie"\n    model: "auto/from-default"',
    );
    expect(hint).toContain("加到那份文件末尾"); // 块式 profile：末尾追加即可
    // 文件不存在（dsh 还没生成过这份 profile）→ 不提示：说不清该改哪份文件
    expect(acpOverrideHint(path.join(root, "no-home"), "acp")).toBeNull();
  });

  it("profile 还是空壳 [] 时，提示「替换 [] 那一行」（追加在 [] 后面是非法 YAML），且值是占位符", () => {
    const home = writeProfile(
      "hint-shell",
      ["# Your patch layer for this dsh profile", "[]", ""].join("\n"),
    );
    const hint = acpOverrideHint(home, "acp")!;
    expect(hint).toContain("[] 那一行替换");
    expect(hint).not.toContain("加到那份文件末尾");
    expect(hint).toContain('provider: "<provider>"');
    expect(hint).toContain('model: "<model>"');
    expect(hint).toContain("占位符");
  });
});

describe("acpModelHint（- id: acp 的模型已被桌面端模型目录淘汰）", () => {
  const profileWith = (acpModel: string, catalog = ["auto/dfmodel", "auto/hy3"]) =>
    writeProfile(
      `acp-model-${acpModel.replace(/\W/g, "-")}-${catalog.join("-").replace(/\W/g, "-")}`,
      [
        "- id: llm-pi-ai # magpie",
        "  config:",
        "    providers:",
        "      magpie:",
        "        models:",
        ...catalog.flatMap((m) => [`          - id: ${m}`, `            name: ${m}`]),
        "- id: agent-default-model # magpie",
        "  config:",
        "    provider: magpie",
        `    model: "${catalog[0] ?? "auto/dfmodel"}"`,
        "- id: acp # 用户自己补的 ACP 模型",
        "  config:",
        "    provider: magpie",
        `    model: "${acpModel}"`,
        "",
      ].join("\n"),
    );

  it("model 不在该 provider 目录里 → 给出原因与可粘贴替换（优先建议 agent-default-model）", () => {
    const hint = acpModelHint(profileWith("auto/removed"), "acp")!;
    expect(hint).toContain("找不到这个模型");
    expect(hint).toContain("no configured model");
    expect(hint).toContain("auto/removed");
    expect(hint).toContain("auto/dfmodel");
    expect(hint).toContain(
      '- id: acp\n  config:\n    provider: "magpie"\n    model: "auto/dfmodel"',
    );
  });

  it("model 在目录里 / 缺 - id: acp → null（后者由 acpOverrideHint 负责）", () => {
    expect(acpModelHint(profileWith("auto/hy3"), "acp")).toBeNull();
    const missing = writeProfile(
      "acp-model-missing",
      ["- id: llm-pi-ai", "  config:", "    providers:", "      magpie: {}", ""].join("\n"),
    );
    expect(acpModelHint(missing, "acp")).toBeNull();
  });

  it("provider 目录找不到 → 仍提示，但只给占位符（不瞎猜别的 provider 的模型）", () => {
    const home = writeProfile(
      "acp-model-no-provider",
      [
        "- id: agent-default-model",
        "  config:",
        "    provider: magpie",
        "    model: auto/x",
        "- id: acp",
        "  config:",
        "    provider: missing-provider",
        "    model: old/model",
        "",
      ].join("\n"),
    );
    const hint = acpModelHint(home, "acp")!;
    expect(hint).toContain("missing-provider");
    expect(hint).toContain('model: "<model>"');
  });
});

describe("stripWechatMcpEntries（复制进沙箱前剔除微信 MCP，防回环）", () => {
  it("没有微信 MCP → 原文返回（逐字节复制不受影响）", () => {
    const text = ["# header", "- id: a", "  config:", "    model: x", ""].join("\n");
    expect(stripWechatMcpEntries(text)).toEqual({ text, removed: [] });
  });

  it("跑 wemind-mcp 的条目 → 只剔它，其余原样", () => {
    const text = [
      "- id: agent-default-model",
      "  config:",
      "    provider: magpie",
      "    model: auto/x",
      "- id: mcp-wx",
      "  name: '@deepseek-ai/dsh-mcp-client'",
      "  config:",
      "    serverName: other",
      "    command: npx",
      "    args: ['-y', '@wemind/wechat-mcp']",
      "- id: acp",
      "  config:",
      "    provider: magpie",
      "    model: auto/x",
      "",
    ].join("\n");
    const r = stripWechatMcpEntries(text);
    expect(r.removed).toEqual(["id: mcp-wx"]);
    expect(r.text).toBe(
      [
        "- id: agent-default-model",
        "  config:",
        "    provider: magpie",
        "    model: auto/x",
        "- id: acp",
        "  config:",
        "    provider: magpie",
        "    model: auto/x",
        "",
      ].join("\n"),
    );
  });

  it("serverName: wechat 的 mcp-client 条目也剔（名字/命令都可能不同）", () => {
    const text = [
      "- id: mcp-wechat",
      "  name: '@deepseek-ai/dsh-mcp-client'",
      "  config:",
      "    serverName: wechat",
      "    transport: stdio",
      "    command: node",
      "- id: mcp-github",
      "  name: '@deepseek-ai/dsh-mcp-client'",
      "  config:",
      "    serverName: github",
      "",
    ].join("\n");
    const r = stripWechatMcpEntries(text);
    expect(r.removed).toEqual(["id: mcp-wechat"]);
    expect(r.text).toContain("- id: mcp-github");
    expect(r.text).not.toContain("serverName: wechat");
  });

  it("普通 MCP（serverName 不是 wechat、也不跑 wemind-mcp）原样保留", () => {
    const text = [
      "- id: mcp-github",
      "  name: '@deepseek-ai/dsh-mcp-client'",
      "  config:",
      "    serverName: github",
      "    command: npx",
      "",
    ].join("\n");
    expect(stripWechatMcpEntries(text)).toEqual({ text, removed: [] });
  });

  it("CRLF 输入剔除后仍保持 CRLF", () => {
    const text = [
      "- id: a",
      "  config:",
      "    model: x",
      "- id: mcp-wx",
      "  command: wemind-mcp",
      "",
    ].join("\r\n");
    const r = stripWechatMcpEntries(text);
    expect(r.removed).toEqual(["id: mcp-wx"]);
    expect(r.text).toBe(["- id: a", "  config:", "    model: x", ""].join("\r\n"));
  });
});
