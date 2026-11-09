import { afterEach, describe, expect, it, vi } from "vitest";

import { encryptAesEcb } from "./image.js";
import { buildCdnDownloadUrl, downloadMediaBuffer, resolveMediaKey } from "./media.js";

const KEY = Buffer.from("0123456789abcdef", "utf-8");
const HEX32 = KEY.toString("hex");

afterEach(() => vi.unstubAllGlobals());

describe("resolveMediaKey", () => {
  it("图片 aeskey（32 hex）优先", () => {
    expect(resolveMediaKey({ aes_key: "garbage" }, HEX32)?.equals(KEY)).toBe(true);
  });

  it("media.aes_key 支持 base64(raw16) 与 base64(hex32)", () => {
    expect(resolveMediaKey({ aes_key: KEY.toString("base64") })?.equals(KEY)).toBe(true);
    expect(
      resolveMediaKey({ aes_key: Buffer.from(HEX32, "utf-8").toString("base64") })?.equals(KEY),
    ).toBe(true);
  });

  it("缺失/非法 → null", () => {
    expect(resolveMediaKey(undefined)).toBeNull();
    expect(resolveMediaKey({ aes_key: "abc" })).toBeNull();
  });
});

describe("buildCdnDownloadUrl", () => {
  it("优先 full_url；否则拼 encrypt_query_param", () => {
    expect(buildCdnDownloadUrl({ full_url: "https://cdn/x" })).toBe("https://cdn/x");
    expect(buildCdnDownloadUrl({ encrypt_query_param: "a b&c" })).toMatch(
      /\/download\?encrypted_query_param=a%20b%26c$/,
    );
    expect(buildCdnDownloadUrl({})).toBe("");
  });
});

describe("downloadMediaBuffer", () => {
  it("按 media.aes_key 解密", async () => {
    const plain = Buffer.from("hello 微信 media", "utf-8");
    const cipher = encryptAesEcb(plain, KEY);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(cipher, { status: 200 })),
    );

    const got = await downloadMediaBuffer({
      media: { full_url: "https://cdn/x", aes_key: KEY.toString("base64") },
      label: "file",
    });
    expect(got.equals(plain)).toBe(true);
  });

  it("allowPlain 时无 key 按明文返回", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(Buffer.from("plain"), { status: 200 })),
    );
    const got = await downloadMediaBuffer({
      media: { full_url: "https://cdn/x" },
      allowPlain: true,
    });
    expect(got.toString()).toBe("plain");
  });

  it("无 key 且不允许明文 → 抛错", async () => {
    await expect(
      downloadMediaBuffer({ media: { full_url: "https://cdn/x" }, label: "voice" }),
    ).rejects.toThrow(/aes key/);
  });

  it("声明大小超限 → 下载前拒绝", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(Buffer.from("x"), {
            status: 200,
            headers: { "content-length": "100" },
          }),
      ),
    );
    await expect(
      downloadMediaBuffer({
        media: { full_url: "https://cdn/x" },
        imageAeskey: HEX32,
        maxBytes: 10,
      }),
    ).rejects.toThrow(/过大/);
  });

  it("HTTP 非 2xx → 抛错", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 })),
    );
    await expect(
      downloadMediaBuffer({ media: { full_url: "https://cdn/x" }, imageAeskey: HEX32 }),
    ).rejects.toThrow(/404/);
  });
});
