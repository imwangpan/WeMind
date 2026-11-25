<script setup lang="ts">
import { Trans } from '@lingui/vue/macro'
import { useLocale } from '../composables/useLocale'

const { docsHref } = useLocale()
const githubHref = 'https://github.com/imwangpan/WeMind'
</script>

<template>
  <footer class="site-footer">
    <div class="footer-main">
      <p class="footer-brand">WeMind</p>
      <p class="footer-line"><Trans>微信不用换，Agent 随心换。</Trans></p>
      <nav class="footer-links" aria-label="Footer">
        <a :href="docsHref"><Trans>文档</Trans></a>
        <a :href="githubHref" target="_blank" rel="noreferrer">GitHub</a>
      </nav>
    </div>
    <p class="footer-disclaimer">
      <Trans>WeMind 不是腾讯或微信官方产品；相关名称归各自权利人所有。</Trans>
    </p>
  </footer>
</template>

<style scoped>
.site-footer {
  max-width: 1180px;
  margin: 0 auto;
  padding: 40px 24px 56px;
  border-top: 1px solid var(--wm-line);
}

.footer-main {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 12px 24px;
}

.footer-brand {
  margin: 0;
  color: var(--wm-ink);
  font-family: var(--wm-serif);
  font-size: 20px;
  letter-spacing: -0.02em;
}

.footer-line {
  margin: 0;
  color: var(--wm-muted);
  font-size: 13px;
}

.footer-links {
  display: flex;
  gap: 16px;
  margin-left: auto;
}

.footer-links a {
  color: var(--wm-muted);
  font-size: 12px;
  text-decoration: none;
}

.footer-links a:hover {
  color: var(--wm-pine);
}

.footer-disclaimer {
  margin: 24px 0 0;
  color: var(--wm-muted);
  font-size: 11px;
  line-height: 1.7;
  opacity: 0.8;
}

@media (max-width: 640px) {
  .site-footer {
    padding: 32px 20px 44px;
  }

  .footer-links {
    width: 100%;
    margin-left: 0;
  }
}
</style>
