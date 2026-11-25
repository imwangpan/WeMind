import { defineConfig } from '@lingui/vue/config'
import { createVueExtractor } from '@lingui/extractor-vue'
import babel from '@lingui/cli/api/extractors/babel'

export default defineConfig({
  locales: ['zh', 'en'],
  sourceLocale: 'zh',
  catalogs: [
    {
      path: 'docs/.vitepress/theme/locales/{locale}/messages',
      include: ['docs/.vitepress/theme'],
    },
  ],
  extractors: [babel, createVueExtractor()],
})
