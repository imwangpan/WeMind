import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { clineCredentialEnv } from "./cline-credentials.js";

/** 写一份最小可用的 Cline providers.json；返回 realHome。 */
function homeWith(providers: unknown, lastUsedProvider?: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-cline-creds-"));
  fs.mkdirSync(path.join(home, "data", "settings"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "data", "settings", "providers.json"),
    JSON.stringify({ lastUsedProvider, providers }),
  );
  return home;
}

describe("clineCredentialEnv（从 Cline providers.json 派生 ACP 认证变量）", () => {
  it("lastUsedProvider 有 apiKey → 产出 CLINE_PROVIDER + CLINE_API_KEY", () => {
    const home = homeWith(
      {
        "openai-compatible": {
          settings: { provider: "openai-compatible", apiKey: "sk-local", baseUrl: "http://x" },
        },
      },
      "openai-compatible",
    );
    try {
      expect(clineCredentialEnv(home, {})).toEqual({
        CLINE_PROVIDER: "openai-compatible",
        CLINE_API_KEY: "sk-local",
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("父进程显式给了 CLINE_PROVIDER 或 CLINE_API_KEY → 完全不接管（避免错配）", () => {
    const home = homeWith(
      { "openai-compatible": { settings: { apiKey: "sk-local" } } },
      "openai-compatible",
    );
    try {
      expect(clineCredentialEnv(home, { CLINE_PROVIDER: "custom" })).toEqual({});
      expect(clineCredentialEnv(home, { CLINE_API_KEY: "explicit" })).toEqual({});
      expect(clineCredentialEnv(home, { CLINE_PROVIDER: "x", CLINE_API_KEY: "y" })).toEqual({});
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("OAuth 条目没有 apiKey → 不接管（留给 Cline 自己的 tryRestoreAuth）", () => {
    const home = homeWith(
      { cline: { settings: { provider: "cline" }, auth: { refresh: "x", access: "y" } } },
      "cline",
    );
    try {
      expect(clineCredentialEnv(home, {})).toEqual({});
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("没有 lastUsedProvider / apiKey 为空 / 文件损坏 / 无 realHome → 空表，不抛", () => {
    const noLastUsed = homeWith({ a: { settings: { apiKey: "k" } } });
    const emptyKey = homeWith({ a: { settings: { apiKey: "   " } } }, "a");
    const broken = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-cline-creds-"));
    fs.mkdirSync(path.join(broken, "data", "settings"), { recursive: true });
    fs.writeFileSync(path.join(broken, "data", "settings", "providers.json"), "{not json");
    try {
      expect(clineCredentialEnv(noLastUsed, {})).toEqual({});
      expect(clineCredentialEnv(emptyKey, {})).toEqual({});
      expect(clineCredentialEnv(broken, {})).toEqual({});
      expect(clineCredentialEnv(undefined, {})).toEqual({});
      expect(clineCredentialEnv(path.join(os.tmpdir(), "no-such-cline-home"), {})).toEqual({});
    } finally {
      for (const h of [noLastUsed, emptyKey, broken])
        fs.rmSync(h, { recursive: true, force: true });
    }
  });
});
