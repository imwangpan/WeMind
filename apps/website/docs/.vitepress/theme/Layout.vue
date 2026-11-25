<script setup lang="ts">
import { onBeforeUnmount, onMounted, useSlots } from 'vue'
import DefaultTheme from 'vitepress/theme-without-fonts'
import DocsLink from './components/DocsLink.vue'
import LocaleSwitch from './components/LocaleSwitch.vue'
import SidebarToggle from './components/SidebarToggle.vue'

const slots = useSlots()
const ownSlots = new Set([
  'nav-bar-content-before',
  'nav-bar-content-after',
  'nav-screen-content-before',
  'nav-screen-content-after',
  'sidebar-nav-before',
])

// VitePress' outline dropdown only closes when the click target itself has the
// `outline-link` class. A click on the inner <bdi> is ignored, so close it here
// after any outline link click, including the same-hash case.
function closeOutlineAfterClick(event: MouseEvent) {
  const target = event.target
  if (!(target instanceof Element)) return
  if (!target.closest('.VPLocalNavOutlineDropdown .items a')) return

  window.setTimeout(() => {
    document
      .querySelector<HTMLButtonElement>('.VPLocalNavOutlineDropdown > button[aria-expanded="true"]')
      ?.click()
  }, 0)
}

onMounted(() => document.addEventListener('click', closeOutlineAfterClick))
onBeforeUnmount(() => document.removeEventListener('click', closeOutlineAfterClick))
</script>

<template>
  <DefaultTheme.Layout>
    <template v-for="(_, name) in slots" :key="name" #[name]="slotProps">
      <slot v-if="!ownSlots.has(name)" :name="name" v-bind="slotProps || {}" />
    </template>

    <template #nav-bar-content-after>
      <DocsLink />
      <LocaleSwitch />
    </template>

    <template #sidebar-nav-before>
      <SidebarToggle />
    </template>

    <template #nav-screen-content-before>
      <DocsLink mobile />
    </template>

    <template #nav-screen-content-after>
      <LocaleSwitch />
    </template>
  </DefaultTheme.Layout>
  <SidebarToggle floating />
</template>
