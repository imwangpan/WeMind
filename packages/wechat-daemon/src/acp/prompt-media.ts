/**
 * 把入站图片按「agent 是否支持图片」注入到 ACP prompt 里：支持就推 `{type:"image"}` 块，不支持就推一段降级文本（**不静默丢图**）。
 * brain（`acp-brain.ts` 的 `runTurn`）与 worker（`worker-acp.ts` 的 `ask`）共用，保证两边的图片能力判断与降级话术一致。
 */

export interface PromptImage {
  data: string;
  mimeType: string;
}

/** brain 的默认降级话术（未传 `unsupportedNote` 时用）。 */
export const BRAIN_UNSUPPORTED_IMAGE_NOTE =
  "（用户发来图片，但当前大脑不支持图片输入；请让用户改用文字，或切换到支持图片的大脑。不要臆测图片内容。）";

/** worker 的降级话术：说的是「任务 agent」而不是「大脑」。 */
export const WORKER_UNSUPPORTED_IMAGE_NOTE =
  "（用户发来图片，但当前任务 agent 不支持图片输入；请让用户改用文字，或换一个支持图片的任务 agent。不要臆测图片内容。）";

/**
 * 就地把图片写进 prompt：
 * - 有图但 `supportsImages=false` → 推一条降级文本（提醒用户换文字或换 agent）；
 * - `supportsImages=true` → 每张图推一个 `{type:"image"}` 块。
 * 无图时什么都不做（纯文本路径与加这个调用之前逐字节一致）。
 */
export function applyMediaToPrompt(
  prompt: unknown[],
  images: PromptImage[] | undefined,
  supportsImages: boolean,
  opts: { unsupportedNote?: string } = {},
): void {
  if (images?.length && !supportsImages) {
    prompt.push({ type: "text", text: opts.unsupportedNote ?? BRAIN_UNSUPPORTED_IMAGE_NOTE });
  }
  if (supportsImages) {
    for (const im of images ?? []) {
      prompt.push({ type: "image", mimeType: im.mimeType, data: im.data });
    }
  }
}
