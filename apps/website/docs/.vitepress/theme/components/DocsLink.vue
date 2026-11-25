<script setup lang="ts">
import { useLocale } from '../composables/useLocale'

withDefaults(
  defineProps<{
    mobile?: boolean
  }>(),
  {
    mobile: false,
  },
)

const { current, docsHref } = useLocale()
</script>

<template>
  <a class="nav-docs-link" :class="{ 'nav-docs-link--mobile': mobile }" :href="docsHref">
    {{ current === 'en' ? 'Docs' : '文档' }}
  </a>
</template>

<style scoped>
.nav-docs-link {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  margin-left: 4px;
  padding: 0 12px;
  color: var(--vp-c-text-1);
  font-size: 14px;
  font-weight: 500;
  text-decoration: none;
}

.nav-docs-link:hover {
  color: var(--vp-c-brand-1);
}

.nav-docs-link--mobile {
  display: flex;
  width: 100%;
  padding: 12px 0;
  border-bottom: 1px solid var(--vp-c-divider);
}
</style>
