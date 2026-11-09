import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { MessageItemType, MessageState, MessageType } from "../api/types.js";
import { sendItem } from "./send-item.js";

let server: http.Server;
let baseUrl: string;
let seen: Array<{ url: string; body: string }>;
let responseBody = "{}";
let responseStatus = 200;

beforeEach(async () => {
  seen = [];
  responseBody = "{}";
  responseStatus = 200;
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body });
      res.writeHead(responseStatus, { "content-type": "application/json" });
      res.end(responseBody);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("sendItem", () => {
  it("每次只发一个 item，并带上 context_token / 收件人 / 状态", async () => {
    await sendItem({
      baseUrl,
      token: "tk",
      to: "user-1",
      contextToken: "ctx-1",
      state: MessageState.GENERATING,
      item: { type: MessageItemType.TOOL_CALL_START, tool_call_start_item: { tool_name: "read" } },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toContain("/sendmessage");
    const body = JSON.parse(seen[0]!.body) as {
      msg: {
        from_user_id: string;
        to_user_id: string;
        client_id: string;
        message_type: number;
        message_state: number;
        context_token: string;
        item_list: Array<{ type: number }>;
      };
    };
    expect(body.msg.from_user_id).toBe("");
    expect(body.msg.to_user_id).toBe("user-1");
    expect(body.msg.client_id).toMatch(/^item:/);
    expect(body.msg.message_type).toBe(MessageType.BOT);
    expect(body.msg.message_state).toBe(MessageState.GENERATING);
    expect(body.msg.context_token).toBe("ctx-1");
    expect(body.msg.item_list).toEqual([
      { type: MessageItemType.TOOL_CALL_START, tool_call_start_item: { tool_name: "read" } },
    ]);
  });

  it("默认 message_state 为 FINISH；空响应体返回 {}", async () => {
    await expect(
      sendItem({
        baseUrl,
        to: "u",
        item: {
          type: MessageItemType.TOOL_CALL_RESULT,
          tool_call_result_item: { status: "completed" },
        },
      }),
    ).resolves.toEqual({});
    const body = JSON.parse(seen[0]!.body) as { msg: { message_state: number } };
    expect(body.msg.message_state).toBe(MessageState.FINISH);
  });

  it("响应里的 uint64 message_id 按字符串返回", async () => {
    responseBody = '{"message_id": 7525055299038555001}';
    const resp = await sendItem({
      baseUrl,
      to: "u",
      item: { type: MessageItemType.TOOL_CALL_START },
    });
    expect(resp.message_id).toBe("7525055299038555001");
  });

  it("非 2xx 抛带状态的错误", async () => {
    responseStatus = 500;
    responseBody = "boom";
    await expect(
      sendItem({ baseUrl, to: "u", item: { type: MessageItemType.TOOL_CALL_START } }),
    ).rejects.toThrow(/sendMessage 500/);
  });
});
