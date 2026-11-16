#!/usr/bin/env node
// ACP capability probe — thin wrapper around `wemind agent probe`.
//
// The implementation (JSON-RPC, reverse requests, load/resume, draft generation) lives in
// packages/wechat-daemon/src/acp/agent-probe.ts. This file only maps the historical
// ACP_* environment variables to CLI flags, so existing recipes keep working.
//
// Legacy default: send the two real prompts (same as the old script). Set ACP_NO_PROMPT=1
// for protocol-only probing. New callers can use `wemind agent probe` directly; it defaults
// to no prompt.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(ROOT, "packages/wechat-daemon/dist/cli.js");
const tsx = path.join(ROOT, "node_modules/tsx/dist/cli.mjs");
const src = path.join(ROOT, "packages/wechat-daemon/src/cli.ts");

function addValue(args, flag, value) {
  if (value !== undefined && value !== "") args.push(flag, value);
}

const args = ["agent", "probe", process.env.ACP_BIN || "opencode"];
addValue(args, "--args", process.env.ACP_ARGS || '["acp"]');
if (process.env.ACP_SHELL === "1") args.push("--shell");
addValue(args, "--cwd", process.env.ACP_CWD);
addValue(args, "--home-env", process.env.ACP_HOME_ENV);
addValue(args, "--home", process.env.ACP_HOME);
addValue(args, "--prompt", process.env.ACP_PROMPT);
addValue(args, "--second", process.env.ACP_SECOND);
addValue(args, "--tool-prompt", process.env.ACP_TOOL_PROMPT);
addValue(args, "--model", process.env.ACP_MODEL);
addValue(args, "--reasoning", process.env.ACP_REASONING);
addValue(args, "--timeout", process.env.ACP_TIMEOUT_MS);
addValue(args, "--mcp", process.env.ACP_TEST_MCP);
addValue(args, "--session-meta", process.env.ACP_SESSION_META);
addValue(args, "--name", process.env.ACP_NAME);
if (process.env.ACP_TEST_IMAGE === "1") args.push("--image");
if (process.env.ACP_TEST_TOOL === "1") args.push("--tool");
if (process.env.ACP_KEEP === "1") args.push("--keep");
if (process.env.ACP_HARD_KILL === "1") args.push("--hard-kill");
if (process.env.ACP_AUTO_ALLOW !== "1") args.push("--reject-permissions");
if (process.env.ACP_NO_PROMPT !== "1") args.push("--deep");
if (process.env.ACP_DRAFT === "1") args.push("--draft");
else args.push("--json");

const command = fs.existsSync(dist)
  ? [process.execPath, dist]
  : fs.existsSync(tsx)
    ? [process.execPath, tsx, src]
    : null;

if (!command) {
  console.error(
    "找不到已构建的 CLI，也没有本地 tsx。先运行 `npm run build`，或在仓库根目录执行 `npm install`。",
  );
  process.exitCode = 2;
} else {
  const result = spawnSync(command[0], [...command.slice(1), ...args], {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  process.exitCode = result.status ?? (result.error ? 1 : 0);
}
