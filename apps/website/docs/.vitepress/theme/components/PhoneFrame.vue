<script setup lang="ts">
import { Trans } from '@lingui/vue/macro'
import ChatBubble from './ChatBubble.vue'

withDefaults(
  defineProps<{
    act: number
    compact?: boolean
  }>(),
  {
    compact: false,
  },
)
</script>

<template>
  <div class="phone" :class="{ 'phone--compact': compact }" aria-hidden="true">
    <div class="phone-frame">
      <div class="phone-notch"></div>
      <div class="phone-screen">
        <header class="phone-head">
          <span class="phone-back">‹</span>
          <span class="phone-title"><Trans>微信</Trans></span>
          <span class="phone-more">···</span>
        </header>

        <div class="phone-chat">
          <template v-if="act === 0">
            <p class="phone-time"><Trans>刚刚</Trans></p>
            <ChatBubble from="user">
              <Trans>帮我把 docs 里的接入方案整理成一页说明。</Trans>
            </ChatBubble>
          </template>

          <template v-else-if="act === 1">
            <div class="system-card">
              <p class="system-kicker"><Trans>WeMind 已接收</Trans></p>
              <p><Trans>文本 · 图片 · 文件 · 语音都能进</Trans></p>
              <div class="system-tags">
                <span><Trans>已确认是你</Trans></span>
                <span><Trans>消息留在本机</Trans></span>
              </div>
            </div>
            <ChatBubble from="agent">
              <Trans>收到，我先看看这条消息要做什么。</Trans>
            </ChatBubble>
          </template>

          <template v-else-if="act === 2">
            <div class="agent-switch">
              <p class="system-kicker"><Trans>选择接手的 Agent</Trans></p>
              <div class="agent-chips">
                <span>Claude Code</span>
                <span>Codex</span>
                <span class="active">Pi</span>
                <span>Gemini</span>
              </div>
              <p class="switch-note"><Trans>微信不动，Agent 可以换。</Trans></p>
            </div>
            <ChatBubble from="agent">
              <Trans>换好了。接下来由 Pi 接手。</Trans>
            </ChatBubble>
          </template>

          <template v-else-if="act === 3">
            <div class="tool-card">
              <p class="system-kicker"><Trans>正在处理</Trans></p>
              <div class="tool-line">
                <span class="tool-dot"></span>
                <span><Trans>读取 docs/接入方案.md</Trans></span>
              </div>
              <div class="tool-line">
                <span class="tool-dot"></span>
                <span><Trans>整理 3 个要点</Trans></span>
              </div>
              <div class="tool-line">
                <span class="tool-dot"></span>
                <span><Trans>生成一页说明</Trans></span>
              </div>
              <div class="tool-progress"><span></span></div>
            </div>
            <p class="task-note"><Trans>长任务已交给另一个 Agent，微信这边可以继续聊。</Trans></p>
          </template>

          <template v-else>
            <ChatBubble from="agent">
              <Trans>整理好了：一页说明 + 3 个待办。</Trans>
            </ChatBubble>
            <div class="file-card">
              <span class="file-icon">PDF</span>
              <span>
                <strong><Trans>接入方案-一页说明.pdf</Trans></strong>
                <small><Trans>128 KB · 已完成</Trans></small>
              </span>
            </div>
            <p class="phone-time phone-time--done"><Trans>完成</Trans></p>
          </template>
        </div>

        <footer class="phone-input">
          <span><Trans>发消息…</Trans></span>
          <span class="phone-send">↑</span>
        </footer>
      </div>
    </div>
  </div>
</template>

<style scoped>
.phone {
  width: min(300px, 100%);
  margin: 0 auto;
  filter: drop-shadow(0 18px 28px rgba(38, 48, 43, 0.14));
}

.phone-frame {
  position: relative;
  padding: 8px;
  border: 1px solid #2d3630;
  border-radius: 38px;
  background: #26302b;
}

.phone-notch {
  position: absolute;
  top: 14px;
  left: 50%;
  z-index: 2;
  width: 76px;
  height: 7px;
  border-radius: 999px;
  background: #1b221e;
  transform: translateX(-50%);
}

.phone-screen {
  display: flex;
  min-height: 560px;
  flex-direction: column;
  overflow: hidden;
  border-radius: 30px;
  background: #f1ece1;
}

.phone-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 16px 10px;
  border-bottom: 1px solid rgba(38, 48, 43, 0.08);
  color: var(--wm-ink);
  font-size: 13px;
  font-weight: 600;
}

.phone-back,
.phone-more {
  color: var(--wm-muted);
  font-size: 18px;
  font-weight: 400;
}

.phone-title {
  letter-spacing: 0.04em;
}

.phone-chat {
  flex: 1;
  padding: 10px 12px 16px;
}

.phone-time {
  margin: 8px 0;
  color: var(--wm-muted);
  font-size: 10px;
  text-align: center;
}

.phone-time--done {
  margin-top: 16px;
}

.system-card,
.tool-card {
  margin: 12px 0;
  padding: 12px;
  border: 1px solid rgba(38, 48, 43, 0.1);
  border-radius: 12px;
  background: #fbf7ee;
  color: var(--wm-ink);
  font-size: 12px;
  line-height: 1.55;
}

.system-kicker {
  margin: 0 0 4px;
  color: var(--wm-pine);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.system-card p,
.tool-card p {
  margin: 0;
}

.system-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}

.system-tags span {
  padding: 2px 6px;
  border-radius: 999px;
  background: #e7eddf;
  color: #4d6049;
  font-size: 10px;
}

.agent-switch {
  padding: 12px;
  border: 1px solid rgba(38, 48, 43, 0.1);
  border-radius: 12px;
  background: #fbf7ee;
}

.agent-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 10px 0;
}

.agent-chips span {
  padding: 5px 8px;
  border: 1px solid #d8cdbb;
  border-radius: 6px;
  background: #fffdf8;
  color: var(--wm-muted);
  font-size: 10px;
}

.agent-chips span.active {
  border-color: var(--wm-pine);
  background: var(--wm-pine);
  color: #fffdf8;
}

.switch-note {
  margin: 0;
  color: var(--wm-muted);
  font-size: 10px;
}

.tool-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.tool-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--wm-pine);
}

.tool-progress {
  height: 4px;
  margin-top: 12px;
  overflow: hidden;
  border-radius: 999px;
  background: #e5dccb;
}

.tool-progress span {
  display: block;
  width: 72%;
  height: 100%;
  border-radius: inherit;
  background: var(--wm-pine);
}

.task-note {
  margin: 12px 0 0;
  padding: 10px 12px;
  border-left: 2px solid var(--wm-clay);
  background: #f7ede2;
  color: #6c4a36;
  font-size: 11px;
  line-height: 1.5;
}

.file-card {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  padding: 10px;
  border: 1px solid rgba(38, 48, 43, 0.1);
  border-radius: 10px;
  background: #fffdf8;
  color: var(--wm-ink);
}

.file-icon {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border-radius: 6px;
  background: #f0dfd3;
  color: var(--wm-clay);
  font-size: 9px;
  font-weight: 700;
}

.file-card strong {
  display: block;
  font-size: 11px;
  font-weight: 600;
}

.file-card small {
  color: var(--wm-muted);
  font-size: 10px;
}

.phone-input {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 10px 10px;
  padding: 8px 10px;
  border: 1px solid rgba(38, 48, 43, 0.1);
  border-radius: 999px;
  background: #fffdf8;
  color: var(--wm-muted);
  font-size: 11px;
}

.phone-send {
  display: grid;
  width: 22px;
  height: 22px;
  place-items: center;
  border-radius: 999px;
  background: var(--wm-pine);
  color: #fffdf8;
  font-size: 12px;
}

.phone--compact .phone-frame {
  border-radius: 28px;
}

.phone--compact .phone-screen {
  min-height: 480px;
  border-radius: 22px;
}

@media (max-width: 860px) {
  .phone {
    width: min(280px, 100%);
  }

  .phone-screen {
    min-height: 500px;
  }
}
</style>
