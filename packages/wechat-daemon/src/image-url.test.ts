import { describe, it, expect } from "vitest";

import { assertPublicHttpUrl, isPrivateAddress } from "./image-url.js";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const privateLookup = async () => [{ address: "10.0.0.5", family: 4 }];
const mixedLookup = async () => [
  { address: "93.184.216.34", family: 4 },
  { address: "127.0.0.1", family: 4 },
];
const emptyLookup = async () => [];
const failingLookup = async () => {
  throw new Error("ENOTFOUND");
};

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "127.255.255.254",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "198.18.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "fec0::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
  ])("拒绝 %s", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "放行公网 %s",
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );

  it("不是 IP 字面量 → false（交给 DNS 解析后再判）", () => {
    expect(isPrivateAddress("example.com")).toBe(false);
  });
});

describe("assertPublicHttpUrl", () => {
  it("公网域名/IP 放行", async () => {
    await expect(
      assertPublicHttpUrl("https://example.com/a.png", publicLookup),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertPublicHttpUrl("http://93.184.216.34/a.png", publicLookup),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertPublicHttpUrl("http://[2606:4700:4700::1111]/a.png", publicLookup),
    ).resolves.toBeInstanceOf(URL);
  });

  it("本地文件路径不是 http(s) URL → 拒绝（本地路径走 resolveImageBytes 的文件分支）", async () => {
    await expect(assertPublicHttpUrl("C:/tmp/x.png", publicLookup)).rejects.toThrow(
      /只允许 http\/https/,
    );
  });

  it("非 http(s) 协议拒绝", async () => {
    await expect(assertPublicHttpUrl("file:///C:/tmp/x.png", publicLookup)).rejects.toThrow(
      /只允许 http\/https/,
    );
  });

  it("localhost 与 .localhost 子域拒绝（不查 DNS）", async () => {
    await expect(assertPublicHttpUrl("http://localhost/a.png", failingLookup)).rejects.toThrow(
      /内网/,
    );
    await expect(assertPublicHttpUrl("http://foo.localhost/a.png", failingLookup)).rejects.toThrow(
      /内网/,
    );
    await expect(assertPublicHttpUrl("http://LOCALHOST./a.png", failingLookup)).rejects.toThrow(
      /内网/,
    );
  });

  it("IP 字面量是内网 → 拒绝", async () => {
    await expect(assertPublicHttpUrl("http://127.0.0.1/a.png", publicLookup)).rejects.toThrow(
      /内网/,
    );
    await expect(assertPublicHttpUrl("http://[::1]/a.png", publicLookup)).rejects.toThrow(/内网/);
  });

  it("域名解析到内网 → 拒绝", async () => {
    await expect(assertPublicHttpUrl("https://evil.example/a.png", privateLookup)).rejects.toThrow(
      /10\.0\.0\.5/,
    );
  });

  it("解析结果里只要有一个内网地址就拒绝（防 DNS 轮询绕过）", async () => {
    await expect(assertPublicHttpUrl("https://evil.example/a.png", mixedLookup)).rejects.toThrow(
      /内网/,
    );
  });

  it("解析失败 / 空结果 → 拒绝", async () => {
    await expect(assertPublicHttpUrl("https://gone.example/a.png", failingLookup)).rejects.toThrow(
      /无法解析/,
    );
    await expect(assertPublicHttpUrl("https://empty.example/a.png", emptyLookup)).rejects.toThrow(
      /无法解析/,
    );
  });
});
