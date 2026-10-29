/**
 * iLink Bot API 协议类型（照抄服务端 proto：GetUpdatesReq/Resp、WeixinMessage、SendMessageReq 等）。
 *
 * 来源与依据：
 *  - 字段与 proto 含义对照官方 Tencent/openclaw-weixin `src/api/types.ts` 整理（社区/官方最权威的公开实现）。
 *  - 错误码（ret / errcode）语义见 `error-codes.ts`。
 *  - 标 `[实测]` 的注释为 WeMind 在真机使用中验证/纠正的结论（详见笔记「迭代记录与待办」）。
 *
 * 约定：
 *  - 全部走 JSON over HTTP；proto 里的 bytes 字段在 JSON 中是 **base64 字符串**。
 *  - 协议字段绝大多数可选（服务端按场景下发），故统一用 `?`；本地自有类型（AccountData/ServerState/QrLoginState）按实际必填。
 */

/** 每个 CGI 请求都附带的公共元信息（proto: BaseInfo）。 */
export interface BaseInfo {
  /** 客户端版本号字符串（如 "2.4.3"）；另在请求头以 uint32 编码携带，见 client.ts。 */
  channel_version?: string;
  /**
   * 自声明的上游 bot/app 身份，类似 HTTP `User-Agent`（官方默认 "OpenClaw"）。
   * 仅用于服务端可观测（日志/监控聚合），**不参与鉴权或路由**。
   * [实测] WeMind 未设置此字段，不影响收发；保留以对齐 proto。
   */
  bot_agent?: string;
}

/** 消息方向（proto: MessageType）。USER=入站(用户发来)，BOT=出站(机器人发出)。 */
export const MessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2,
} as const;

/** 消息项类型（proto: MessageItemType）。一条消息的 item_list 里每项是其中一种。 */
export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

/**
 * 消息状态（proto: MessageState）。
 * - NEW=0：新消息。
 * - GENERATING=1：生成中（流式/进行中）。
 * - FINISH=2：本回合结束。
 * [实测] 关键：发送进度/中间消息用 **GENERATING**，仅最终答案用 **FINISH**——FINISH 会结束当前回合（关闭该 context 的发送窗口），若进度也用 FINISH 会提前关掉会话。
 *   详见笔记里程碑 21/23 与 README「进度提示与连续发送上限」。
 */
export const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

/** 打字状态（proto: TypingStatus）。1=显示「正在输入」，2=取消。配合 sendTyping 使用。 */
export const TypingStatus = {
  TYPING: 1,
  CANCEL: 2,
} as const;

/** 上传媒体类型（proto: UploadMediaType）。getUploadUrl 的 media_type 取值。 */
export const UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const;

export interface TextItem {
  text?: string;
}

/**
 * CDN 媒体引用（图片/语音/文件/视频共用）；`aes_key` 在 JSON 里是 base64。
 * 收图：从 encrypt_query_param 拼下载 URL（或 full_url）下载密文，AES-128-ECB 解密。
 */
export interface CDNMedia {
  /** 加密下载参数（拼接到 CDN download URL 上）。 */
  encrypt_query_param?: string;
  /** AES 密钥（base64）；入站解密时 ImageItem.aeskey(hex) 优先于此，见 ImageItem.aeskey。 */
  aes_key?: string;
  /** 加密类型：0=只加密 fileid，1=打包缩略图/中图等信息。 */
  encrypt_type?: number;
  /** 完整下载 URL（服务端直接返回时无需客户端拼接）。 */
  full_url?: string;
}

export interface ImageItem {
  /** 原图 CDN 引用。 */
  media?: CDNMedia;
  /** 缩略图 CDN 引用。 */
  thumb_media?: CDNMedia;
  /**
   * 原始 AES-128 密钥，hex 字符串（16 字节）。
   * [实测] 入站解密时**优先**用本字段，其次才回退 media.aes_key（见 cdn/image.ts resolveKey）。
   */
  aeskey?: string;
  url?: string;
  /** 中图密文大小（发图时回填，接收方据此解密）。 */
  mid_size?: number;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
  /** 高清原图密文大小。 */
  hd_size?: number;
}

export interface VoiceItem {
  media?: CDNMedia;
  /** 语音编码类型：1=pcm 2=adpcm 3=feature 4=speex 5=amr 6=silk 7=mp3 8=ogg-speex（微信语音为 silk=6）。 */
  encode_type?: number;
  bits_per_sample?: number;
  /** 采样率 (Hz)。 */
  sample_rate?: number;
  /** 语音长度 (毫秒)。 */
  playtime?: number;
  /**
   * 语音转文字内容（微信侧已转写）。
   * [实测] 收语音「省事路」：直接取此字段当文本喂大脑，零依赖、无需 SILK 解码或外接 ASR（见 daemon extractText）。
   */
  text?: string;
}

export interface FileItem {
  media?: CDNMedia;
  file_name?: string;
  md5?: string;
  /** 文件明文大小（字符串形式的字节数）。 */
  len?: string;
}

export interface VideoItem {
  media?: CDNMedia;
  /** 视频密文大小。 */
  video_size?: number;
  /** 时长（秒）。 */
  play_length?: number;
  video_md5?: string;
  /** 视频缩略图 CDN 引用。 */
  thumb_media?: CDNMedia;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
}

/** 被引用/回复的原消息（proto: RefMessage）。挂在 MessageItem.ref_msg 上，不在 WeixinMessage 上。 */
export interface RefMessage {
  message_item?: MessageItem;
  /** 摘要标题。 */
  title?: string;
}

export interface MessageItem {
  /** 见 MessageItemType。 */
  type?: number;
  create_time_ms?: number;
  /** 最后更新时间（编辑/流式更新时）。 */
  update_time_ms?: number;
  /** 是否已完成（流式消息结束标记）。 */
  is_completed?: boolean;
  msg_id?: string;
  /** 引用/回复的原消息（注意：ref_msg 在 item 上，逐项查找）。 */
  ref_msg?: RefMessage;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
}

/** 统一消息体（proto: WeixinMessage）。收发都用它。 */
export interface WeixinMessage {
  seq?: number;
  /** 消息 ID（去重/游标用：只处理 message_id > lastMessageId 的入站消息）。 */
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  delete_time_ms?: number;
  session_id?: string;
  group_id?: string;
  /** 见 MessageType（入站为 USER=1）。 */
  message_type?: number;
  /** 见 MessageState（发送时：进度用 GENERATING、最终用 FINISH）。 */
  message_state?: number;
  item_list?: MessageItem[];
  /**
   * 会话上下文令牌。发消息（回复）必须带它，否则发送被拒。
   * [实测] 关键规律（曾长期被误解，已纠正）：
   *  - 按 `(账号, 用户)` 缓存、持久化、重用；**无文档化的时间 TTL**，**仅**在会话过期(errcode -14)/重新登录时失效。
   *  - 主动/回复发送都应使用「收到该用户消息时携带的最新 token」；用陈旧/不匹配的 token 会得到 `ret=-2`（参数错误）。
   *  - `ret=-2` 是**参数错误**（token 失效/不匹配，或被复用为发送限流），**不是**「token 按时间过期」。详见 error-codes.ts。
   */
  context_token?: string;
}

/** GetUpdates 请求（长轮询收消息）。bytes 字段在 JSON 里是 base64。 */
export interface GetUpdatesReq {
  /** @deprecated 兼容字段，未来移除。 */
  sync_buf?: string;
  /** 本地缓存的完整 context buf；首次或重置后传 ""。 */
  get_updates_buf?: string;
}

/** GetUpdates 响应。 */
export interface GetUpdatesResp {
  /** RPC 返回码，见 error-codes.ts（0=成功）。 */
  ret?: number;
  /** 会话类错误码：-14=会话过期/超时（本项目命中后对该账号冷却 1 小时，需重新登录）。见 error-codes.ts。 */
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  /** @deprecated 兼容字段。 */
  sync_buf?: string;
  /** 需本地缓存、下次请求回传的完整 context buf（长轮询游标）。 */
  get_updates_buf?: string;
  /** 服务端建议的下次 getUpdates 长轮询超时(ms)。[实测] 目前 WeMind 固定 25s、未采用此建议值（可作未来优化）。 */
  longpolling_timeout_ms?: number;
}

/** SendMessage 请求：包一条 WeixinMessage。 */
export interface SendMessageReq {
  msg?: WeixinMessage;
}

/** SendMessage 响应（proto 为空体；实际响应体可能带 ret/errcode 表示失败，见 sendMessage 实现）。 */
export interface SendMessageResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

export interface GetUploadUrlReq {
  filekey?: string;
  /** 见 UploadMediaType。 */
  media_type?: number;
  to_user_id?: string;
  /** 原文件明文大小。 */
  rawsize?: number;
  /** 原文件明文 MD5 (hex)。 */
  rawfilemd5?: string;
  /** 原文件密文大小（AES-128-ECB PKCS7 加密后）。 */
  filesize?: number;
  /** 缩略图明文大小（官方：IMAGE/VIDEO 必填）。[实测] WeMind 用 no_need_thumb=true 跳过缩略图，故不填。 */
  thumb_rawsize?: number;
  /** 缩略图明文 MD5（官方：IMAGE/VIDEO 必填；同上，WeMind 跳过）。 */
  thumb_rawfilemd5?: string;
  /** 缩略图密文大小（官方：IMAGE/VIDEO 必填；同上，WeMind 跳过）。 */
  thumb_filesize?: number;
  /** 不需要缩略图上传 URL，默认 false。[实测] WeMind 置 true 免缩略图，无需 sharp/jimp 生成缩略图。 */
  no_need_thumb?: boolean;
  /** 加密 key（hex）。 */
  aeskey?: string;
}

export interface GetUploadUrlResp {
  /** RPC 返回码（非 0 表示失败，见 error-codes.ts）。proto 未列，但实际响应体携带。 */
  ret?: number;
  errcode?: number;
  errmsg?: string;
  /** 原图上传加密参数。 */
  upload_param?: string;
  /** 缩略图上传加密参数，无缩略图时为空。 */
  thumb_upload_param?: string;
  /** 完整上传 URL（服务端直接返回，无需客户端拼接）。 */
  upload_full_url?: string;
}

export interface QRCodeResponse {
  qrcode: string;
  /** 二维码内容（可作为链接展示/生成二维码图）。 */
  qrcode_img_content: string;
}

/**
 * 扫码登录状态轮询响应。
 * 官方完整状态机（8 态，见 openclaw-weixin login-qr.ts）：
 *   wait / scaned / confirmed / expired / scaned_but_redirect / need_verifycode / verify_code_blocked / binded_redirect
 * [实测] WeMind 的登录流程只处理常见 4 态（wait/scaned/confirmed/expired）；其余高级态（验证码回填、IDC 重定向、已绑定）当前未实现——如遇到，会落到默认分支按「等待」处理。类型在此列全以对齐官方、便于将来补全。
 */
export interface QRStatusResponse {
  status:
    | "wait"
    | "scaned"
    | "confirmed"
    | "expired"
    | "scaned_but_redirect"
    | "need_verifycode"
    | "verify_code_blocked"
    | "binded_redirect";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  /** 扫码者的 user id（confirmed 时返回；用于加入 allowFrom 登录者白名单）。 */
  ilink_user_id?: string;
  /** status=scaned_but_redirect 时，需把后续轮询切换到的新 host（IDC 重定向）。 */
  redirect_host?: string;
}

export interface SendTypingReq {
  ilink_user_id?: string;
  typing_ticket?: string;
  /** 见 TypingStatus：1=typing（默认）、2=cancel。 */
  status?: number;
}

/** SendTyping 响应。 */
export interface SendTypingResp {
  ret?: number;
  errmsg?: string;
}

/** GetConfig 响应：含 sendTyping 所需的 typing_ticket。 */
export interface GetConfigResp {
  ret?: number;
  errmsg?: string;
  /** base64 编码的 typing ticket（sendTyping 必需）。[实测] 缺失即视为获取失败，不应带空 ticket 继续发（见 mcp typing 校验）。 */
  typing_ticket?: string;
}

// ===== 以下为 WeMind 本地（非协议）类型：落盘的账号/状态/二维码态 =====

/** 本地持久化的账号凭证（account.json）。 */
export interface AccountData {
  botToken: string;
  botId: string;
  userId: string;
  baseUrl: string;
  savedAt: number;
}

/** 本地持久化的运行状态（state.json）。 */
export interface ServerState {
  /** 长轮询游标（getUpdates 的 get_updates_buf）。 */
  updatesBuf: string;
  /** 各会话最新 context_token，key = `${botId}:${userId}`（[实测] 发送时取最新缓存值，规避 ret=-2）。 */
  contextTokens: Record<string, string>;
  /** 已处理的最大 message_id，用于入站去重。 */
  lastMessageId: number;
}

/** 本地暂存的扫码登录态（qr_login.json）。 */
export interface QrLoginState {
  qrcode: string;
  qrcodeUrl: string;
  createdAt: number;
}
