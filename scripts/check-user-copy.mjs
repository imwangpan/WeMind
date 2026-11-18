/**
 * 面向用户的文案检查：禁止直译腔与内部术语。
 *
 * 为什么要有：微信里的回执/提示是用户唯一能看到的东西，但我们（AI 与人）很容易把英文直译或内部黑话写进去——
 * 「把停在半路的任务全部拉起」「收掉发」这类句子，写的人不觉得，读的人要停顿一下。
 * 靠人读一遍不够稳，所以把「禁用词 → 怎么改」做成可执行的守卫，写新文案时 CI 直接拦下来。
 *
 * 扫描范围：`packages/wechat-daemon/src/**\/*.ts`，跳过测试与日志（日志是给开发者看的，不追求口语）。
 * 豁免：在违规那一行加 `copy-ok: <理由>`。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * 禁用词表：词 → 建议怎么说。
 * 只收「写的人看着挺顺、读的人要愣一下」的，不收正常书面语。
 */
export const BANNED = [
  { word: "停在半路", hint: "直译腔（halfway）。说「待继续」或「上次没跑完」" },
  { word: "拉起", hint: "直译腔（spawn/bring up）。说「恢复运行」「启动」" },
  { word: "收掉", hint: "生硬。说「结束」「关掉」" },
  { word: "兜底", hint: "内部术语。直接说发生什么，或说「保底的做法」" },
  { word: "口径", hint: "内部术语。说「说法」或「保持一致」" },
  { word: "落盘", hint: "内部术语。说「存到文件」" },
  { word: "幂等", hint: "内部术语。说「重复执行也不会出问题」" },
  { word: "埋点", hint: "内部术语。说「记录日志」" },
];

/** 这些行是给开发者看的（日志/注释），不算面向用户的文案。 */
function isDeveloperLine(line) {
  const t = line.trim();
  if (!t) return true;
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return true;
  if (t.includes("copy-ok:")) return true;
  // 日志调用：`log.info(...)` / `console.warn(...)`
  return /\b(log|console)\.(info|warn|error|debug|log)\s*\(/.test(t);
}

/** 去掉行尾注释（注释是写给开发者的，不算文案）。
 * 只认「空白 + //」，避免把 URL 里的 // 当成注释。 */
function stripTrailingComment(line) {
  return line.replace(/(^|\s)\/\/.*$/, "$1");
}

/** 行里得有字符串字面量，才可能是在拼文案（避免把标识符算进来）。 */
function hasStringLiteral(line) {
  return line.includes('"') || line.includes("'") || line.includes("`");
}

/**
 * 找出文本里的违规。
 * @param {string} text 源码内容
 * @param {string} [file] 仅用于报告
 * @returns {{ file?: string, line: number, word: string, hint: string, text: string }[]}
 */
export function findViolations(text, file) {
  const out = [];
  text.split(/\r?\n/).forEach((raw, idx) => {
    if (isDeveloperLine(raw)) return;
    const code = stripTrailingComment(raw);
    if (!hasStringLiteral(code)) return;
    for (const { word, hint } of BANNED) {
      if (!code.includes(word)) continue;
      out.push({ file, line: idx + 1, word, hint, text: raw.trim().slice(0, 120) });
      break;
    }
  });
  return out;
}

/** 递归收集要检查的源码文件。 */
export function collectFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(p);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      if (entry.name.endsWith(".test.ts")) continue;
      out.push(p);
    }
  };
  walk(root);
  return out;
}

/** CLI 入口：有违规就打印并返回非零退出码。 */
export function main(root = path.join("packages", "wechat-daemon", "src")) {
  const files = collectFiles(root);
  const violations = files.flatMap((f) => findViolations(fs.readFileSync(f, "utf8"), f));
  if (!violations.length) {
    console.log("check-user-copy 通过：用户可见文案里没有直译腔/内部术语。");
    return 0;
  }
  for (const v of violations) {
    console.error(`${v.file}:${v.line}  「${v.word}」 — ${v.hint}`);
    console.error(`    ${v.text}`);
  }
  console.error(
    `\ncheck-user-copy 未通过：${violations.length} 处。改写，或在那一行加 \`// copy-ok: <理由>\` 豁免。`,
  );
  return 1;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  process.exit(main());
}
