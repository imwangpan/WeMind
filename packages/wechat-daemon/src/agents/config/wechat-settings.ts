import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "@wemind/wechat-ilink-core";

import { writeJsonAtomic } from "../../shared/io/atomic-json.js";

/**
 * 账号级微信行为设置（`<账号>/wechat-settings.json`）。
 *
 * 这里只放**WeMind 通道自身**的行为：同一份 Agent 配置，在微信聊天里的措辞可以比终端更精简。
 * Agent 的模型/权限/MCP/技能等属于 Agent 真实配置（或微信独享 overlay），不要往这个文件里塞。
 *
 * 每轮开始前读取，所以改完下一条消息就生效，不需要 reload 或新会话。
 */

/** 回复风格：目前只有 `concise`（精简）一档；`null` 表示不注入，行为与终端一致。 */
export type ReplyStyle = "concise";

export type WechatSettings = {
  version: 1;
  replyStyle: ReplyStyle | null;
};

/** 合法取值（CLI 用法文案与测试共用）。 */
export const REPLY_STYLE_VALUES: readonly ReplyStyle[] = ["concise"];

export function wechatSettingsPath(dir: string = DATA_DIR): string {
  return path.join(dir, "wechat-settings.json");
}

export function defaultWechatSettings(): WechatSettings {
  return { version: 1, replyStyle: null };
}

/**
 * 规范化 `replyStyle`：`null` / 空串 / `off` / `none` / `default` 都表示关闭；`concise` 表示精简。
 * 无法识别的值返回 `undefined`——调用方据此告警并按关闭处理，不要静默归到某一档。
 */
export function normalizeReplyStyle(raw: unknown): ReplyStyle | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "off" || v === "none" || v === "default") return null;
  if (v === "concise") return "concise";
  return undefined;
}

/** 每轮注入给大脑的提示；关闭时返回空串（调用方用 `filter(Boolean)` 拼 prompt 即可）。 */
export function replyStyleHint(style: ReplyStyle | null): string {
  if (style !== "concise") return "";
  return "（微信回复风格：精简。先给结论，不复述我的问题、不罗列中间过程，默认不超过 3 段；内容确实较长时先给摘要并问我是否展开。只影响措辞，不改变任务本身。）";
}

/** 读设置；缺文件/坏文件都回落默认（不注入），损坏只影响本次读取，不覆盖用户文件。 */
export function readWechatSettings(dir: string = DATA_DIR): {
  settings: WechatSettings;
  problem?: string;
} {
  let raw: unknown;
  const file = wechatSettingsPath(dir);
  if (!fs.existsSync(file)) return { settings: defaultWechatSettings() };
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return {
      settings: defaultWechatSettings(),
      problem: "wechat-settings.json 不是有效 JSON，已按「不注入回复风格」处理",
    };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      settings: defaultWechatSettings(),
      problem: "wechat-settings.json 不是对象，已按「不注入回复风格」处理",
    };
  }
  const style = normalizeReplyStyle((raw as Record<string, unknown>).replyStyle);
  if (style === undefined) {
    return {
      settings: defaultWechatSettings(),
      problem: `wechat-settings.json 的 replyStyle 取值无效（只支持 ${REPLY_STYLE_VALUES.join(" / ")} 或 off/null），已按「不注入回复风格」处理`,
    };
  }
  return { settings: { version: 1, replyStyle: style } };
}

export function saveWechatSettings(settings: WechatSettings, dir: string = DATA_DIR): void {
  writeJsonAtomic(wechatSettingsPath(dir), settings);
}

/** 新账号骨架：文件不存在才创建空设置，已存在绝不覆盖用户的选择。 */
export function ensureWechatSettings(dir: string = DATA_DIR): void {
  if (!fs.existsSync(wechatSettingsPath(dir)))
    writeJsonAtomic(wechatSettingsPath(dir), defaultWechatSettings());
}
