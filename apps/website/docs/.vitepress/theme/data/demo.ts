import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'

export type DemoTabId = 'summary' | 'research' | 'task'

export interface DemoTab {
  id: DemoTabId
  label: MessageDescriptor
}

export interface DemoMessage {
  from: 'user' | 'agent'
  text: MessageDescriptor
  meta?: MessageDescriptor
}

export const demoTabs: DemoTab[] = [
  { id: 'summary', label: msg`总结文档` },
  { id: 'research', label: msg`查资料` },
  { id: 'task', label: msg`远程任务` },
]

export const demoNote = msg`演示脚本，不会真的发消息。`

export const demoScripts: Record<DemoTabId, DemoMessage[]> = {
  summary: [
    {
      from: 'user',
      text: msg`帮我把 docs 里的接入方案整理成一页说明。`,
    },
    {
      from: 'agent',
      text: msg`收到。我先读目录，再按「接入方式 / 配置 / 常见问题」整理。`,
    },
    {
      from: 'agent',
      text: msg`整理好了：3 个要点，1 张流程图，末尾附了原文链接。`,
      meta: msg`附件 · 接入方案-一页说明.pdf`,
    },
  ],
  research: [
    {
      from: 'user',
      text: msg`查一下 ACP 协议里 session/resume 的用法。`,
    },
    {
      from: 'agent',
      text: msg`查到了 3 处相关说明，先看官方文档这一节。`,
    },
    {
      from: 'agent',
      text: msg`关键点：恢复会话时优先用原 cwd；失败就报错，不要偷偷新建。`,
      meta: msg`来源 · ACP 文档`,
    },
  ],
  task: [
    {
      from: 'user',
      text: msg`把这 12 个页面的链接检查一遍，慢一点没关系。`,
    },
    {
      from: 'agent',
      text: msg`已交给任务 Agent。微信这边可以继续聊，跑完会回来。`,
    },
    {
      from: 'agent',
      text: msg`检查完成：2 个失效链接，已按页面列好。`,
      meta: msg`任务 #12 · 完成`,
    },
  ],
}
