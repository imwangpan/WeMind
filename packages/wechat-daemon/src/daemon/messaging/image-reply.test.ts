import fss from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, afterAll, vi } from "vitest";

import {
  canSendImage,
  extractImages,
  imageFailureNote,
  planImageTurn,
  resolveImageBytes,
} from "./image-reply.js";

describe("extractImages", () => {
  it("提取 Markdown 图片并从正文移除", () => {
    const { images, text } = extractImages("看这张 ![cat](https://x.com/a.png) 图");
    expect(images.map((i) => i.src)).toEqual(["https://x.com/a.png"]);
    expect(text).not.toContain("a.png");
    expect(text).toContain("看这张");
  });

  it("提取本地路径的 Markdown 图片", () => {
    const { images } = extractImages("![](C:/tmp/x.png)");
    expect(images.map((i) => i.src)).toEqual(["C:/tmp/x.png"]);
  });

  it("提取裸图片 URL", () => {
    const { images } = extractImages("见 https://x.com/pic.jpg 末尾");
    expect(images.map((i) => i.src)).toEqual(["https://x.com/pic.jpg"]);
  });

  it("带 title 的 Markdown 图片只取 src", () => {
    const { images } = extractImages('![a](https://x.com/a.png "标题")');
    expect(images.map((i) => i.src)).toEqual(["https://x.com/a.png"]);
  });

  it("尖括号包裹的 src", () => {
    const { images } = extractImages("![a](<https://x.com/a.png>)");
    expect(images.map((i) => i.src)).toEqual(["https://x.com/a.png"]);
  });

  it("重复图片去重", () => {
    const { images } = extractImages("![a](https://x.com/a.png) 又 ![b](https://x.com/a.png)");
    expect(images.length).toBe(1);
  });

  it("markdown 图片里的 URL 不会被裸 URL 规则重复提取", () => {
    const { images } = extractImages("![x](https://x.com/a.png)");
    expect(images.length).toBe(1);
  });

  it("非图片扩展名的裸 URL 不提取", () => {
    const { images, text } = extractImages("见 https://x.com/page.html");
    expect(images).toEqual([]);
    expect(text).toContain("page.html");
  });

  it("无图片时返回原文（仅压缩多余空行）", () => {
    const { images, text } = extractImages("纯文本回复");
    expect(images).toEqual([]);
    expect(text).toBe("纯文本回复");
  });

  it("行内代码里的写法只是示例，不当作要发的图（2026-11-17 真机）", () => {
    const { images, text } = extractImages("图片直接写 `![](路径)` 就行");
    expect(images).toEqual([]);
    expect(text).toBe("图片直接写 `![](路径)` 就行");
  });

  it("围栏代码块里的图片语法也不发", () => {
    const src = ["示例：", "```md", "![图](C:/tmp/a.png)", "```", "完"].join("\n");
    const { images } = extractImages(src);
    expect(images).toEqual([]);
  });

  it("代码外的真图照发，代码内的示例忽略", () => {
    const src = ["写 `![](C:/tmp/示例.png)` 这样：", "![](C:/tmp/真图.png)"].join("\n");
    const { images, text } = extractImages(src);
    expect(images.map((i) => i.src)).toEqual(["C:/tmp/真图.png"]);
    expect(text).toContain("`![](C:/tmp/示例.png)`");
  });
});

describe("canSendImage（给最终文字留最后一条额度）", () => {
  it("上限 10 时，已发 8 条仍可发图（发完 9、答案 10）", () => {
    expect(canSendImage(7, 10)).toBe(true);
    expect(canSendImage(8, 10)).toBe(true);
  });

  it("已发 9 条时不再发图（否则最终文字没有额度）", () => {
    expect(canSendImage(9, 10)).toBe(false);
    expect(canSendImage(10, 10)).toBe(false);
  });
});

describe("planImageTurn（图片用不了时别丢文字、也别拿空 prompt 浪费回合）", () => {
  it("没有图片 / 图片可用：正常带图提问", () => {
    expect(planImageTurn(0, 0, false, false)).toEqual({ kind: "ok" });
    expect(planImageTurn(1, 1, true, false)).toEqual({ kind: "ok" });
  });

  it("全部下载失败但有文字：只按文字回答，并说明图片被忽略", () => {
    const plan = planImageTurn(2, 0, true, true);
    expect(plan.kind).toBe("text-only");
    expect(plan.kind === "text-only" && plan.note).toContain("图片没能下载下来");
  });

  it("大脑不支持看图但有文字：只按文字回答，并说明图片被忽略", () => {
    const plan = planImageTurn(1, 1, false, true);
    expect(plan.kind).toBe("text-only");
    expect(plan.kind === "text-only" && plan.note).toContain("不支持看图");
  });

  it("图片用不了且没有文字：直接拒绝（不问大脑）", () => {
    expect(planImageTurn(1, 0, true, false)).toMatchObject({ kind: "reject" });
    expect(planImageTurn(1, 1, false, false)).toMatchObject({ kind: "reject" });
  });
});

describe("resolveImageBytes 的 URL 安全闸", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("公网图片正常下载", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
      ),
    );
    await expect(resolveImageBytes("https://93.184.216.34/a.png")).resolves.toEqual(
      Buffer.from([1, 2, 3]),
    );
  });

  it("重定向到内网地址：拒绝，且不再对目标发起第二次请求", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        calls.push(String(u));
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/secret.png" },
        });
      }),
    );
    await expect(resolveImageBytes("https://93.184.216.34/a.png")).rejects.toThrow(/内网/);
    expect(calls).toEqual(["https://93.184.216.34/a.png"]);
  });

  it("重定向超过 3 跳：停止跟随并报错", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n += 1;
        return new Response(null, {
          status: 302,
          headers: { location: `http://93.184.216.34/r${n}.png` },
        });
      }),
    );
    await expect(resolveImageBytes("https://93.184.216.34/a.png")).rejects.toThrow(
      /重定向次数过多/,
    );
    expect(n).toBe(4); // 原请求 + 3 次跟随
  });
});

describe("resolveImageBytes 的本地路径安全闸", () => {
  const dir = fss.mkdtempSync(path.join(os.tmpdir(), "wemind-img-"));
  afterEach(() => {
    for (const f of fss.readdirSync(dir)) fss.rmSync(path.join(dir, f), { force: true });
  });
  afterAll(() => {
    fss.rmSync(dir, { recursive: true, force: true });
  });

  it("普通本地图片照常读", async () => {
    const file = path.join(dir, "shot.png");
    fss.writeFileSync(file, Buffer.from([9, 9]));
    await expect(resolveImageBytes(file)).resolves.toEqual(Buffer.from([9, 9]));
  });

  it("非图片扩展名拒绝", async () => {
    const file = path.join(dir, "notes.txt");
    fss.writeFileSync(file, "x");
    await expect(resolveImageBytes(file)).rejects.toThrow(/非图片文件/);
  });

  it("敏感名单里的文件名即使扩展名是图片也拒绝（凭证不能借图片通道外发）", async () => {
    const file = path.join(dir, "id_rsa.png");
    fss.writeFileSync(file, "secret");
    await expect(resolveImageBytes(file)).rejects.toThrow(/敏感文件/);
  });

  it("网络路径（UNC）拒绝", async () => {
    const sep = String.fromCharCode(92); // 拼 UNC，避免源码里的反斜杠转义歧义
    await expect(resolveImageBytes(`${sep}${sep}server${sep}share${sep}a.png`)).rejects.toThrow(
      /网络路径/,
    );
  });
});

describe("imageFailureNote（失败原因分开说，不把发送失败说成下载失败）", () => {
  it("没有失败 → 空串", () => {
    expect(imageFailureNote([])).toBe("");
  });

  it("下载失败与发送失败分别成段", () => {
    const note = imageFailureNote([
      { src: "https://x.com/a.png", reason: "download" },
      { src: "https://x.com/b.png", reason: "send" },
      { src: "https://x.com/c.png", reason: "send" },
    ]);
    expect(note).toContain("有 1 张图片没能下载下来");
    expect(note).toContain("有 2 张图片没能发出去");
    expect(note).toContain("https://x.com/a.png");
    expect(note).toContain("https://x.com/b.png");
    expect(note).toContain("https://x.com/c.png");
  });

  it("额度不足单独说明", () => {
    const note = imageFailureNote([{ src: "C:/tmp/x.png", reason: "budget" }]);
    expect(note).toContain("因接近微信连续发送上限没发");
    expect(note).not.toContain("下载");
  });
});
