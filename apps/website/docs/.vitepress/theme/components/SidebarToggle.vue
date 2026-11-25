<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useData } from 'vitepress'
import { useLocale } from '../composables/useLocale'
import { useSidebarCollapse } from '../composables/useSidebarCollapse'

defineProps<{ floating?: boolean }>()

const { frontmatter } = useData()
const { current } = useLocale()
const { collapsed, syncFromDocument, toggle } = useSidebarCollapse()
const hasSidebar = computed(() => frontmatter.value.sidebar !== false)

const label = computed(() => {
  if (current.value === 'en') return collapsed.value ? 'Expand sidebar' : 'Collapse sidebar'
  return collapsed.value ? '展开侧栏' : '收起侧栏'
})

onMounted(syncFromDocument)
</script>

<template>
  <button
    v-if="hasSidebar && (floating ? collapsed : !collapsed)"
    class="sidebar-toggle"
    :class="{ 'sidebar-toggle--floating': floating }"
    type="button"
    :aria-expanded="!collapsed"
    aria-controls="VPSidebarNav"
    :aria-label="label"
    :title="label"
    @click="toggle"
  >
    <span class="sidebar-toggle__icon" aria-hidden="true">{{ collapsed ? '»' : '«' }}</span>
  </button>
</template>

<style scoped>
.sidebar-toggle {
  position: absolute;
  top: calc(var(--vp-nav-height) + 8px);
  right: 32px;
  display: flex;
  width: 30px;
  height: 30px;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: 0;
  border: 1px solid var(--wm-line);
  border-radius: 4px;
  background: var(--wm-paper);
  color: var(--wm-muted);
  font-family: var(--wm-sans);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  transition:
    color 0.2s,
    border-color 0.2s,
    background-color 0.2s;
}

.sidebar-toggle:hover {
  border-color: var(--wm-pine);
  background: var(--vp-c-brand-soft);
  color: var(--wm-pine);
}

.sidebar-toggle:focus-visible {
  outline: 2px solid var(--wm-pine);
  outline-offset: 2px;
}

.sidebar-toggle__icon {
  font-size: 15px;
}

.sidebar-toggle--floating {
  position: fixed;
  top: 96px;
  left: 0;
  right: auto;
  z-index: 40;
  width: 30px;
  height: 30px;
  margin: 0;
  padding: 0;
  border-left: 0;
  border-radius: 0 5px 5px 0;
  background: var(--wm-paper);
  box-shadow: 0 2px 10px rgba(38, 48, 43, 0.08);
}

@media (max-width: 959px) {
  .sidebar-toggle {
    display: none;
  }
}
</style>
