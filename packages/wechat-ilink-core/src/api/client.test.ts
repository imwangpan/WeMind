import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

import {
  buildClientVersion,
  generateId,
  fetchQRCode,
  getConfig,
  getUpdates,
  getUploadUrl,
  notifyStart,
  pollQRStatus,
  sendMessage,
  sendTyping,
} from "./client.js";
import { ILinkError } from "./error-codes.js";

describe("buildClientVersion (uint32 0xMMNNPP 编码)", () => {
  it("正常三段版本", () => {
    expect(buildClientVersion("2.4.3")).toBe((2 << 16) | (4 << 8) | 3);
  });

  it("缺省分量补 0", () => {
    expect(buildClientVersion("1")).toBe(1 << 16);
    expect(buildClientVersion("1.2")).toBe((1 << 16) | (2 << 8));
  });

  it("非数字分量回落 0", () => {
    expect(buildClientVersion("abc")).toBe(0);
    expect(buildClientVersion("x.y.z")).toBe(0);
  });

  it("分量 > 255 被 &0xff 截断", () => {
    expect(buildClientVersion("256.0.0")).toBe(0); // 256 & 0xff === 0
    expect(buildClientVersion("257.1.0")).toBe((1 << 16) | (1 << 8)); // 257 & 0xff === 1
  });
});

describe("generateId", () => {
  it("格式为 prefix:timestamp-hex8", () => {
    expect(generateId("img")).toMatch(/^img:\d+-[0-9a-f]{8}$/);
  });

  it("连续两次不重复", () => {
    expect(generateId("x")).not.toBe(generateId("x"));
  });
});

// ===== 以下用本地 HTTP server 验证真实 fetch 行为（超时、错误码、非 JSON 响应）=====
// 这些是「假成功 / 卡死」类线上故障的根因所在，纯函数测试覆盖不到。

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

let server: http.Server;
let baseUrl: string;
let handler: Handler;
let seen: { url: string; headers: http.IncomingHttpHeaders; body: string }[];

beforeEach(async () => {
  seen = [];
  handler = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  };
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", headers: req.headers, body });
      handler(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("apiFetch（经 sendMessage 间接验证）", () => {
  it("带上全套公共请求头与 Authorization", async () => {
    await sendMessage({ baseUrl, token: " tk ", body: { msg: { to_user_id: "u" } } });

    const [{ url, headers, body }] = seen;
    expect(url).toBe("/ilink/bot/sendmessage");
    expect(headers["ilink-app-id"]).toBeTruthy();
    expect(headers["ilink-app-clientversion"]).toMatch(/^\d+$/);
    expect(headers["x-wechat-uin"]).toBeTruthy();
    expect(headers.authorizationtype).toBe("ilink_bot_token");
    expect(headers.authorization).toBe("Bearer tk"); // token 两端空白被裁掉
    // base_info 会被注入到每个请求体
    expect(JSON.parse(body).base_info.channel_version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("HTTP 非 2xx → 抛错，消息含状态码与（截断的）响应体", async () => {
    handler = (_req, res) => {
      res.writeHead(502, { "content-type": "text/html" });
      res.end("<html>bad gateway</html>");
    };
    await expect(sendMessage({ baseUrl, token: "t", body: { msg: {} } })).rejects.toThrow(
      /sendMessage 502: <html>bad gateway<\/html>/,
    );
  });

  it("HTTP 200 + 非 JSON 响应体 → 视为成功（不因解析失败误报）", async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.end("OK");
    };
    await expect(sendMessage({ baseUrl, token: "t", body: { msg: {} } })).resolves.toBeUndefined();
  });

  it("HTTP 200 + 空响应体 → 视为成功", async () => {
    handler = (_req, res) => res.end("");
    await expect(sendMessage({ baseUrl, token: "t", body: { msg: {} } })).resolves.toBeUndefined();
  });

  it("HTTP 200 但 ret≠0 → 抛 ILinkError（防「假成功」）", async () => {
    handler = (_req, res) => res.end(JSON.stringify({ ret: -2, errmsg: "bad token" }));
    const err = await sendMessage({ baseUrl, token: "t", body: { msg: {} } }).catch((e) => e);

    expect(err).toBeInstanceOf(ILinkError);
    expect(err.code).toBe(-2);
    expect(err.kind).toBe("param_error");
  });

  it("HTTP 200 且 ret=0 → 成功", async () => {
    handler = (_req, res) => res.end(JSON.stringify({ ret: 0 }));
    await expect(sendMessage({ baseUrl, token: "t", body: { msg: {} } })).resolves.toBeUndefined();
  });
});

describe("sendTyping", () => {
  it("同样校验响应体错误码（过去静默失效）", async () => {
    handler = (_req, res) => res.end(JSON.stringify({ ret: -2 }));
    await expect(
      sendTyping({ baseUrl, token: "t", body: { ilink_user_id: "u", status: 1 } }),
    ).rejects.toBeInstanceOf(ILinkError);
  });

  it("成功时把 status/ticket 原样透传", async () => {
    await sendTyping({
      baseUrl,
      token: "t",
      body: { ilink_user_id: "u", typing_ticket: "tk", status: 2 },
    });
    const sent = JSON.parse(seen[0].body);
    expect(sent).toMatchObject({ ilink_user_id: "u", typing_ticket: "tk", status: 2 });
  });
});

describe("getConfig", () => {
  it("errcode≠0 → 抛 ILinkError，并带上 errmsg", async () => {
    handler = (_req, res) => res.end(JSON.stringify({ errcode: -14, errmsg: "expired" }));
    const err = await getConfig({
      baseUrl,
      token: "t",
      ilinkUserId: "u",
      contextToken: "c",
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ILinkError);
    expect(err.kind).toBe("session_expired");
    expect(err.message).toContain("expired");
  });

  it("成功时返回 typing_ticket", async () => {
    handler = (_req, res) => res.end(JSON.stringify({ ret: 0, typing_ticket: "ticket" }));
    await expect(
      getConfig({ baseUrl, token: "t", ilinkUserId: "u", contextToken: "c" }),
    ).resolves.toMatchObject({ typing_ticket: "ticket" });
  });
});

describe("getUploadUrl", () => {
  it("ret≠0 → 抛 ILinkError（调用方不再需要重复校验）", async () => {
    handler = (_req, res) => res.end(JSON.stringify({ ret: -2, errmsg: "bad key" }));
    await expect(getUploadUrl({ baseUrl, token: "t", filekey: "k" })).rejects.toBeInstanceOf(
      ILinkError,
    );
  });

  it("只把协议字段发给服务端（不透传 baseUrl/token/timeoutMs）", async () => {
    await getUploadUrl({ baseUrl, token: "t", filekey: "k", rawsize: 1 });
    const sent = JSON.parse(seen[0].body);
    expect(sent).toMatchObject({ filekey: "k", rawsize: 1 });
    expect(sent).not.toHaveProperty("baseUrl");
    expect(sent).not.toHaveProperty("token");
    expect(sent).not.toHaveProperty("timeoutMs");
  });
});

describe("getUpdates（长轮询超时语义）", () => {
  it("超时（AbortError）→ 返回空结果并保留游标，不抛错", async () => {
    handler = () => {
      /* 不响应，让客户端超时 */
    };
    const resp = await getUpdates({ baseUrl, token: "t", updatesBuf: "cursor-1", timeoutMs: 150 });

    expect(resp).toMatchObject({ ret: 0, msgs: [], get_updates_buf: "cursor-1" });
  });

  it("正常返回 → 解析 msgs 与游标", async () => {
    handler = (_req, res) =>
      res.end(JSON.stringify({ ret: 0, msgs: [{ message_id: 7 }], get_updates_buf: "c2" }));

    const resp = await getUpdates({ baseUrl, token: "t", updatesBuf: "c1", timeoutMs: 5000 });
    expect(resp.msgs).toHaveLength(1);
    expect(resp.get_updates_buf).toBe("c2");
  });

  it("非 JSON 响应 → 抛带 label 的清晰错误（而非裸 SyntaxError）", async () => {
    handler = (_req, res) => res.end("<html>proxy error</html>");
    const err = await getUpdates({ baseUrl, token: "t", timeoutMs: 5000 }).catch((e) => e);

    expect(err.message).toMatch(/getUpdates：响应不是合法 JSON/);
    expect(err.message).toContain("<html>proxy error");
  });
});

describe("pollQRStatus", () => {
  // 超时分支（35s 常量）不在此处等待，与 getUpdates 的超时用例是同一实现模式（finally + AbortError）。
  it("连接被服务端中断 → 抛错（不误判成 wait）", async () => {
    handler = (_req, res) => res.destroy();
    await expect(pollQRStatus(baseUrl, "qr-1")).rejects.toThrow();
  });

  it("带 qrcode 查询参数、只带公共头（不带 Authorization）", async () => {
    handler = (_req, res) => res.end(JSON.stringify({ status: "wait" }));
    await pollQRStatus(baseUrl, "a b&c");

    const [{ url, headers }] = seen;
    expect(url).toBe("/ilink/bot/get_qrcode_status?qrcode=a%20b%26c");
    expect(headers["ilink-app-id"]).toBeTruthy();
    expect(headers.authorization).toBeUndefined();
  });

  it("HTTP 非 2xx → 抛错并带状态码", async () => {
    handler = (_req, res) => {
      res.writeHead(500);
      res.end("boom");
    };
    await expect(pollQRStatus(baseUrl, "qr")).rejects.toThrow(/pollQRStatus 500/);
  });
});

describe("fetchQRCode", () => {
  it("用 POST + local_token_list 请求（对齐官方实现）", async () => {
    handler = (_req, res) => res.end(JSON.stringify({ qrcode: "q", qrcode_img_content: "url" }));

    const resp = await fetchQRCode(baseUrl);
    expect(seen[0].url).toBe("/ilink/bot/get_bot_qrcode?bot_type=3");
    expect(JSON.parse(seen[0].body)).toMatchObject({ local_token_list: [] });
    expect(resp.qrcode).toBe("q");
  });
});

describe("notifyStart / notifyStop（best-effort）", () => {
  it("失败不抛，只记日志", async () => {
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => errors.push(args);

    try {
      handler = (_req, res) => {
        res.writeHead(500);
        res.end("nope");
      };
      await expect(notifyStart({ baseUrl, token: "t" })).resolves.toBeUndefined();
      expect(errors).toHaveLength(1);
      expect(String(errors[0])).toMatch(/notifyStart failed/);
    } finally {
      console.error = orig;
    }
  });
});
