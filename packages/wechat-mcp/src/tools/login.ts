import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import QRCode from "qrcode";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";

import {
  fetchQRCode,
  pollQRStatus,
  notifyStart,
  notifyStop,
  clearSessionPause,
  loadAccount,
  saveAccount,
  clearAccount,
  loadQrState,
  saveQrState,
  clearQrState,
  resetState,
  DATA_DIR,
} from "@wemind/wechat-ilink-core";
import type { QRStatusResponse } from "@wemind/wechat-ilink-core";

import { jsonResult, textResult, type ToolResult } from "./tool-result.js";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";

/** 本地二维码 TTL：超过即视为过期，重新取一张，避免 Agent 拿着废码反复轮询。 */
const QR_TTL_MS = 5 * 60_000;

function isQrFresh(createdAt: number): boolean {
  return Date.now() - createdAt < QR_TTL_MS;
}

function qrPaths(): { png: string; txt: string } {
  return {
    png: path.join(DATA_DIR, "qrcode.png"),
    txt: path.join(DATA_DIR, "qrcode.txt"),
  };
}

/** 生成二维码的三种形式：PNG 图片 + 终端可渲染的 ANSI 文本。 */
async function saveQrPng(url: string): Promise<string> {
  const { png, txt } = qrPaths();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const [, terminal] = await Promise.all([
    QRCode.toFile(png, url, { width: 400, margin: 2 }),
    QRCode.toString(url, { type: "terminal", small: true }),
  ]);
  fs.writeFileSync(txt, terminal, "utf-8");
  return png;
}

function qrHelpText(qrUrl: string, qrPath: string, txtPath: string): string {
  return [
    "WeChat login QR code generated. You MUST do ALL of the following:",
    "",
    `1. Run \`cat ${txtPath}\` yourself to display the QR code in terminal for the user to scan.`,
    `2. Tell the user they can also open the image at: ${qrPath}`,
    `3. Tell the user they can also send this URL to WeChat and open it: ${qrUrl}`,
    "",
    "Important: Show ALL THREE options to the user. You must run the cat command yourself, do not ask the user to run it.",
    "Note: If the user's phone WiFi cannot load the page, ask them to switch to mobile data network.",
    "After the user scans the QR code, call check_qrcode_status to verify login.",
  ].join("\n");
}

export const loginQrcodeSchema = z.object({});

export async function loginQrcode(): Promise<ToolResult> {
  const account = loadAccount();
  if (account?.botToken) {
    return jsonResult({
      status: "already_logged_in",
      message: "已登录。如需重新登录，请先调用 logout。",
      botId: account.botId,
      userId: account.userId,
    });
  }

  const { png, txt } = qrPaths();
  const existing = loadQrState();
  const existingUrl = existing?.qrcodeUrl;

  // 复用未过期二维码；但图片文件可能被清理/未生成，缺了就按同一 URL 重新渲染，不必再打服务端。
  if (existing && isQrFresh(existing.createdAt) && existingUrl) {
    if (!fs.existsSync(png) || !fs.existsSync(txt)) {
      await saveQrPng(existingUrl);
    }
    return textResult(qrHelpText(existingUrl, png, txt));
  }

  const qrResponse = await fetchQRCode(DEFAULT_BASE_URL);
  const createdAt = Date.now();
  saveQrState({
    qrcode: qrResponse.qrcode,
    qrcodeUrl: qrResponse.qrcode_img_content,
    createdAt,
  });
  await saveQrPng(qrResponse.qrcode_img_content);

  return textResult(qrHelpText(qrResponse.qrcode_img_content, png, txt));
}

export const checkQrcodeStatusSchema = z.object({});

/** 二维码已过期时的统一返回（本地 TTL 与服务端 expired 两个分支共用）。 */
function expiredResult(): ToolResult {
  return jsonResult({
    status: "expired",
    message: "二维码已过期，请调用 login_qrcode 重新生成。",
  });
}

/** 需要 MCP 登录流程不支持的能力（验证码 / IDC 重定向）时，明确指路 CLI，而不是让 Agent 无限轮询。 */
function unsupportedResult(status: QRStatusResponse["status"], message: string): ToolResult {
  return jsonResult({ status, message });
}

export async function checkQrcodeStatus(): Promise<ToolResult> {
  const account = loadAccount();
  if (account?.botToken) {
    return jsonResult({
      status: "confirmed",
      message: "已登录。",
      botId: account.botId,
      userId: account.userId,
    });
  }

  const qrState = loadQrState();
  if (!qrState) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      "当前没有待验证的二维码，请先调用 login_qrcode。",
    );
  }

  if (!isQrFresh(qrState.createdAt)) {
    clearQrState();
    return expiredResult();
  }

  const statusResponse = await pollQRStatus(DEFAULT_BASE_URL, qrState.qrcode);

  switch (statusResponse.status) {
    case "confirmed": {
      const { bot_token, ilink_bot_id, ilink_user_id } = statusResponse;
      if (!bot_token || !ilink_bot_id || !ilink_user_id) {
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          "服务端已确认登录，但返回的凭证数据不完整，请重试登录。",
        );
      }
      const baseUrl = statusResponse.baseurl ?? DEFAULT_BASE_URL;

      saveAccount({
        botToken: bot_token,
        botId: ilink_bot_id,
        userId: ilink_user_id,
        baseUrl,
        savedAt: Date.now(),
      });
      clearQrState();

      // 重新登录成功：解掉该账号的 -14 冷却，并通知服务端上线（notifyStart 自身 best-effort）
      clearSessionPause(ilink_bot_id);
      await notifyStart({ baseUrl, token: bot_token });

      return jsonResult({
        status: "confirmed",
        message: "登录成功！机器人已连接到微信。",
        botId: ilink_bot_id,
        userId: ilink_user_id,
      });
    }

    case "expired":
      clearQrState();
      return expiredResult();

    case "need_verifycode":
    case "verify_code_blocked":
      return unsupportedResult(
        statusResponse.status,
        "本次登录需要输入验证码，MCP 登录流程不支持该步骤。请改用 `wemind login` 命令行完成登录，或稍后重试。",
      );

    case "scaned_but_redirect":
    case "binded_redirect": {
      const host = statusResponse.redirect_host
        ? `（需重定向到 ${statusResponse.redirect_host}）`
        : "";
      return unsupportedResult(
        statusResponse.status,
        `本次登录需要 IDC 重定向${host}，MCP 登录流程不支持该步骤。请改用 \`wemind login\` 命令行完成登录。`,
      );
    }

    case "wait":
      return jsonResult({
        status: "wait",
        message: "等待扫码。扫码完成后请再次调用 check_qrcode_status。",
      });

    default:
      // scaned / 其它未列状态：都还在服务端处理中，让 Agent 继续轮询
      return jsonResult({
        status: statusResponse.status,
        message: "已扫码，正在等待微信端确认。请再次调用 check_qrcode_status。",
      });
  }
}

export const logoutSchema = z.object({});

export async function logout(): Promise<ToolResult> {
  const account = loadAccount();
  if (account?.botToken) {
    // notifyStop 内部已是 best-effort，失败只记日志；这里不再重复吞错
    await notifyStop({ baseUrl: account.baseUrl, token: account.botToken });
  }

  clearQrState();
  resetState();
  clearAccount();

  return jsonResult({ status: "logged_out", message: "已登出，凭证已清除。" });
}
