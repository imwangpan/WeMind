<script setup lang="ts">
import type { MessageDescriptor } from '@lingui/core'
import { Trans } from '@lingui/vue/macro'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { demoNote, demoScripts, demoTabs, type DemoTabId } from '../data/demo'
import ChatBubble from './ChatBubble.vue'

const { i18n } = useLingui()
const tablistLabel = msg`演示脚本`
const activeTab = ref<DemoTabId>('summary')
const visibleCount = ref(0)
const demoRoot = ref<HTMLElement | null>(null)
const reducedMotion = ref(false)
let timer: ReturnType<typeof setInterval> | undefined
let observer: IntersectionObserver | undefined

const messages = computed(() => demoScripts[activeTab.value])
const visibleMessages = computed(() => messages.value.slice(0, visibleCount.value))

function tr(message: MessageDescriptor) {
  return i18n.value._(message)
}

function clearTimer() {
  if (timer) {
    clearInterval(timer)
    timer = undefined
  }
}

function play() {
  clearTimer()
  visibleCount.value = 0

  if (reducedMotion.value) {
    visibleCount.value = messages.value.length
    return
  }

  timer = setInterval(() => {
    if (visibleCount.value >= messages.value.length) {
      clearTimer()
      return
    }
    visibleCount.value += 1
  }, 720)
}

function skip() {
  clearTimer()
  visibleCount.value = messages.value.length
}

function selectTab(id: DemoTabId) {
  if (activeTab.value === id) return
  activeTab.value = id
  play()
}

onMounted(() => {
  reducedMotion.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) play()
    },
    { threshold: 0.25 },
  )

  if (demoRoot.value) observer.observe(demoRoot.value)
})

onBeforeUnmount(() => {
  clearTimer()
  observer?.disconnect()
})
</script>

<template>
  <section ref="demoRoot" class="demo" aria-labelledby="demo-title">
    <div class="demo-head">
      <div>
        <p class="section-kicker">TRY THE FLOW</p>
        <h2 id="demo-title"><Trans>看它怎么接住一句话</Trans></h2>
        <p class="demo-lead">
          <Trans>三个固定脚本，按时间出现。只是演示，不会真的发消息。</Trans>
        </p>
      </div>
      <div class="demo-actions">
        <button type="button" class="text-button" @click="play">
          <Trans>重播</Trans>
        </button>
        <button type="button" class="text-button" @click="skip">
          <Trans>跳过</Trans>
        </button>
      </div>
    </div>

    <div class="demo-panel">
      <div class="demo-tabs" role="tablist" :aria-label="i18n._(tablistLabel)">
        <button
          v-for="tab in demoTabs"
          :key="tab.id"
          type="button"
          role="tab"
          :aria-selected="activeTab === tab.id"
          :class="{ 'is-active': activeTab === tab.id }"
          @click="selectTab(tab.id)"
        >
          {{ tr(tab.label) }}
        </button>
      </div>

      <div class="demo-chat" role="tabpanel" aria-live="polite">
        <TransitionGroup name="demo-message" tag="div">
          <ChatBubble
            v-for="(message, index) in visibleMessages"
            :key="`${activeTab}-${index}`"
            :from="message.from"
          >
            <span>{{ tr(message.text) }}</span>
            <small v-if="message.meta" class="demo-meta">{{ tr(message.meta) }}</small>
          </ChatBubble>
        </TransitionGroup>
        <p v-if="visibleMessages.length === 0" class="demo-wait">
          <Trans>正在等第一条消息…</Trans>
        </p>
      </div>

      <p class="demo-note">{{ tr(demoNote) }}</p>
    </div>
  </section>
</template>

<style scoped>
.demo {
  max-width: 1180px;
  margin: 0 auto;
  padding: 72px 24px 96px;
}

.demo-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 28px;
  max-width: 760px;
  margin: 0 auto 28px;
}

.section-kicker {
  margin: 0 0 10px;
  color: var(--wm-clay);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.16em;
}

.demo-head h2 {
  margin: 0;
  color: var(--wm-ink);
  font-family: var(--wm-serif);
  font-size: clamp(32px, 4.4vw, 52px);
  font-weight: 500;
  letter-spacing: -0.03em;
  line-height: 1.18;
}

.demo-lead {
  max-width: 560px;
  margin: 14px 0 0;
  color: var(--wm-muted);
  font-size: 15px;
  line-height: 1.8;
}

.demo-actions {
  display: flex;
  flex: none;
  gap: 4px;
  padding-bottom: 4px;
}

.text-button {
  min-height: 40px;
  padding: 0 10px;
  border: 0;
  border-bottom: 1px solid transparent;
  background: transparent;
  color: var(--wm-muted);
  cursor: pointer;
  font-size: 12px;
}

.text-button:hover {
  border-color: var(--wm-pine);
  color: var(--wm-pine);
}

.demo-panel {
  max-width: 760px;
  margin: 0 auto;
  padding: 18px;
  border: 1px solid var(--wm-line);
  background: rgba(255, 253, 248, 0.7);
  box-shadow: 0 18px 40px rgba(38, 48, 43, 0.06);
}

.demo-tabs {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--wm-line);
  scrollbar-width: thin;
}

.demo-tabs button {
  flex: none;
  min-height: 40px;
  padding: 0 12px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--wm-muted);
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
}

.demo-tabs button:hover {
  color: var(--wm-pine);
}

.demo-tabs button.is-active {
  border-color: var(--wm-line);
  background: #f1ece1;
  color: var(--wm-ink);
}

.demo-chat {
  display: flex;
  min-height: 252px;
  flex-direction: column;
  justify-content: flex-end;
  padding: 18px 4px 8px;
}

.demo-chat :deep(.chat-bubble) {
  max-width: min(86%, 560px);
  padding: 11px 14px;
  font-size: 14px;
}

.demo-meta {
  display: block;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed rgba(38, 48, 43, 0.14);
  color: var(--wm-muted);
  font-size: 11px;
}

.demo-wait {
  margin: 0;
  color: var(--wm-muted);
  font-size: 13px;
}

.demo-note {
  margin: 14px 0 0;
  padding-top: 12px;
  border-top: 1px solid var(--wm-line);
  color: var(--wm-muted);
  font-size: 11px;
}

.demo-message-enter-active {
  transition:
    opacity 280ms ease,
    transform 280ms ease;
}

.demo-message-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

@media (max-width: 640px) {
  .demo {
    padding: 48px 20px 72px;
  }

  .demo-head {
    display: block;
  }

  .demo-actions {
    margin-top: 12px;
  }

  .demo-panel {
    padding: 12px;
  }

  .demo-chat {
    min-height: 300px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .demo-message-enter-active {
    transition: none;
  }
}
</style>
