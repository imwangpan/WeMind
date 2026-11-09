import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "@wemind/wechat-ilink-core";

import { ACP_AGENT_PRESETS } from "../../agents/brain-presets.js";
import {
  attachmentFailureNote,
  extractAttachments,
  isSensitiveFilePath,
  resolveAttachment,
} from "./attachments.js";

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemind-att-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("extractAttachments（显式附件语法）", () => {
  it("提取 [附件]/[文件]/[视频]，并从正文移除", () => {
    const { attachments, text } = extractAttachments(
      "给你 [附件](C:/tmp/a.pdf) 和 [视频](C:/tmp/b.mp4)，另见 [文件](C:/tmp/c.bin)",
    );
    expect(attachments.map((a) => a.kind)).toEqual([undefined, "video", "file"]);
    expect(attachments.map((a) => a.src)).toEqual(["C:/tmp/a.pdf", "C:/tmp/b.mp4", "C:/tmp/c.bin"]);
    expect(text).toBe("给你  和 ，另见");
  });

  it("支持尖括号包住带空格的路径", () => {
    const { attachments } = extractAttachments("[附件](<C:/tmp/带 空格.pdf>)");
    expect(attachments).toEqual([{ src: "C:/tmp/带 空格.pdf", kind: undefined }]);
  });

  it("尖括号路径可以包含 )；普通形式的 ) 不猜、保留原文", () => {
    expect(extractAttachments("[附件](<C:/tmp/report (1).pdf>)").attachments).toEqual([
      { src: "C:/tmp/report (1).pdf", kind: undefined },
    ]);
    const bare = "[附件](C:/tmp/report (1).pdf)";
    expect(extractAttachments(bare)).toEqual({ attachments: [], text: bare });
  });

  it("http(s) 链接不按附件提取，保留原文", () => {
    const src = "[附件](https://example.com/a.pdf)";
    expect(extractAttachments(src)).toEqual({ attachments: [], text: src });
  });

  it("同一路径只提取一次", () => {
    const { attachments } = extractAttachments("[附件](C:/tmp/a.pdf) [附件](C:/tmp/a.pdf)");
    expect(attachments).toHaveLength(1);
  });
});

describe("resolveAttachment（读取与安全闸）", () => {
  it("读取绝对路径，按扩展名判定类型", () => {
    const dir = tmpDir();
    const file = path.join(dir, "报告.pdf");
    fs.writeFileSync(file, "hello");
    const r = resolveAttachment({ src: file });
    expect(r.data.toString()).toBe("hello");
    expect(r.fileName).toBe("报告.pdf");
    expect(r.kind).toBe("file");
  });

  it("file:// URL 与显式 [视频] 标签", () => {
    const dir = tmpDir();
    const file = path.join(dir, "clip.mp4");
    fs.writeFileSync(file, "v");
    expect(resolveAttachment({ src: pathToFileURL(file).href }).kind).toBe("video");
    expect(resolveAttachment({ src: file, kind: "file" }).kind).toBe("file");
  });

  it("相对路径拒绝", () => {
    expect(() => resolveAttachment({ src: "relative/a.pdf" })).toThrow(/绝对路径/);
  });

  it("敏感文件名拒绝（account.json/.env/密钥）", () => {
    const dir = tmpDir();
    for (const name of ["account.json", ".env", "server.pem", "id_rsa"]) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, "secret");
      expect(() => resolveAttachment({ src: file }), name).toThrow(/敏感文件/);
    }
  });

  it("agent 登录态/凭据文件拒绝（含 .auth 目录）", () => {
    const dir = tmpDir();
    for (const name of [
      ".credentials.json",
      ".credentials.yaml",
      "oauth_creds.json",
      "google_accounts.json",
      "auth.json",
      "providers.json",
      "models.json",
    ]) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, "secret");
      expect(() => resolveAttachment({ src: file }), name).toThrow(/敏感文件/);
    }
    const authUser = path.join(dir, ".auth", "user");
    fs.mkdirSync(path.dirname(authUser));
    fs.writeFileSync(authUser, "token");
    expect(() => resolveAttachment({ src: authUser })).toThrow(/敏感文件/);
  });

  it("brain-presets 里所有 credentialFiles 都被拦截（防止新增 agent 漏配）", () => {
    const home = tmpDir();
    const prev = process.env.WECHAT_BRAIN_HOME;
    process.env.WECHAT_BRAIN_HOME = home;
    try {
      const files = new Set<string>();
      for (const preset of Object.values(ACP_AGENT_PRESETS))
        for (const rel of [...(preset.credentialFiles ?? []), ...(preset.identityFiles ?? [])])
          files.add(rel);
      expect(files.size).toBeGreaterThan(0);
      for (const rel of files) expect(isSensitiveFilePath(path.join(home, rel)), rel).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.WECHAT_BRAIN_HOME;
      else process.env.WECHAT_BRAIN_HOME = prev;
    }
  });

  it("网络路径拒绝（file://host 与 UNC）", () => {
    expect(() => resolveAttachment({ src: "file://attacker/share/x.pdf" })).toThrow(/网络路径/);
    expect(() => resolveAttachment({ src: "\\\\attacker\\share\\x.pdf" })).toThrow(/网络路径/);
  });

  it("isSensitiveFilePath 识别控制桥/任务目录与沙箱 settings", () => {
    expect(isSensitiveFilePath(path.join(DATA_DIR, "control-in", "x.json"))).toBe(true);
    expect(isSensitiveFilePath(path.join(DATA_DIR, "task-out", "x.json"))).toBe(true);
    expect(isSensitiveFilePath(path.join(DATA_DIR, "worker-home", "settings.json"))).toBe(true);
    expect(isSensitiveFilePath(path.join(DATA_DIR, "worker-home", "models-cache.json"))).toBe(true);
  });

  it("真实 agent home 的 settings.json / models*.json 被拦截", () => {
    expect(isSensitiveFilePath(path.join(os.homedir(), ".claude", "settings.json"))).toBe(true);
    expect(isSensitiveFilePath(path.join(os.homedir(), ".pi", "agent", "models-cache.json"))).toBe(
      true,
    );
  });

  it("软链接指向敏感文件仍被拦截（realpath 后判定）", () => {
    const dir = tmpDir();
    const target = path.join(dir, "account.json");
    fs.writeFileSync(target, "secret");
    const link = path.join(dir, "innocent.pdf");
    try {
      fs.symlinkSync(target, link, "file");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") return; // Windows 无权限建链接
      throw e;
    }
    expect(() => resolveAttachment({ src: link })).toThrow(/敏感文件/);
  });

  it("NTFS 数据流后缀不能绕过 denylist（Windows）", () => {
    if (process.platform !== "win32") return;
    const dir = tmpDir();
    const file = path.join(dir, "account.json");
    fs.writeFileSync(file, "secret");
    expect(() => resolveAttachment({ src: `${file}::$DATA` })).toThrow(/NTFS 数据流/);
  });

  it("超过大小上限拒绝", () => {
    const dir = tmpDir();
    const file = path.join(dir, "big.bin");
    fs.writeFileSync(file, Buffer.alloc(11));
    expect(() => resolveAttachment({ src: file }, 10)).toThrow(/文件过大/);
  });

  it("不存在/目录拒绝", () => {
    expect(() => resolveAttachment({ src: path.join(tmpDir(), "nope") })).toThrow();
    expect(() => resolveAttachment({ src: tmpDir() })).toThrow(/不是文件/);
  });
});

describe("attachmentFailureNote", () => {
  it("没有失败 → 空串；按原因分组", () => {
    expect(attachmentFailureNote([])).toBe("");
    const note = attachmentFailureNote([
      { src: "a.pdf", reason: "read" },
      { src: "b.pdf", reason: "send" },
      { src: "c.pdf", reason: "budget" },
    ]);
    expect(note).toContain("1 个附件没能读取/校验通过");
    expect(note).toContain("1 个附件没能发出去");
    expect(note).toContain("1 个附件因接近微信连续发送上限没发");
  });
});
