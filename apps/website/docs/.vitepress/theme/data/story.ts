import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'

export interface StoryAct {
  id: string
  kicker: MessageDescriptor
  title: MessageDescriptor
  body: MessageDescriptor
}

export const storyActs: StoryAct[] = [
  {
    id: 'send',
    kicker: msg`01 · 发一句话`,
    title: msg`在微信里，说一句话`,
    body: msg`不打开终端，不装新 App。微信就是入口。`,
  },
  {
    id: 'receive',
    kicker: msg`02 · 接住消息`,
    title: msg`WeMind 接住这条消息`,
    body: msg`文本、图片、文件、语音都能进；消息留在本机，不用交给云端中转。`,
  },
  {
    id: 'switch',
    kicker: msg`03 · 换一个 Agent`,
    title: msg`换一个 Agent 接手`,
    body: msg`Claude Code、Codex、Gemini、Kiro、Pi……想用哪个，随时换。微信入口不变。`,
  },
  {
    id: 'work',
    kicker: msg`04 · 开始干活`,
    title: msg`Agent 开始干活`,
    body: msg`读文件、跑命令、查资料；长任务交给另一个 Agent，进度会回到微信。`,
  },
  {
    id: 'reply',
    kicker: msg`05 · 回到微信`,
    title: msg`结果回到微信`,
    body: msg`总结、图片、文件、视频都能回；不用切回终端，也不用另开一个 App。`,
  },
]
