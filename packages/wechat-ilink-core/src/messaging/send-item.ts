import { generateId, sendMessage } from "../api/client.js";
import { MessageState, MessageType, type MessageItem, type SendMessageResp } from "../api/types.js";

/**
 * 发送单个结构化 item（工具进度 11/12、引用/媒体等）。
 * 官方约束：每次 sendmessage 的 item_list 只放一个 item；工具进度不要和文本混发。
 */
export async function sendItem(params: {
  baseUrl: string;
  token?: string;
  to: string;
  item: MessageItem;
  contextToken?: string;
  state?: number;
}): Promise<SendMessageResp> {
  return sendMessage({
    baseUrl: params.baseUrl,
    token: params.token,
    body: {
      msg: {
        from_user_id: "",
        to_user_id: params.to,
        client_id: generateId("item"),
        message_type: MessageType.BOT,
        message_state: params.state ?? MessageState.FINISH,
        item_list: [params.item],
        context_token: params.contextToken,
      },
    },
  });
}
