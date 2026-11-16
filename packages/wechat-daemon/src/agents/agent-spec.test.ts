import { describe, expect, it } from "vitest";

import { AGENT_DEFINITION_FIELDS } from "./agent-definition.js";
import { agentSpecJson, agentSpecMarkdown } from "./agent-spec.js";

describe("agent spec", () => {
  it("每个数据字段都有明确的获取位置，不落到默认兜底文案", () => {
    const spec = agentSpecJson() as {
      fields: Array<{ key: string; probe: string; where: string }>;
    };
    expect(spec.fields.map((f) => f.key)).toEqual(AGENT_DEFINITION_FIELDS.map((f) => f.key));
    for (const field of spec.fields) {
      expect(field.where, field.key).not.toContain("探针不能推断");
      expect(["probe", "deep", "manual"], field.key).toContain(field.probe);
    }
  });

  it("Markdown 说明书包含全部字段与安全边界", () => {
    const markdown = agentSpecMarkdown();
    for (const field of AGENT_DEFINITION_FIELDS) expect(markdown).toContain(`\`${field.key}\``);
    expect(markdown).toContain("只有显式 `--deep` 才会");
    expect(markdown).toContain("不要替用户自动切换大脑");
  });
});
