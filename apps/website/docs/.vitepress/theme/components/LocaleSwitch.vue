<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue'
import { useRoute } from 'vitepress'
import { useLocale } from '../composables/useLocale'

const route = useRoute()
const { current, notice, initialize, syncFromRoute, switchTo, clearNotice } = useLocale()

let stopRouteWatch: (() => void) | undefined

onMounted(() => {
  initialize()
  stopRouteWatch = watch(() => route.path, syncFromRoute)
})

onBeforeUnmount(() => {
  stopRouteWatch?.()
  clearNotice()
})
</script>

<template>
  <div class="locale-switch" :aria-label="current === 'en' ? 'Language' : '语言'">
    <button
      type="button"
      :class="{ active: current === 'zh' }"
      :aria-pressed="current === 'zh'"
      @click="switchTo('zh')"
    >
      中文
    </button>
    <span class="divider" aria-hidden="true">/</span>
    <button
      type="button"
      :class="{ active: current === 'en' }"
      :aria-pressed="current === 'en'"
      @click="switchTo('en')"
    >
      EN
    </button>
  </div>

  <p v-if="notice" class="locale-notice" role="status">{{ notice }}</p>
</template>

<style scoped>
.locale-switch {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 8px;
  font-size: 13px;
}

.locale-switch button {
  min-width: 44px;
  min-height: 44px;
  border: 0;
  background: transparent;
  color: var(--vp-c-text-2);
  cursor: pointer;
  padding: 0 4px;
}

.locale-switch button:hover,
.locale-switch button.active {
  color: var(--vp-c-brand-1);
}

.divider {
  color: var(--vp-c-divider);
}

.locale-notice {
  position: fixed;
  bottom: 24px;
  left: 50%;
  z-index: 100;
  max-width: min(92vw, 480px);
  margin: 0;
  padding: 12px 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-elv);
  box-shadow: var(--vp-shadow-2);
  color: var(--vp-c-text-1);
  font-size: 13px;
  line-height: 1.5;
  transform: translateX(-50%);
}
</style>
