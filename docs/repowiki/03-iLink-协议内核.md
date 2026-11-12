# 3. iLink 协议内核（@wemind/wechat-ilink-core）

> 上一页：[2. 系统架构](02-系统架构.md) ｜ 下一页：[4. MCP Server](04-MCP-Server.md)
>
> **最后核对**：2026-11-10

协议内核是整个项目的地基：它封装了与腾讯 iLink 服务器通信的全部细节，对上提供纯粹、无状态依赖的 API。MCP server 和 daemon 都只依赖它。

它是 **JIT 源码包（source-first）**：`package.json` 的 `main`/`types`/`exports` 指向 `src/index.ts`，没有构建步骤与 `dist/`；workspace 内 tsc / Vitest / tsdown / tsx 直接使用源码，发布时由 tsdown 内联进两个发布包（见 [11.3 构建拓扑与产物](11-开发指南.md#113-构建拓扑与产物)）。

## 3.1 模块结构

```
packages/wechat-ilink-core/src/
├── index.ts              # barrel 导出（统一出口）
├── config.ts             # ILINK_APP_ID 常量
├── pkg-version.ts        # 读自身 package.json 的 version（MCP / CLI 的 version 命令都靠它）
├── api/
│   ├── client.ts         # iLink HTTP 客户端（核心）
│   ├── types.ts          # 完整协议类型定义
│   ├── message-id.ts     # uint64 消息 ID：无损 JSON 解析、比较、去重环
│   ├── error-codes.ts    # iLink 业务错误码（ret/errcode）
│   ├── transport-errors.ts  # 网络传输层错误分类
│   └── session-guard.ts  # 会话过期冷却
├── messaging/
│   └── send-item.ts      # 发单个结构化 item（工具进度 11/12 等）
├── store/
│   ├── account.ts        # 单账号凭证/状态持久化 + DATA_DIR 解析
│   ├── accounts.ts       # 多账号注册表
│   ├── allow-from.ts     # 授权发件人清单（安全闸）
│   └── file-lock.ts      # 跨进程写锁（accounts / allowFrom 的并发写保护）
└── cdn/
    ├── image.ts          # 收发图/文件的 AES 加解密 + CDN 上传下载
    └── media.ts          # 通用入站媒体下载（语音/文件/视频，按 media.aes_key）
```

`index.ts` 是一个 barrel 文件，把 `config` / `pkg-version` / `api/*` / `store/account` / `store/accounts` / `store/allow-from` / `cdn/image` / `cdn/media` / `messaging/send-item` 统一导出，依赖方只需 `import { ... } from "@wemind/wechat-ilink-core"`。注意 **`store/file-lock.ts` 不在 barrel 里**——它只供 core 内部（`accounts.ts` / `allow-from.ts`）使用，外部拿不到 `withFileLock`。新增的 `api/message-id.ts`、`cdn/media.ts`、`messaging/send-item.ts` 都有与源码同目录的测试；core 的测试文件与源码平铺，`api/error-codes.ts` 没有独立测试（由 `client.test.ts` 间接覆盖）。

## 3.2 HTTP 客户端（api/client.ts）

这是与 iLink 服务器对话的唯一出口。所有请求走 JSON over HTTP（POST 为主）。

### 公共请求头（连接的必要条件）

每个请求都要带 iLink 公共头，缺失会被服务端拒绝：

```
iLink-App-Id:            bot          （ILINK_APP_ID，env 可覆盖）
iLink-App-ClientVersion: <uint32>     （由客户端版本字符串编码）
```

客户端版本默认 `2.4.3`（模仿官方 openclaw-weixin，避免因版本过低被拒/二维码秒过期），可用 `ILINK_CLIENT_VERSION` 覆盖。版本字符串按 `0x00MMNNPP`（`major<<16 | minor<<8 | patch`）编码成 uint32 放进头里 —— 这个编码方式借鉴自官方实现。

POST 请求还会带：`Content-Type: application/json`、`AuthorizationType: ilink_bot_token`、随机 `X-WECHAT-UIN`，以及登录后 `Authorization: Bearer <token>`。

### 核心 API 一览

| 函数 | 端点 | 作用 | 超时 |
|------|------|------|------|
| `getUpdates` | `ilink/bot/getupdates` | 长轮询收消息（携带游标 `get_updates_buf`；uint64 ID 无损解析） | 默认 35s |
| `sendMessage` | `ilink/bot/sendmessage` | 发消息（文本/图片/文件/视频；返回解析后的响应，`message_id` 为字符串） | 15s |
| `sendItem` | `ilink/bot/sendmessage` | 发单个结构化 item（工具进度 11/12 等），每次只放一个 item | 15s |
| `sendTyping` | `ilink/bot/sendtyping` | 打字状态（显示/取消） | 15s |
| `getConfig` | `ilink/bot/getconfig` | 取 `typing_ticket`（sendTyping 必需） | 15s |
| `getUploadUrl` | `ilink/bot/getuploadurl` | 取 CDN 上传地址（发图/发文件） | 15s |
| `fetchQRCode` | `ilink/bot/get_bot_qrcode` | 取登录二维码（POST + `local_token_list`） | 15s |
| `pollQRStatus` | `ilink/bot/get_qrcode_status` | 轮询扫码状态 | 35s |
| `notifyStart` / `notifyStop` | `ilink/bot/msg/notifystart` `notifystop` | 上线/下线通知（best-effort，失败不阻断） | 15s |

### 两个健壮性细节

1. **超时与慢响应**：用 `AbortController` 控制超时，但要在**读完响应体后**才 `clearTimeout` —— 否则慢 body 不受超时保护，长轮询尤其可能无限阻塞。`getUpdates` / `pollQRStatus` 命中**自身超时**的 `AbortError` 时不抛错，而是返回「空结果」让调用方继续轮询；但**调用方主动取消**（signal 由外部 abort）时 `getUpdates` 会把该错误重新抛出——MCP 的 `cancelled` 返回就依赖这一点。

2. **HTTP 200 不等于成功**：iLink 即使 HTTP 200，响应体里也可能带非 0 的 `ret`/`errcode` 表示失败。所有「有语义响应体」的接口（`sendMessage` / `sendTyping` / `getConfig` / `getUploadUrl`）都走同一个 `throwIfErrorCode`，拿到非 0 错误码时抛 `ILinkError`（携带原始码 + 分类），避免「假成功」（消息其实没送达）；调用方不再需要自己重复校验。`throwIfErrorCode` **分别判断 `ret` 与 `errcode`**：`ret ?? errcode` 在 `ret=0`、`errcode=-14` 时会取到 0，把会话过期掩盖成成功。`getUpdates` 的 `errcode` 留给调用方处理（`-14` 要触发冷却），但 `ret≠0` 且无 `errcode` 时直接抛 `ILinkError`，否则会被当成「这轮没有新消息」静默空转。例外：`notifyStart` / `notifyStop` 是 best-effort，刻意只记日志不抛。**JSON 解析按接口分两类**：读类接口（`getUpdates` / `getConfig` / `getUploadUrl` / `fetchQRCode` / `pollQRStatus`）解析失败即抛带 label 与响应片段的清晰错误，而非裸 `SyntaxError`；写类接口（`sendMessage` / `sendTyping`）走 `tryParseJsonResp`，空或非 JSON 响应一律返回 `{}` 并**按成功处理**——HTTP 200 的代理错误页因此会被误判为「已送达」（已知局限，要根治需改代码）。两类解析都先经过 `parseJsonWithLosslessIds`：它给 `message_id` / `msg_id` / `svr_id` 这类 uint64 字段的**裸数字加引号**再 `JSON.parse`，因此 `sendMessage` 的响应 `message_id` 与 `getUpdates` 的游标都是字符串，不会丢精度。HTTP 非 2xx 抛 `HttpStatusError`（带状态码），由 `classifyTransportError` 判可重试性。

## 3.3 协议类型（api/types.ts）

这个文件照抄服务端 proto，是理解 iLink 数据模型的核心参考。字段绝大多数可选（服务端按场景下发）。proto 里的 `bytes` 在 JSON 中是 base64 字符串。

### 关键枚举

| 枚举 | 取值 | 含义 |
|------|------|------|
| `MessageType` | `USER=1` / `BOT=2` | 消息方向（入站为 USER） |
| `MessageItemType` | `TEXT=1` / `IMAGE=2` / `VOICE=3` / `FILE=4` / `VIDEO=5` / `TOOL_CALL_START=11` / `TOOL_CALL_RESULT=12` | 消息项类型（工具进度 item 见下方约定） |
| `MessageState` | `NEW=0` / `GENERATING=1` / `FINISH=2` | 消息状态（见下方关键约定） |
| `TypingStatus` | `TYPING=1` / `CANCEL=2` | 打字状态 |
| `UploadMediaType` | `IMAGE=1` / `VIDEO=2` / `FILE=3` / `VOICE=4` | 上传媒体类型 |

**`MessageState` 的关键约定**：文本进度/中间消息必须用 `GENERATING`，仅最终答案用 `FINISH`。因为 `FINISH` 会结束当前回合（关闭该 context 的发送窗口），如果文本进度也用 `FINISH` 会提前关掉会话。这是排查「重任务收不到结果」时纠正的关键认知（详见 [5. daemon](05-daemon.md)）。**结构化工具 item 是例外**：它们用 `FINISH`（官方实现如此，真机用 `GENERATING` 时客户端不显示）。

**工具进度 item 的状态**：官方 `@tencent-weixin/openclaw-weixin@2.4.10` 的协议里有 `TOOL_CALL_START=11` / `TOOL_CALL_RESULT=12`，其示例与实现都用 `FINISH`，并给同一回合的所有外发消息带同一个 `run_id`。但真机实测**微信客户端不渲染**：服务端返回 200/空响应、不分配 `message_id`；`weixin-agent-sdk-rs`（2026-08-13）穷举多种 wire 变体均无效，`run_id` 只影响服务端关联。WeMind 因此**默认只发文本「步骤 N」**，`WECHAT_TOOL_PROGRESS_ITEMS=1` 才发 item（代码已对齐 `FINISH` + `run_id`，且不占连发额度、不顶替固定提示；item 发送失败回退的文本按可见消息计一条额度；等微信端开放即可切回默认）。

### `context_token`：最易被误解的字段

`WeixinMessage.context_token` 是会话上下文令牌，发消息（回复）必须带它，否则被拒。它的真实规律（曾长期被误解、已纠正）：

- 按 `(账号, 用户)` **缓存、持久化、重用**；
- **没有文档化的时间 TTL**，仅在会话过期（errcode `-14`）/ 重新登录时失效；
- 回复应使用「收到该用户消息时携带的最新 token」；用陈旧/不匹配的 token 会得到 `ret=-2`（参数错误）。

### 消息体与引用

`WeixinMessage` 是统一消息体（收发都用）。一条消息的 `item_list` 是 `MessageItem[]`，每项是 text/image/voice/file/video/工具进度之一。**ID 字段是 uint64**（`WeixinMessage.message_id`、部分回包的 `msg_id`/`svr_id`），JS 里必须按字符串处理（见 §3.2）。

**`ref_msg`（引用/回复的原消息）挂在 `MessageItem` 上，不在 `WeixinMessage` 上** —— 上游原实现读 `WeixinMessage.ref_msg` 恒为 `undefined`（死代码），本项目修复为逐项查找。当前支持**内联引用**：`title` + `message_item` 的文本拼成 `[引用消息] …`；只有 `svr_id` 时给「引用消息内容未缓存」占位，不查缓存。

### 消息 ID（api/message-id.ts）

iLink 的 `message_id` 会到 `7525…` 量级（超过 `Number.MAX_SAFE_INTEGER`），直接 `JSON.parse` 会把相邻 ID 舍入成同一个数。`parseJsonWithLosslessIds()` 在解析前只给 `message_id` / `msg_id` / `svr_id` 的**裸整数**加引号（不碰字符串内容、不碰 `seq` 等普通数字；按完整 JSON number token 读取，`1.5`/`7.0e2` 这类非整数原样保留；改写失败时退回原始文本解析以免通道停摆，且仅当「原文合法、改写后反而非法」时打一条 warn，避免把改写逻辑的 bug 藏起来）；`compareMessageIds()` / `maxMessageId()` 用 BigInt 比较（非数字串退化为字典序），`normalizeMessageId()` 迁移旧版数字游标，`rememberMessageId()` 维护有上限的去重环。`state.json` 的 `lastMessageId` 现在是字符串、`seenMessageIds` 是字符串数组。

### 本地（非协议）类型

除协议类型外，还定义了写入磁盘用的本地类型：`AccountData`（账号凭证）、`ServerState`（运行状态：游标 + contextTokens + `lastMessageId: string` + `seenMessageIds?: string[]`）、`QrLoginState`（扫码暂存态）。

## 3.4 错误码体系（api/error-codes.ts）

iLink 有两个语义不同的错误字段，**它们不是按接口划分的**——同一个响应体里可能同时出现：

- `ret`：RPC 返回码，发送/上传类（`sendmessage` / `getuploadurl`）最常见；
- `errcode`：会话类错误码，`getupdates` 最常见，`sendTyping` / `getConfig` 的响应类型也声明了它。

`throwIfErrorCode` 对两个字段**分别检查**，任何一个非 0 都抛；唯一例外是 `getUpdates` 的 `errcode` 留给调用方处理（`-14` 要触发冷却）。

已知错误码：

| 码 | 字段 | 含义 | 处理 |
|----|------|------|------|
| `0` | ret | 成功 | — |
| `-2` | ret | 参数错误（Parameter error） | 检查请求参数 |
| `-14` | errcode | 会话过期（Session expired） | 重新登录（本项目对该账号冷却 1 小时） |

**关于 `-2` 的重要澄清**：官方定义是「参数错误」，**不是**「context_token 按时间过期」。常见诱因是 context_token 失效/不匹配，或被复用为**发送限流**（短时连续发送过多）。真正「按会话过期」的是 `-14`。**daemon 重启后** `state.contextTokens` 里是上次运行留下的 token，用户下一条消息之前它必然失效——这类「必须送达」的推送由 daemon 挂起、等新 token 到达再补发（见 [05-daemon](05-daemon.md#串行发送链)）。

模块提供：`classifyILinkCode`（归类为 `ok`/`param_error`/`session_expired`/`unknown`）、`describeILinkCode`（返回可读标签 + 处理建议）、`ILinkError` 类（携带 `code` + `kind`，消息可读如「参数错误(-2) — 检查请求参数」）。

## 3.5 传输层错误分类（api/transport-errors.ts）

与业务错误码正交，这里只管「网络传输」层面的失败。`classifyTransportError` 把 fetch/网络错误归类：

| kind | retryable | 触发 |
|------|-----------|------|
| `timeout` | 是 | AbortError（超时） |
| `dns` | 是 | ENOTFOUND |
| `connection` | 是 | ECONNRESET / socket hang up |
| `network` | 是 | ECONNREFUSED / fetch failed 等 |
| `http` | 429 / 5xx 是，其它 4xx 否 | `HttpStatusError`（HTTP 非 2xx） |
| `tls` | **否** | cert / tls / ssl 错误 |
| `unknown` | 否 | 其它 |

一个易踩的坑（已规避）：**TLS 判定必须排在 `fetch failed` 兜底之前**。Node fetch 的网络失败顶层恒为 `TypeError: fetch failed`，真正的 cert/tls 原因在 `err.cause` 里；若顺序反了，TLS 分支会被 `fetch failed` 先匹配成可重试，变成死代码。

## 3.6 会话守卫（api/session-guard.ts）

处理服务端 errcode `-14`（bot 会话超时）。命中后对该账号进入 1 小时冷却（内存 `Map<accountId, until>`），期间快速返回而非反复长轮询空转。

API：`pauseSession` / `isSessionPaused` / `getRemainingPauseMs` / `clearSessionPause`（重新登录成功后清除）。冷却逻辑有 vitest 单测覆盖（`session-guard.test.ts`，用假定时器验证 1 小时自动过期）。

## 3.7 存储层（store/）

### 数据目录解析（store/account.ts）

`DATA_DIR` 按优先级解析（`store/account.ts`）：

1. `WECHAT_DATA_DIR`：显式指定完整路径（最高优先级）；
2. 否则 `path.join(WEMIND_ROOT, ACCOUNT_KEY)` —— `WEMIND_ROOT` 定义在 `store/accounts.ts`：`WEMIND_HOME` 非空则用它，否则 `~/.wemind`；`ACCOUNT_KEY` 取自 `WECHAT_ACCOUNT`（默认 `default`）。

多账号即「不同 `WECHAT_ACCOUNT`（或不同 `WECHAT_DATA_DIR`）→ 不同目录 → 互相隔离」。**设了 `WEMIND_HOME` 时凭证不在 `~/.wemind`**——按 `<WEMIND_HOME>/<账号>` 找。

**原子写**：`account.ts` 的写入用「先写临时文件再 rename」（同盘 rename 原子），避免写途崩溃/并发产生半截损坏文件，写/rename 失败时会 `rmSync(tmp, { force: true })` 清掉临时文件。`accounts.ts` 与 `allow-from.ts` 也用同一套「临时文件 + rename」，但**没有失败清理**，异常时会留下 `*.tmp-<pid>-<时间戳>`（跨进程并发写由 `store/file-lock.ts` 的 `withFileLock` 串行化，锁文件为 `accounts.json.lock` / `allowFrom.json.lock`，带陈旧锁清理与超时）。**坏文件处理**：读取时若解析失败，不静默清空，而是备份坏文件（`.corrupt-<时间戳>`）+ 记日志，便于人工恢复。**错误不吞**：只有 `ENOENT`（文件不存在）才当作「首次运行」返回空；权限等 fs 错误会向上抛——否则调用方下一步 save 会覆盖掉真实凭证。删除类函数（`clearAccount` / `clearQrState`）返回布尔值表示是否真的删掉了；`clearAccount` 对非 ENOENT 的删除失败会**抛错**（调用方据此如实报告，不能把「删失败」与「本来就没登录」混为一谈），`clearQrState` 仍只记日志并返回 false。

**文件权限**：`account.json`（bot token）、`state.json`（`context_token`）、`qr_login.json`（扫码态）在 POSIX 下都由原子写在 rename **之前**收紧为 `600`，不会出现先 0644 再 chmod 的窗口。**Windows 权限提示**：`chmod` 是 no-op，文件以明文存放；保存凭证时会有一次性告警，提示用文件夹权限或磁盘加密保护。

提供 `loadAccount`/`saveAccount`/`clearAccount`、`loadState`/`saveState`/`resetState`、`loadQrState`/`saveQrState`/`clearQrState`。

### 账号注册表（store/accounts.ts）

管理 `~/.wemind` 下的多账号清单。

- `WEMIND_ROOT`：根目录（默认 `~/.wemind`，`WEMIND_HOME` 覆盖）。
- `deriveAccountKey(botId)`：把 botId（如 `feead781eb44@im.bot`）净化成可作目录名的唯一 key（`feead781eb44`）。
- 注册表 `accounts.json` 记录 `key → AccountMeta{key, botId, userId, baseUrl, label, addedAt}` 与默认账号。
- `label` 是人类可读别名（可改、可重复），`key` 始终唯一且由 botId 派生。
- API：`listAccounts` / `registerAccount` / `unregisterAccount` / `setLabel` / `getDefaultKey` / `setDefaultKey`。

### 授权清单（store/allow-from.ts）

每账号一份持久化的「登录者白名单」`allowFrom.json`（允许发消息的 userId 清单），取代单一环境变量白名单。它是**兜底校验**：微信平台只把消息发送给登录者本人，这道闸防的是「发送范围将来变化 / daemon 被接到别的入口」（daemon 大脑默认免审批，任何被接受的发件人都能驱动它）。

- 格式 `{ version, allowFrom: string[] }`（对齐官方 openclaw-weixin）。
- API：`readAllowFrom` / `addAllowFrom` / `removeAllowFrom` / `isAllowed`。
- **fail-closed**：清单文件损坏时返回空数组（全员锁死），并记日志 + 备份坏文件 —— 安全闸宁可锁死也不放行。

授权语义见 [8. 数据存储与多账号](08-数据存储与多账号.md#授权与安全)。

## 3.8 收发图与文件（cdn/image.ts、cdn/media.ts）

iLink 的图片/文件/视频/语音走微信 CDN，密文用 **AES-128-ECB（PKCS7）** 加解密。机制借鉴官方 openclaw-weixin。CDN 基础 URL 默认 `https://novac2c.cdn.weixin.qq.com/c2c`（`WECHAT_CDN_BASE_URL` 覆盖）。

### 收图：`downloadImage(img)`

1. 从 `media.full_url` 或 `media.encrypt_query_param` 拼下载 URL；
2. 解析 AES key（`resolveKey`：先看 `img.aeskey`（32 字符 hex，直接取用）；不满足再看 `img.media.aes_key`（base64，解出 16 字节直接用，或解出 32 字符 hex 字符串再转 hex），两者都不可用返回 `null`），下载密文（20s 超时）；响应体用 `readBodyWithLimit()` 边读边计数，超过 20MB 立即取消（`content-length` 只作提前拒绝提示）；
3. AES-128-ECB 解密返回明文 Buffer。

### 收语音/文件/视频：`downloadMediaBuffer()`

通用入站媒体下载（`cdn/media.ts`），与图片同一套 CDN/AES 机制，差异在 key 来源与上限：

- key 只来自 `media.aes_key`（base64 原始 16 字节，或 base64 的 32 字符 hex）；图片的 `image_item.aeskey` 仍优先（通过 `imageAeskey` 参数传入）；
- 默认上限 `WECHAT_INBOUND_MEDIA_MAX_MB=100`；`allowPlain` 为 true 时无 key 也按明文返回（仅供明确不需要解密的场景）；
- 无 `full_url` / `encrypt_query_param` 或 key 解析失败时抛带 label 的清晰错误。

daemon 侧的文件/视频落盘与语音转码见 [5. daemon](05-daemon.md#收发富媒体与消息类型)。

### 发图/发文件：`sendImage` / `sendFile`

发送链路：`getUploadUrl` 取上传地址 → AES-128-ECB 加密 → POST 上传 CDN（拿响应头 `x-encrypted-param`，3 次重试，4xx 不重试）→ 组装媒体引用 → `sendMessage` 发出。`no_need_thumb: true` 免缩略图（无需 sharp/jimp）。

`classifyMediaByName(name)` 按扩展名判类型（image/video/file），`sendFile` 据此组装对应的 `image_item` / `video_item` / `file_item`。类型识别与 item 组装借鉴自 wxclawbot-cli 与 wechat-robot-go（均 MIT）。

> 收发图 / 文件 / 视频 / 语音在 daemon 形态下的上层编排（从大脑回复里提取媒体引用、入站媒体落盘与喂给大脑）见 [5. daemon](05-daemon.md#收发富媒体与消息类型)。

---

接下来：[4. MCP Server](04-MCP-Server.md) 看协议内核如何被封装成 MCP 工具。
