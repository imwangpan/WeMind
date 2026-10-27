/**
 * MCP 工具的返回体构造器。
 *
 * 6 个工具都返回同一形状（单条 text content + 结构化 JSON），过去每个分支都手写一遍
 * `{ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] }`——既啰嗦，也容易
 * 出现「有的分支缩进 2、有的 0」「漏写 null, 2」这类不一致。集中到这里后，改返回格式只需改一处。
 */

export type ToolResult = { content: Array<{ type: "text"; text: string }> };

/** 把任意可序列化结果包成 MCP 工具返回体（JSON 缩进 2，供 Agent 阅读）。 */
export function jsonResult(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

/** 纯文案返回体（例如二维码展示指引，本身就是给人/Agent 读的说明）。 */
export function textResult(text: string): ToolResult {
  return {
    content: [{ type: "text", text }],
  };
}
