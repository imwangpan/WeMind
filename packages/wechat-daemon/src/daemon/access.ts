/**
 * 发件人鉴权：登录者（owner，始终允许）或在登录者白名单 allowFrom 中。
 *
 * 这是**兜底校验**：微信平台只把消息投给扫码登录该 bot 的微信号，正常只会收到登录者本人的消息；这道闸防的是发送范围变化/别的入口。
 * `allow` 由调用方注入（daemon 传 core 的 `isAllowed`，测试可传假实现）。
 */
export function isAuthorizedSender(
  from: string,
  owner: string,
  allow: (userId: string) => boolean,
): boolean {
  return !!from && (from === owner || allow(from));
}
