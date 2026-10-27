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
      message: "Already logged in. Use logout first if you want to re-login.",
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
    message: "QR code expired. Call login_qrcode to generate a new one.",
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
      message: "Already logged in.",
      botId: account.botId,
      userId: account.userId,
    });
  }

  const qrState = loadQrState();
  if (!qrState) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      "No pending QR code. Call login_qrcode first.",
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
          "Login confirmed but server returned incomplete data.",
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
        message: "Login successful! Bot is now connected to WeChat.",
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
        "Login requires a verification code, which the MCP login flow does not support. Use the `wemind login` CLI instead, or try again later.",
      );

    case "scaned_but_redirect":
    case "binded_redirect": {
      const host = statusResponse.redirect_host ? ` (to ${statusResponse.redirect_host})` : "";
      return unsupportedResult(
        statusResponse.status,
        `Login requires an IDC redirect${host}, which the MCP login flow does not support. Use the \`wemind login\` CLI instead.`,
      );
    }

    case "wait":
      return jsonResult({
        status: "wait",
        message: "Waiting for QR code scan. Call check_qrcode_status again after scanning.",
      });

    default:
      // scaned / 其它未列状态：都还在服务端处理中，让 Agent 继续轮询
      return jsonResult({
        status: statusResponse.status,
        message:
          "QR code scanned, waiting for confirmation in WeChat. Call check_qrcode_status again.",
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

  return jsonResult({ status: "logged_out", message: "Logged out successfully." });
}
