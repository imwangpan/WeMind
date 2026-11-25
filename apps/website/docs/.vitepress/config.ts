import { defineConfig } from 'vitepress'
import { lingui } from '@lingui/vite-plugin'
import { linguiVue } from '@lingui/vue/vite'
import { THEME_LABELS } from './theme/locale.ts'

const base = (() => {
  const value = process.env.DOCS_BASE ?? '/'
  return value === '/' ? '/' : `${value.replace(/\/+$/, '')}/`
})()

const pendingLocaleScript = `(() => {
  try {
    const base = ${JSON.stringify(base)}
    const path = location.pathname.replace(/\\/index\\.html$/, '/')
    if (path === base && localStorage.getItem('wemind-locale') === 'en') {
      document.documentElement.setAttribute('data-locale-pending', 'en')
      window.setTimeout(() => {
        document.documentElement.removeAttribute('data-locale-pending')
      }, 1000)
    }
  } catch {}
})()`

const sidebarStateScript = `(() => {
  try {
    if (localStorage.getItem('wemind-sidebar-collapsed') === '1') {
      document.documentElement.setAttribute('data-sidebar-collapsed', 'true')
    }
  } catch {}
})()`

const zhThemeConfig = {
  logoLink: base,
  nav: [
    { text: '快速开始', link: '/guide/getting-started' },
    { text: '接入 Agent', link: '/agents/' },
    { text: '参考', link: '/reference/' },
    { text: 'FAQ', link: '/faq/' },
    { text: 'GitHub', link: 'https://github.com/imwangpan/WeMind' },
  ],
  sidebar: [
    {
      text: '开始',
      collapsed: false,
      items: [{ text: '快速开始', link: '/guide/getting-started' }],
    },
    {
      text: '使用',
      collapsed: false,
      items: [
        { text: '命令速查', link: '/guide/commands' },
        { text: '会话', link: '/guide/sessions' },
        { text: '远程任务', link: '/guide/tasks' },
        { text: '切换大脑', link: '/guide/brain' },
        { text: '图片、文件与语音', link: '/guide/media' },
        { text: '开机自启', link: '/guide/autostart' },
      ],
    },
    {
      text: '接入',
      collapsed: false,
      items: [
        { text: 'Agent 总览', link: '/agents/' },
        { text: '自定义 Agent', link: '/agents/custom' },
      ],
    },
    {
      text: '参考',
      collapsed: false,
      items: [
        { text: 'CLI 子命令', link: '/reference/cli' },
        { text: '微信指令', link: '/reference/wechat' },
        { text: '环境变量', link: '/reference/env' },
        { text: '数据目录', link: '/reference/data' },
      ],
    },
    { text: '常见问题', link: '/faq/' },
  ],
  ...THEME_LABELS.zh,
}

const enThemeConfig = {
  logoLink: base,
  nav: [
    { text: 'Getting Started', link: '/en/guide/getting-started' },
    { text: 'Agents', link: '/en/guide/agents' },
    { text: 'FAQ', link: '/en/guide/faq' },
    { text: 'GitHub', link: 'https://github.com/imwangpan/WeMind' },
  ],
  sidebar: [
    {
      text: 'Guide',
      collapsed: false,
      items: [
        { text: 'Getting Started', link: '/en/guide/getting-started' },
        { text: 'Commands', link: '/en/guide/commands' },
        { text: 'Sessions', link: '/en/guide/sessions' },
        { text: 'Tasks', link: '/en/guide/tasks' },
        { text: 'Agents', link: '/en/guide/brain' },
        { text: 'Connect an Agent', link: '/en/guide/agents' },
        { text: 'FAQ', link: '/en/guide/faq' },
      ],
    },
  ],
  ...THEME_LABELS.en,
}

export default defineConfig({
  base,
  title: 'WeMind',
  description: '把微信变成 AI 的输入输出通道',
  appearance: false,
  cleanUrls: process.env.DOCS_CLEAN_URLS !== 'false',
  head: [
    ['meta', { name: 'theme-color', content: '#f6f1e7' }],
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` }],
    ['script', {}, pendingLocaleScript],
    ['script', {}, sidebarStateScript],
  ],
  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      themeConfig: zhThemeConfig,
    },
    en: {
      label: 'English',
      lang: 'en-US',
      description: 'Turn WeChat into an input/output channel for AI',
      themeConfig: enThemeConfig,
    },
  },
  themeConfig: zhThemeConfig,
  vite: {
    plugins: [linguiVue(), lingui()],
  },
})
