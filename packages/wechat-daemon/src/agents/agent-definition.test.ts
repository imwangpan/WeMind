import { describe, it, expect } from "vitest";

import {
  AGENT_ADAPTER_API_VERSION,
  AGENT_DEFINITION_FIELDS,
  AGENT_DEFINITION_SCHEMA_VERSION,
  agentDefinitionJsonSchema,
  formatAgentDefinitionProblems,
  validateAgentDefinition,
} from "./agent-definition.js";

/**
 * 字段清单（故意写成字面量）：加/删字段必须同时改这里，防止"悄悄多了一个字段"。
 * 与 `AgentDefinition` 的类型一致性由 agent-definition.ts 里的编译期守卫负责。
 */
const EXPECTED_DATA_KEYS = [
  "name",
  "bin",
  "binWin",
  "fallbackBinPaths",
  "requiresBins",
  "args",
  "homeEnvVar",
  "extraConfigFiles",
  "shell",
  "realHome",
  "inheritDirs",
  "inheritFiles",
  "configSubdir",
  "mcpFormat",
  "mcpConfigFile",
  "catalogFile",
  "env",
  "envDefaults",
  "restore",
  "replayOnLoad",
  "firstFrameMs",
  "heartbeatMs",
  "images",
  "credentialFiles",
  "identityFiles",
  "settingsBase",
  "settingsDefaults",
  "model",
  "modelArg",
  "realProfile",
  "acpMcpServers",
  "mcpDelivery",
  "sessionMode",
  "kiroEngine",
  "isolateSessions",
  "notes",
];

/** 最小合法定义。 */
function minimal(): Record<string, unknown> {
  return {
    schemaVersion: AGENT_DEFINITION_SCHEMA_VERSION,
    name: "acme",
    bin: "acme-agent",
    args: ["serve", "--acp"],
  };
}

/** 贴近真实的完整定义（字段与内置预设同形），用来抓字段表里的笔误。 */
function full(): Record<string, unknown> {
  return {
    schemaVersion: AGENT_DEFINITION_SCHEMA_VERSION,
    name: "acme",
    bin: "acme",
    binWin: "acme.cmd",
    fallbackBinPaths: ["/opt/acme/bin/acme"],
    requiresBins: ["acme-runtime"],
    args: ["--acp", "--yolo"],
    homeEnvVar: "ACME_HOME",
    extraConfigFiles: ["/home/u/.acme.json"],
    shell: true,
    realHome: "/home/u/.acme",
    inheritDirs: ["skills"],
    inheritFiles: ["AGENTS.md"],
    configSubdir: "acme",
    mcpFormat: "mcpServers",
    mcpConfigFile: "mcp.json",
    catalogFile: "mcp.json",
    env: { ACME_MODE: "headless" },
    envDefaults: { ACME_PERMISSION_MODE: "danger-full-access" },
    restore: "resume",
    replayOnLoad: true,
    firstFrameMs: 60_000,
    heartbeatMs: 60_000,
    images: false,
    credentialFiles: ["auth.json"],
    identityFiles: ["machine_id"],
    settingsBase: "settings.json",
    settingsDefaults: { quietStartup: true },
    model: "acme-flash",
    modelArg: "--model",
    realProfile: "acp",
    acpMcpServers: true,
    mcpDelivery: "acp",
    sessionMode: "bypassPermissions",
    kiroEngine: false,
    isolateSessions: true,
    notes: ["这条说明只作文档用途"],
    probe: { at: "2026-11-16T10:00:00Z", agentVersion: "1.2.3" },
  };
}

function problemsOf(raw: unknown): string[] {
  const r = validateAgentDefinition(raw);
  if (r.ok) throw new Error("期望校验失败，实际通过了");
  return formatAgentDefinitionProblems(r.problems);
}

describe("agent-definition 字段表", () => {
  it("字段表与 AgentDefinition 的数据字段逐一对齐（无缺失、无多余、无重复）", () => {
    const keys = AGENT_DEFINITION_FIELDS.map((f) => f.key);
    expect(keys.length).toBe(EXPECTED_DATA_KEYS.length);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...EXPECTED_DATA_KEYS].sort());
  });

  it("标记为「语义由 adapter 解释」的字段恰好是 realProfile / kiroEngine / isolateSessions", () => {
    const coded = AGENT_DEFINITION_FIELDS.filter((f) => f.codeInterpreted).map((f) => f.key);
    expect(coded.sort()).toEqual(["isolateSessions", "kiroEngine", "realProfile"]);
  });

  it("每个字段都有取值形状与非空描述", () => {
    for (const f of AGENT_DEFINITION_FIELDS) {
      expect(f.kind, f.key).toBeTruthy();
      expect(f.desc.length, f.key).toBeGreaterThan(0);
    }
  });
});

describe("validateAgentDefinition 正常路径", () => {
  it("最小定义通过，且必填只有 schemaVersion / name / bin / args", () => {
    const r = validateAgentDefinition(minimal());
    expect(r.ok).toBe(true);
    const required = AGENT_DEFINITION_FIELDS.filter((f) => f.required).map((f) => f.key);
    expect(required.sort()).toEqual(["args", "bin", "name"]);
  });

  it("完整定义通过，且返回值只含已知键（结构原样保留）", () => {
    const input = full();
    const r = validateAgentDefinition(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual(input);
    expect(Object.keys(r.value).sort()).toEqual(Object.keys(input).sort());
  });

  it("args 允许空数组（适配器类 agent 的常见形态）", () => {
    const r = validateAgentDefinition({ ...minimal(), args: [] });
    expect(r.ok).toBe(true);
  });
});

describe("validateAgentDefinition 失败路径", () => {
  it("缺 schemaVersion / name / bin / args 时四个问题一次报全", () => {
    const msgs = problemsOf({});
    expect(msgs).toEqual([
      "schemaVersion: 缺少 schemaVersion（当前为 1）",
      "name: 必填字段缺失",
      "bin: 必填字段缺失",
      "args: 必填字段缺失",
    ]);
  });

  it("schemaVersion 不符时 fail-closed（含'需要更新的 WeMind'提示），且不因未知版本放行", () => {
    const msgs = problemsOf({ ...minimal(), schemaVersion: 2 });
    expect(msgs).toEqual([
      "schemaVersion: 本版本只支持 schemaVersion 1（这份定义声明的是 2，需要更新的 WeMind）",
    ]);
  });

  it("schemaVersion 不是整数时报错", () => {
    expect(problemsOf({ ...minimal(), schemaVersion: 1.5 })).toContain("schemaVersion: 应为整数");
  });

  it("不是对象时报一个根级问题", () => {
    expect(problemsOf([])).toEqual(["(root): 定义应是一个 JSON 对象"]);
    expect(problemsOf(null)).toEqual(["(root): 定义应是一个 JSON 对象"]);
  });

  it("未知字段一律拒绝（拼错的字段名不能静默忽略）", () => {
    const msgs = problemsOf({ ...minimal(), realhome: "/home/u/.acme" });
    expect(msgs).toEqual(["realhome: 未知字段（字段名区分大小写；可用字段见定义规格）"]);
  });

  it("JSON 里真实存在的 __proto__ 键被当成未知字段拒绝，且不污染原型", () => {
    const raw = JSON.parse(
      '{"schemaVersion":1,"name":"acme","bin":"acme","args":[],"__proto__":{"polluted":true}}',
    );
    expect(problemsOf(raw)).toEqual([
      "__proto__: 未知字段（字段名区分大小写；可用字段见定义规格）",
    ]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("类型错误一次报全，路径带数组下标与对象键", () => {
    const msgs = problemsOf({
      ...minimal(),
      args: ["ok", 42, ""],
      images: "yes",
      firstFrameMs: 0,
      inheritDirs: ["skills", ""],
      env: { GOOD: "x", BAD: 1 },
      settingsDefaults: [],
    });
    // 问题按字段表顺序收集（不是按输入对象的键序），便于稳定对照。
    expect(msgs).toEqual([
      "args[1]: 应为非空字符串",
      "args[2]: 应为非空字符串",
      "inheritDirs[1]: 应为非空字符串",
      "images: 应为 true / false",
      "firstFrameMs: 应为正整数（毫秒）",
      "env.BAD: 值应为字符串",
      "settingsDefaults: 应为对象",
    ]);
  });

  it("name 必须是可作文件名/键的安全形态", () => {
    expect(problemsOf({ ...minimal(), name: "Acme Agent" })).toEqual([
      "name: 应为 ^[a-z0-9][a-z0-9._-]*$ 形式（agent 名（同时用作定义文件名、brain.json 键与微信指令里的名字）：小写字母/数字开头，后接小写字母、数字、`.`、`_`、`-`）",
    ]);
  });

  it("restore / mcpDelivery 只接受枚举值", () => {
    expect(problemsOf({ ...minimal(), restore: "reload" })).toEqual([
      "restore: 只能是 load / resume",
    ]);
    expect(problemsOf({ ...minimal(), mcpDelivery: "file" })).toEqual([
      "mcpDelivery: 只能是 config / acp",
    ]);
  });

  it("内置 mcpFormat 直接通过；自定义格式缺 adapter 时被拒，给了 adapter 才放行", () => {
    expect(validateAgentDefinition({ ...minimal(), mcpFormat: "mcp.servers" }).ok).toBe(true);
    expect(problemsOf({ ...minimal(), mcpFormat: "acme-yaml" })).toEqual([
      "mcpFormat: 未知的取值「acme-yaml」：内置只支持 mcpServers / mcp.servers / dshProfileYaml，自定义格式需要 adapter",
    ]);
    const withAdapter = validateAgentDefinition({
      ...minimal(),
      mcpFormat: "acme-yaml",
      adapter: { module: "wemind-agent-acme", apiVersion: AGENT_ADAPTER_API_VERSION },
    });
    expect(withAdapter.ok).toBe(true);
  });

  it("adapter 缺字段 / 未知键 / apiVersion 不符都报错", () => {
    expect(
      problemsOf({ ...minimal(), adapter: { module: "", apiVersion: AGENT_ADAPTER_API_VERSION } }),
    ).toEqual(["adapter.module: 应为非空字符串（包名或模块路径）"]);
    expect(problemsOf({ ...minimal(), adapter: { module: "m", apiVersion: 7 } })).toEqual([
      "adapter.apiVersion: 本版本只支持 hook 契约 1（这份 adapter 声明的是 7）",
    ]);
    expect(
      problemsOf({ ...minimal(), adapter: { module: "m", apiVersion: 1, hooks: [] } }),
    ).toEqual(["adapter.hooks: 未知字段（adapter 只接受 module / apiVersion）"]);
    expect(problemsOf({ ...minimal(), adapter: "m" })).toEqual([
      "adapter: 应为对象（{ module, apiVersion }）",
    ]);
  });

  it("probe 只接受 at + 可选的 agentVersion，且 at 要能解析成时间", () => {
    expect(validateAgentDefinition({ ...minimal(), probe: { at: "2026-11-16" } }).ok).toBe(true);
    expect(problemsOf({ ...minimal(), probe: { at: "昨天" } })).toEqual([
      "probe.at: 无法解析为时间：「昨天」（建议 ISO 8601，如 2026-11-16T10:00:00Z）",
    ]);
    expect(problemsOf({ ...minimal(), probe: { at: "2026-11-16", agentVersion: "" } })).toEqual([
      "probe.agentVersion: 应为非空字符串",
    ]);
    expect(problemsOf({ ...minimal(), probe: { at: "2026-11-16", source: "probe" } })).toEqual([
      "probe.source: 未知字段（probe 只接受 at / agentVersion）",
    ]);
  });
});

describe("agentDefinitionJsonSchema", () => {
  it("拒绝未知字段并声明必填项", () => {
    const schema = agentDefinitionJsonSchema();
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.additionalProperties).toBe(false);
    expect([...(schema.required as string[])].sort()).toEqual([
      "args",
      "bin",
      "name",
      "schemaVersion",
    ]);
  });

  it("每个数据字段在 schema 里都有对应属性，取值形状与字段表一致", () => {
    const props = agentDefinitionJsonSchema().properties as Record<string, Record<string, unknown>>;
    for (const f of AGENT_DEFINITION_FIELDS) expect(props[f.key], f.key).toBeTruthy();
    expect(Object.keys(props).sort()).toEqual(
      [...EXPECTED_DATA_KEYS, "adapter", "probe", "schemaVersion"].sort(),
    );
    expect(props.name.pattern).toBe("^[a-z0-9][a-z0-9._-]*$");
    expect(props.firstFrameMs).toEqual({
      type: "integer",
      minimum: 1,
      description: "首帧超时覆盖（毫秒）",
    });
    expect(props.restore.enum).toEqual(["load", "resume"]);
    expect(props.args).toEqual({
      type: "array",
      items: { type: "string", minLength: 1 },
      description: "进入 ACP 模式的启动参数（允许空数组）",
    });
    expect(props.env).toEqual({
      type: "object",
      propertyNames: { minLength: 1 },
      additionalProperties: { type: "string" },
      description: "managed 下强制注入的环境变量（值里 %HOME% → 副本根）",
    });
  });

  it("自定义 mcpFormat 必须同时给 adapter（条件必填也进了 schema）", () => {
    const schema = agentDefinitionJsonSchema();
    expect(schema.anyOf).toEqual([
      { required: ["adapter"] },
      { properties: { mcpFormat: { enum: ["mcpServers", "mcp.servers", "dshProfileYaml"] } } },
    ]);
    expect(schema.allOf).toBeUndefined();
  });

  it("语义由 adapter 解释的字段在描述里被标出来", () => {
    const props = agentDefinitionJsonSchema().properties as Record<string, Record<string, unknown>>;
    expect(String(props.kiroEngine.description)).toContain("语义由 adapter 解释");
    expect(String(props.realProfile.description)).toContain("语义由 adapter 解释");
    expect(String(props.images.description)).not.toContain("语义由 adapter 解释");
  });
});
