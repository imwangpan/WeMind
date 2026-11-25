import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme-without-fonts'
import { createLingui } from '@lingui/vue'
import { i18n } from '@lingui/core'
import { messages as zh } from './locales/zh/messages.po'
import { messages as en } from './locales/en/messages.po'
import Layout from './Layout.vue'
import './custom.css'

i18n.load({ zh, en })
i18n.activate('zh')

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.use(createLingui({ i18n }))
  },
} satisfies Theme
