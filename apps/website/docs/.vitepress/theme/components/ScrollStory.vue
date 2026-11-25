<script setup lang="ts">
import { Trans } from '@lingui/vue/macro'
import { useLingui } from '@lingui/vue'
import type { MessageDescriptor } from '@lingui/core'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { storyActs } from '../data/story'
import PhoneFrame from './PhoneFrame.vue'

const { i18n } = useLingui()
const active = ref(0)
const storyRoot = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | undefined

function tr(message: MessageDescriptor) {
  return i18n.value._(message)
}

onMounted(() => {
  const steps = storyRoot.value?.querySelectorAll<HTMLElement>('[data-story-step]')
  if (!steps?.length) return

  observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
      if (!visible) return
      const index = Number((visible.target as HTMLElement).dataset.storyStep)
      if (!Number.isNaN(index)) active.value = index
    },
    { rootMargin: '-32% 0px -40% 0px', threshold: [0, 0.25, 0.5, 0.75] },
  )

  steps.forEach((step) => observer?.observe(step))
})

onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <section ref="storyRoot" class="story" aria-labelledby="story-title">
    <div class="story-intro">
      <p class="section-kicker"><Trans>A MESSAGE'S JOURNEY</Trans></p>
      <h2 id="story-title"><Trans>一条消息，走完五步</Trans></h2>
      <p class="section-lead">
        <Trans>从微信到 Agent，再回到微信。你看到的每一步，都是本机在跑。</Trans>
      </p>
    </div>

    <div class="story-layout">
      <div class="story-phone" aria-hidden="true">
        <PhoneFrame :act="active" />
        <p class="phone-caption"><Trans>演示界面 · 不连接真实微信</Trans></p>
      </div>

      <ol class="story-steps">
        <li
          v-for="(act, index) in storyActs"
          :key="act.id"
          :data-story-step="index"
          class="story-step"
          :class="{ 'is-active': index === active }"
        >
          <p class="step-kicker">{{ tr(act.kicker) }}</p>
          <h3>{{ tr(act.title) }}</h3>
          <p class="step-body">{{ tr(act.body) }}</p>
          <div class="story-phone-inline" aria-hidden="true">
            <PhoneFrame :act="index" compact />
          </div>
        </li>
      </ol>
    </div>
  </section>
</template>

<style scoped>
.story {
  max-width: 1180px;
  margin: 0 auto;
  padding: 96px 24px 72px;
}

.story-intro {
  max-width: 680px;
}

.section-kicker {
  margin: 0 0 10px;
  color: var(--wm-clay);
  font-family: var(--wm-sans);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.16em;
}

.story-intro h2 {
  margin: 0;
  color: var(--wm-ink);
  font-family: var(--wm-serif);
  font-size: clamp(32px, 4.4vw, 52px);
  font-weight: 500;
  letter-spacing: -0.03em;
  line-height: 1.18;
}

.section-lead {
  max-width: 560px;
  margin: 18px 0 0;
  color: var(--wm-muted);
  font-size: 15px;
  line-height: 1.8;
}

.story-layout {
  display: grid;
  grid-template-columns: minmax(280px, 0.8fr) minmax(0, 1.2fr);
  gap: clamp(48px, 8vw, 112px);
  margin-top: 64px;
}

.story-phone {
  position: sticky;
  top: 112px;
  align-self: start;
  padding-top: 8px;
}

.phone-caption {
  margin: 18px 0 0;
  color: var(--wm-muted);
  font-size: 11px;
  text-align: center;
}

.story-steps {
  margin: 0;
  padding: 0;
  list-style: none;
}

.story-step {
  display: flex;
  min-height: 62vh;
  flex-direction: column;
  justify-content: center;
  padding: 32px 0;
  border-top: 1px solid var(--wm-line);
  opacity: 0.42;
  transition: opacity 320ms ease;
}

.story-step:last-child {
  border-bottom: 1px solid var(--wm-line);
}

.story-step.is-active {
  opacity: 1;
}

.step-kicker {
  margin: 0 0 10px;
  color: var(--wm-clay);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.13em;
}

.story-step h3 {
  margin: 0;
  color: var(--wm-ink);
  font-family: var(--wm-serif);
  font-size: clamp(26px, 3vw, 38px);
  font-weight: 500;
  letter-spacing: -0.02em;
  line-height: 1.2;
}

.step-body {
  max-width: 480px;
  margin: 14px 0 0;
  color: var(--wm-muted);
  font-size: 15px;
  line-height: 1.8;
}

.story-phone-inline {
  display: none;
  margin-top: 28px;
}

@media (max-width: 860px) {
  .story {
    padding: 72px 20px 48px;
  }

  .story-layout {
    display: block;
    margin-top: 40px;
  }

  .story-phone {
    display: none;
  }

  .story-step {
    min-height: 0;
    padding: 30px 0;
    opacity: 1;
  }

  .story-step h3 {
    font-size: 28px;
  }

  .story-phone-inline {
    display: block;
  }

  .story-phone-inline :deep(.phone) {
    margin-left: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .story-step {
    transition: none;
  }
}
</style>
