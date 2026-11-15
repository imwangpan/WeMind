#!/usr/bin/env node
/**
 * 改动影响检查：改了代码，必须同步改文档。
 *
 * 两种用法：
 *   npm run doc-impact           打印本次改动触发了哪些规则、每条规则要求同步哪些文档（只读、不失败）
 *   npm run doc-impact:check  断言这些文档确实也在本次 diff 里；缺一个就 exit 1
 *
 * 两层检查（--check 都跑，互不替代）：
 *   路径层    RULES 判断「该改的文档有没有出现在 diff 里」，只看路径不看内容；
 *   内容层    STALE_FACTS 读工作树里文档的最终内容，逐行找已登记为废弃的旧结论，报「文件:行号」。
 *             这一层与 diff 无关，也不受豁免影响：文档改了但结论没改到位，是路径层抓不到的假绿。
 *
 * 对比范围：
 *   默认        当前分支相对 main 的 merge-base（含工作区未提交改动）
 *   --staged    暂存区（pre-commit 用）
 *   --base REF  指定对比基准
 *
 * 豁免：
 *   --check 时认三种来源，任一含 `Docs-Impact: none — <理由>` 即放行。
 *   - pre-commit 阶段提交信息还不存在，读环境变量 DOCS_IMPACT（如 `DOCS_IMPACT=none — Pure refactor`）
 *   - CI / 本地已提交场景读环境变量 DOCS_IMPACT_MESSAGE（显式声明，覆盖整条对比范围）
 *   - 最近一次提交信息**只在对比范围恰好包含一个提交时**生效；多提交分支不能用 HEAD 的
 *     「Comment only」把整条分支的文档检查一起跳过
 *   允许的理由只有 Pure refactor / Comment only / Test update，见规则表末尾。
 *   豁免只放行 RULES 的路径检查，绝不放行 STALE_FACTS 的内容检查。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RULES, STALE_FACTS, VALID_ESCAPE_HATCH_REASONS } from "./doc-impact.rules.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** git 的输出可能超过 Node 默认 1MB maxBuffer（大分支/大文档 diff），显式放宽。 */
export const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function git(args) {
  // core.quotepath=false：否则中文路径会被写成 `"docs/...\345\244..."`，规则里的文档路径永远对不上。
  return execFileSync("git", ["-c", "core.quotepath=false", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: GIT_MAX_BUFFER,
  });
}

function tryGit(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

/** 还原 git 的 C 风格引号路径（`"docs/\346\226\207..."`）；未加引号的原样返回。 */
export function unquoteGitPath(raw) {
  const text = raw ?? "";
  if (!text.startsWith('"') || !text.endsWith('"') || text.length < 2) return text;
  const inner = text.slice(1, -1);
  const bytes = [];
  const simple = { n: 10, t: 9, r: 13, '"': 34, "\\": 92 };
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = inner[i + 1] ?? "";
    if (/^[0-7]{3}$/.test(inner.slice(i + 1, i + 4))) {
      bytes.push(Number.parseInt(inner.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(simple[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** 解析 `git diff --name-status -M`：每行是 `<状态>\t<路径>`，重命名是 `R100\t<旧>\t<新>`。 */
export function parseNameStatus(output) {
  const files = [];
  for (const raw of output.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const parts = raw.split("\t");
    const status = (parts[0] ?? "").trim();
    if (!status) continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      files.push({
        status: status[0],
        oldPath: unquoteGitPath(parts[1]),
        path: unquoteGitPath(parts[2]),
      });
    } else {
      files.push({ status: status[0], path: unquoteGitPath(parts[1]) });
    }
  }
  return files;
}

/**
 * 解析 `git diff -U0` 的新增行，格式为 `+<路径>\t<内容>`。
 *
 * 带上路径是必须的：否则 `scripts/*.mjs` 里读 `process.env` 也会触发「新增环境变量」规则，
 * 规则无法区分「包源码里的对外变量」与「脚本自己的内部开关」。
 */
export function parseAddedLines(output) {
  const lines = [];
  let current = null;
  for (const raw of output.split(/\r?\n/)) {
    if (raw.startsWith("+++ ")) {
      const p = unquoteGitPath(raw.slice(4));
      current = p === "/dev/null" ? null : p.replace(/^b\//, "");
      continue;
    }
    if (raw.startsWith("+") && current) lines.push(`+${current}\t${raw.slice(1)}`);
  }
  return lines;
}

/** 把文件状态行与新增内容行合成规则可读的数组：`"M path"`、`"+内容"`。 */
export function toRuleInput(files, addedLines) {
  const statusLines = files.map((f) => {
    const p = f.path ?? "";
    return `${f.status} ${p}`;
  });
  return [...statusLines, ...addedLines];
}

/** 从规则表的 docs 条目里取路径：`docs/x.md §6、§7` → `docs/x.md`。 */
export function docPathOf(entry) {
  const m = entry.match(/^[^\s]+?\.(?:md|txt)/);
  return m ? m[0] : entry.split(/\s+/)[0];
}

/** 文档条目是否在本次改动里（删除不算同步）。 */
export function docChanged(entry, changedPaths) {
  const p = docPathOf(entry);
  return changedPaths.has(p);
}

/**
 * 内容级校验只扫「结论会写在里面」的文件：仓库文档 + 包源码（日志文案也算结论）。
 * 刻意排除 scripts/：STALE_FACTS 的 pattern 字面量自身就写在 scripts/doc-impact.rules.mjs 里，
 * 扫到会自命中；同理排除依赖目录与构建产物。
 */
const STALE_SCAN_EXCLUDE = /^(?:\.worktrees\/|\.agents\/|\.git\/|scripts\/|node_modules\/)|(?:^|\/)node_modules\/|(?:^|\/)dist\//;

export function isStaleScanPath(rel) {
  if (!rel || rel.endsWith("/") || STALE_SCAN_EXCLUDE.test(rel)) return false;
  if (/^(?:AGENTS\.md|README\.md|llms\.txt)$/.test(rel)) return true;
  if (/^docs\/.*\.(?:md|txt)$/.test(rel)) return true;
  if (/^packages\/[^/]+\/README\.md$/.test(rel)) return true;
  return /^packages\/.*\.ts$/.test(rel);
}

/** 读工作树里文件的最终内容（含未跟踪文件）；删掉/读不到的文件跳过。 */
export function collectDocContents() {
  const tracked = (tryGit(["ls-files"]) ?? "").split(/\r?\n/);
  const untracked = (tryGit(["ls-files", "--others", "--exclude-standard"]) ?? "").split(/\r?\n/);
  const files = [];
  for (const rel of new Set([...tracked, ...untracked])) {
    if (!isStaleScanPath(rel)) continue;
    try {
      files.push({ path: rel, content: fs.readFileSync(path.join(ROOT, rel), "utf8") });
    } catch {
      // 索引里已删除、或临时文件被移走：它没有「仍写在文档里」的结论。
    }
  }
  return files;
}

/** allow 项的 path 可以是精确字符串，也可以是给一类文件用的正则。 */
function allowPathMatches(rule, rel) {
  return typeof rule === "string" ? rule === rel : rule.test(rel);
}

/**
 * 命中是否落在「有据可查的保留位置」。四个条件全都要满足：路径、所在章节、该行附加条件、
 * 以及文件全文里的约定标记。marker 是关键：版本边界声明或补注被删掉，allow 立刻失效。
 */
export function isStaleHitAllowed(allow, { rel, content, line, section }) {
  return allow.some((a) => {
    if (!a.path || !allowPathMatches(a.path, rel)) return false;
    if (a.section && !a.section.test(section)) return false;
    if (a.linePattern && !a.linePattern.test(line)) return false;
    if (a.marker && !a.marker.test(content)) return false;
    return true;
  });
}

/** 纯函数：逐行找已废弃结论，返回 [{ id, since, why, path, line, text }]。 */
export function checkStaleFacts(facts, files) {
  const hits = [];
  for (const fact of facts) {
    for (const file of files) {
      const lines = file.content.split(/\r?\n/);
      let section = "";
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (/^#{1,2} /.test(line)) section = line.trim();
        fact.pattern.lastIndex = 0;
        if (!fact.pattern.test(line)) continue;
        if (
          isStaleHitAllowed(fact.allow ?? [], {
            rel: file.path,
            content: file.content,
            line,
            section,
          })
        )
          continue;
        hits.push({
          id: fact.id,
          since: fact.since,
          why: fact.why,
          path: file.path,
          line: i + 1,
          text: line.trim().slice(0, 120),
        });
      }
    }
  }
  return hits;
}

/**
 * 内容级结论是否在 --check 下拦住本次执行。
 * 刻意不接收豁免结果：`Docs-Impact: none — Pure refactor` 是「这次改动不必同步文档」的出口，
 * 不是「仓库里可以继续留着已推翻的结论」的出口；ca63fcb / 621f0cb 就是靠它跳过整条分支。
 */
export function staleBlocksCheck(check, staleHits) {
  if (!check || !staleHits || staleHits.length === 0) return false;
  return true;
}

/** 解析豁免声明。格式：`Docs-Impact: none — Pure refactor`。 */
export function parseEscapeHatch(text) {
  if (!text) return null;
  const m = text.match(/Docs-Impact:\s*(none|required)\s*[—–-]\s*([^\r\n]+)/i);
  if (!m) return null;
  const reason = m[2].trim();
  return { status: m[1].toLowerCase(), reason, valid: VALID_ESCAPE_HATCH_REASONS.test(reason) };
}

/** 环境变量版本：只写理由部分（如 `none — Pure refactor`），补上标准前缀后复用同一个解析。 */
export function parseEscapeHatchEnv(value) {
  if (!value) return null;
  return parseEscapeHatch(value) ?? parseEscapeHatch(`Docs-Impact: ${value}`);
}

function resolveBase(explicit) {
  if (explicit) return explicit;
  if (tryGit(["rev-parse", "--verify", "origin/main"])) return "origin/main";
  if (tryGit(["rev-parse", "--verify", "main"])) return "main";
  return null;
}

function mergeBase(base) {
  return tryGit(["merge-base", base, "HEAD"])?.trim() || base;
}

function collectDiff({ staged, base }) {
  if (staged) {
    const nameStatus = git(["diff", "--cached", "--name-status", "-M"]);
    const content = git(["diff", "--cached", "-U0"]);
    return {
      files: parseNameStatus(nameStatus),
      added: parseAddedLines(content),
      commitCount: 0,
      dirty: false,
    };
  }
  const resolved = resolveBase(base);
  if (!resolved) return null;
  const mb = mergeBase(resolved);
  const nameStatus = git(["diff", "--name-status", "-M", mb]);
  const content = git(["diff", "-U0", mb]);
  const files = parseNameStatus(nameStatus);
  const added = parseAddedLines(content);
  const commitCount = Number(
    (tryGit(["rev-list", "--count", `${mb}..HEAD`]) ?? "").trim() || 0,
  );
  const dirty = Boolean(
    (tryGit(["status", "--porcelain", "--untracked-files=normal"]) ?? "").trim(),
  );

  // `git diff` 不含未跟踪文件；本地 verify 时常还没 git add，漏掉它们会让规则假绿。
  // 未跟踪文件整体当作新增：状态行 A + 每行内容都当新增行。
  const untracked = (tryGit(["ls-files", "--others", "--exclude-standard"]) ?? "")
    .split(/\r?\n/)
    .filter(
      (p) => p && !p.endsWith("/") && !p.startsWith(".worktrees/") && !p.startsWith(".agents/"),
    );
  for (const rel of untracked) {
    files.push({ status: "A", path: rel });
    try {
      const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
      added.push(...text.split(/\r?\n/).map((line) => `+${rel}\t${line}`));
    } catch {
      // 读不到就只记录路径，规则仍能看到「新增了这个文件」。
    }
  }
  return { files, added, commitCount, dirty };
}

/** 接入文档名归一化：大小写与连字符不参与比较（预设 `claude-code` ↔ 文件 `接入-ClaudeCode.md`）。 */
export function normalizeDocName(text) {
  return text
    .replace(/^.*[\\/]/, "")
    .replace(/^接入-/, "")
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** 从规则输入行取路径：状态行 `M path` / 新增行 `+path\t内容`。 */
function pathOfRuleLine(line) {
  if (line.startsWith("+")) {
    const tab = line.indexOf("\t");
    return tab > 0 ? line.slice(1, tab) : line.slice(1);
  }
  const m = line.match(/^[A-Z]+\s+(.+)$/);
  return m ? m[1] : "";
}

/** 规则声明 files 时，只把落在这些目录里的行交给 trigger。 */
function inRuleScope(rule, line) {
  if (!rule.files) return true;
  const p = pathOfRuleLine(line);
  return rule.files.some((dir) => {
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    return p === dir || p.startsWith(prefix);
  });
}

/** 触发所有规则，返回 [{ rule, dynamic, dynamicNames }]。dynamicNames 是 preset 规则从新增行里取到的预设名。 */
export function matchRules(rules, ruleInput, addedLines) {
  const results = [];
  for (const rule of rules) {
    const scopedInput = rule.files
      ? ruleInput.filter((line) => inRuleScope(rule, line))
      : ruleInput;
    if (!rule.trigger(scopedInput)) continue;
    let dynamic = false;
    let dynamicNames = [];
    if (rule.dynamicDoc) {
      const scopedAdded = rule.files
        ? addedLines.filter((line) => inRuleScope(rule, line))
        : addedLines;
      dynamicNames = [
        ...new Set(scopedAdded.map((line) => line.match(rule.dynamicDoc)?.[1]).filter(Boolean)),
      ];
      dynamic = dynamicNames.length > 0;
    }
    results.push({ rule, dynamic, dynamicNames });
  }
  return results;
}

export function readEscapeHatch({
  staged,
  allowCommitMessage = true,
  lastCommitMessage,
  env = process.env,
} = {}) {
  const fromEnv = env.DOCS_IMPACT;
  const fromMessage = env.DOCS_IMPACT_MESSAGE;
  const fromLastCommit =
    !staged && allowCommitMessage
      ? (lastCommitMessage ?? tryGit(["log", "-1", "--format=%B"]))
      : null;
  for (const parsed of [
    parseEscapeHatchEnv(fromEnv),
    parseEscapeHatchEnv(fromMessage),
    parseEscapeHatch(fromLastCommit),
  ]) {
    if (parsed) return parsed;
  }
  return null;
}

/** 只有「范围恰好一个提交且工作区干净」时，HEAD 的提交信息才覆盖本次检查的 diff。 */
export function commitMessageCoversDiff({ commitCount, dirty }) {
  return commitCount === 1 && !dirty;
}

function printRule(rule, missing) {
  console.log(`[${rule.id}] ${rule.why}`);
  for (const entry of rule.docs) {
    const mark = missing.length === 0 ? "  " : missing.includes(docPathOf(entry)) ? "  ✗" : "  ✓";
    console.log(`${mark} ${entry}`);
  }
  if (rule.note) console.log(`  注意：${rule.note}`);
  console.log("");
}

function printStaleHits(hits, check) {
  if (hits.length === 0) return;
  const write = (...args) => (check ? console.error(...args) : console.log(...args));
  write(
    check
      ? `doc-impact 内容校验未通过：${hits.length} 处已废弃结论仍写在文档里。\n`
      : `doc-impact 内容校验提示：${hits.length} 处已废弃结论仍写在文档里（--check 会失败）。\n`,
  );
  for (const h of hits) write(`  ${h.path}:${h.line} [${h.id}（${h.since} 起废弃）] ${h.text}`);
  write("");
  const seen = new Set();
  for (const h of hits) {
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    write(`  ${h.id} 的现行结论：${h.why}`);
  }
  write("");
  write(
    "豁免（`Docs-Impact: none`）只作用于文档路径规则，不能放行废弃结论；按上面的现行结论改正文，或在 scripts/doc-impact.rules.mjs 的 STALE_FACTS 里登记有据可查的保留位置。",
  );
}

function main(argv) {
  const check = argv.includes("--check");
  const staged = argv.includes("--staged");
  const baseIndex = argv.indexOf("--base");
  const base = baseIndex >= 0 ? argv[baseIndex + 1] : undefined;

  // 内容层与 diff 无关：读工作树最终内容，且必须在豁免判断之前独立结论。
  // 放在 collectDiff 之后是为了复用同一份 git 环境；没有对比基准时这一层仍要跑。
  const staleHits = checkStaleFacts(STALE_FACTS, collectDocContents());
  printStaleHits(staleHits, check);
  if (staleBlocksCheck(check, staleHits)) return 1;

  const diff = collectDiff({ staged, base });
  if (!diff) {
    console.log("没有可用的对比基准（main / origin/main 都不存在），跳过 doc-impact。");
    return 0;
  }
  if (diff.files.length === 0 && diff.added.length === 0) {
    console.log("本次改动为空，跳过 doc-impact。");
    return 0;
  }

  const ruleInput = toRuleInput(diff.files, diff.added);
  const triggered = matchRules(RULES, ruleInput, diff.added);
  if (triggered.length === 0) {
    console.log("没有触发任何文档同步规则。");
    return 0;
  }

  const changedPaths = new Set(diff.files.filter((f) => f.status !== "D").map((f) => f.path));

  const failures = [];
  for (const { rule, dynamicNames } of triggered) {
    const missing = rule.docs.map(docPathOf).filter((p) => !changedPaths.has(p));
    // anyOf：docs 是多篇候选文档，改任意一篇即可（如「脚本说明」分散在开发指南/部署运维两处）。
    // 默认语义是「每篇都必须改」：同一事实写在多处时，只改一处就是文档与代码不一致。
    const missingAfterAnyOf = rule.anyOf && missing.length < rule.docs.length ? [] : missing;
    for (const name of dynamicNames) {
      const wanted = normalizeDocName(`接入-${name}`);
      const changedDoc = [...changedPaths].some(
        (p) => p.startsWith("docs/接入方案/接入-") && normalizeDocName(p) === wanted,
      );
      if (!changedDoc) {
        missingAfterAnyOf.push(
          `docs/接入方案/接入-${name}.md（按预设名推导，大小写与连字符不敏感）`,
        );
      }
    }
    if (missingAfterAnyOf.length > 0) failures.push({ rule, missing: missingAfterAnyOf });
  }

  if (!check) {
    console.log(`本次改动触发 ${triggered.length} 条规则：\n`);
    for (const { rule } of triggered) printRule(rule, []);
    console.log(
      "提交前请同步上述文档，或用 `Docs-Impact: none — <理由>` 豁免（理由仅限 Pure refactor / Comment only / Test update）。",
    );
    return 0;
  }

  // 最近一次提交信息只对它自己的 diff 负责。分支对比是 merge-base..HEAD，
  // 多提交时不能拿 HEAD 的一句「Comment only」豁免整条分支。
  const escape = readEscapeHatch({
    staged,
    allowCommitMessage: commitMessageCoversDiff(diff),
  });
  if (escape?.status === "none") {
    if (escape.valid) {
      console.log(`豁免生效：${escape.status} — ${escape.reason}`);
      return 0;
    }
    console.error(`豁免理由不合法：${escape.reason}`);
    console.error("允许的理由只有：Pure refactor / Comment only / Test update。");
    return 1;
  }

  if (failures.length === 0) {
    console.log(`doc-impact 通过：${triggered.length} 条规则要求的文档都已在本次改动中同步。`);
    return 0;
  }

  console.error(`doc-impact 未通过：${failures.length} 条规则缺少文档同步。\n`);
  for (const { rule, missing } of failures) {
    console.error(`[${rule.id}] ${rule.why}`);
    for (const p of missing) console.error(`  缺少：${p}`);
    if (rule.note) console.error(`  注意：${rule.note}`);
    console.error("");
  }
  console.error("如确属纯重构/只改注释/只改测试，用 `Docs-Impact: none — <理由>` 豁免：");
  console.error('  pre-commit：DOCS_IMPACT="none — Pure refactor" git commit ...');
  console.error(
    "  单提交范围：在提交信息里加一行 `Docs-Impact: none — Pure refactor`",
  );
  console.error(
    '  多提交分支/CI：显式设置 DOCS_IMPACT_MESSAGE="none — Pure refactor"（提交信息不会跨提交生效）',
  );
  return 1;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
