# @wemind/wechat-ilink-core

> 微信 **iLink / ClawBot** Bot 协议的 TypeScript 内核——HTTP 客户端、协议类型、会话守卫、账号/状态持久化、CDN 媒体加解密、错误码。**不含任何「消费方」逻辑**（MCP / daemon），可独立用于自建 iLink bot。

[WeMind](https://github.com/imwangpan/WeMind) monorepo 的内核包；`@wemind/wechat-mcp`（MCP server）与 `wemind`（常驻守护）都依赖它，自身不依赖任何上层。

## 能力

| 模块 | 提供 |
|---|---|
| `api/client` | iLink CGI：`getUpdates`（长轮询收）/ `sendMessage`（发）/ `getConfig` / `sendTyping` / `notifyStart` / `notifyStop` / `fetchQRCode` / `pollQRStatus` |
| `api/types` | 协议类型（照抄 proto），每个字段附官方含义 + 实测注释 |
| `api/error-codes` | `ILinkError` / `classifyILinkCode` / `describeILinkCode`（`ret=-2` 参数错误、`errcode=-14` 会话过期） |
| `api/session-guard` | `-14` 会话过期后的进程内冷却（fail-closed，避免对死会话狂打） |
| `api/transport-errors` | 网络层错误分类（timeout/dns/tls/connection/network，判定是否可重试） |
| `store/account` | `account.json` / `state.json` 持久化（**原子写**）、数据目录解析（`WECHAT_ACCOUNT` / `WECHAT_DATA_DIR`） |
| `store/accounts` | 多账号注册表（`~/.wemind/accounts.json`） |
| `store/allow-from` | 发件人授权清单（allowFrom，配对授权） |
| `cdn/image` | CDN 媒体 AES-128-ECB 加解密：`downloadImage`（收图）/ `sendImage` / `sendFile`（发图/文件/视频） |

## 安装

> ⚠️ **本包不发布到 npm**（`private: true`，`npm view` 会 404）。它只有两个消费方，且都在本仓库里：
> [`@wemind/wechat-mcp`](../wechat-mcp) 与 [`@wemind/cli`](../wechat-daemon) 用 tsdown 把它**内联**进各自单文件产物。
> 想用这套 iLink 内核请 clone 仓库：`npm install` 后 workspace 会自动链接本包（`@wemind/wechat-ilink-core: "*"`）。

```bash
git clone https://github.com/imwangpan/WeMind.git
cd WeMind && npm install && npm run build   # core → daemon/mcp
```

## 用法

```ts
import {
  fetchQRCode, pollQRStatus,
  getUpdates, sendMessage, loadAccount,
} from "@wemind/wechat-ilink-core";

// 1) 扫码登录：fetchQRCode → 展示二维码 → 轮询 pollQRStatus 直到 status==="confirmed"，拿到 bot_token
// 2) 长轮询收消息（超时返回空，重轮询即可）
const resp = await getUpdates({ baseUrl, token, updatesBuf: state.updatesBuf });
// 3) 回复：必须带收到该用户消息时的 context_token
await sendMessage({ baseUrl, token, body: { msg: { to_user_id, item_list: [/* … */], context_token } } });
```

## 协议要点（详见 `src/api/types.ts` 注释）

- **公共头**：`iLink-App-Id` / `iLink-App-ClientVersion`（uint32 编码 `major<<16|minor<<8|patch`）/ `Authorization: Bearer <token>`。
- **context_token**：按 (账号, 用户) 缓存重用、**无时间 TTL**、仅会话过期(`-14`)时失效；回复必须携带，失效/不匹配会得到 `ret=-2`（参数错误）。
- **媒体**走 CDN + AES-128-ECB；登录 `get_bot_qrcode` 必须用 **POST**。
- 协议细节对照官方 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT）整理。

## License

MIT
