export type Locale = 'zh' | 'en'

export const DEFAULT_LOCALE: Locale = 'zh'
export const LOCALE_STORAGE_KEY = 'wemind-locale'

export const DOCS_HOME: Record<Locale, string> = {
  zh: '/guide/',
  en: '/en/guide/',
}

const DOCS_PREFIXES = ['/guide', '/agents', '/reference', '/faq'] as const

const ZH_TO_EN: Record<string, string> = {
  '/guide': '/en/guide/',
  '/guide/getting-started': '/en/guide/getting-started',
  '/guide/commands': '/en/guide/commands',
  '/guide/sessions': '/en/guide/sessions',
  '/guide/tasks': '/en/guide/tasks',
  '/guide/brain': '/en/guide/brain',
  '/agents': '/en/guide/agents',
  '/faq': '/en/guide/faq',
}

const EN_TO_ZH: Record<string, string> = Object.fromEntries(
  Object.entries(ZH_TO_EN).map(([zh, en]) => [normalizePath(en), zh]),
)

export function normalizePath(path: string): string {
  let normalized = (path.split(/[?#]/, 1)[0] || '/')
    .replace(/\/index\.html$/, '/')
    .replace(/\.html$/, '')
    .replace(/\/{2,}/g, '/')

  if (!normalized.startsWith('/')) normalized = `/${normalized}`
  if (normalized.length > 1) normalized = normalized.replace(/\/$/, '')

  return normalized || '/'
}

export function stripBase(path: string, base: string): string {
  if (!base || base === '/') return path

  const normalizedBase = base.endsWith('/') ? base : `${base}/`
  if (path === normalizedBase.slice(0, -1)) return '/'
  if (path.startsWith(normalizedBase)) {
    return `/${path.slice(normalizedBase.length)}`
  }

  return path
}

export function withBasePath(base: string, path: string): string {
  if (!base || base === '/') return path
  const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base
  return `${normalizedBase}${path.startsWith('/') ? path : `/${path}`}`
}

export function isEnglishDocsPath(path: string): boolean {
  const normalized = normalizePath(path)
  return normalized === '/en' || normalized.startsWith('/en/')
}

export function isDocsPath(path: string): boolean {
  const normalized = normalizePath(path)
  if (isEnglishDocsPath(normalized)) return true

  return DOCS_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  )
}

export function localeFromDocsPath(path: string): Locale {
  return isEnglishDocsPath(path) ? 'en' : 'zh'
}

export function docsHomeForLocale(locale: Locale): string {
  return DOCS_HOME[locale]
}

export function docsPathForTarget(path: string, target: Locale): string {
  const normalized = normalizePath(path)

  if (!isDocsPath(normalized)) return DOCS_HOME[target]

  if (target === 'en') {
    if (isEnglishDocsPath(normalized)) {
      return normalized === '/en' || normalized === '/en/guide' ? DOCS_HOME.en : normalized
    }
    return ZH_TO_EN[normalized] ?? DOCS_HOME.en
  }

  if (!isEnglishDocsPath(normalized)) {
    return normalized === '/guide' ? DOCS_HOME.zh : normalized
  }

  return EN_TO_ZH[normalized] ?? DOCS_HOME.zh
}

export const THEME_LABELS = {
  zh: {
    outline: { label: '本页目录' },
    docFooter: { prev: '上一页', next: '下一页' },
    darkModeSwitchLabel: '外观',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',
    sidebarMenuLabel: '菜单',
    returnToTopLabel: '回到顶部',
    langMenuLabel: '切换语言',
    navMenuLabel: '主导航',
    mobileMenuLabel: '菜单',
    extraMenuLabel: '更多选项',
    skipToContentLabel: '跳到主要内容',
  },
  en: {
    outline: { label: 'On this page' },
    docFooter: { prev: 'Previous page', next: 'Next page' },
    darkModeSwitchLabel: 'Appearance',
    lightModeSwitchTitle: 'Switch to light theme',
    darkModeSwitchTitle: 'Switch to dark theme',
    sidebarMenuLabel: 'Menu',
    returnToTopLabel: 'Return to top',
    langMenuLabel: 'Change language',
    navMenuLabel: 'Main navigation',
    mobileMenuLabel: 'Menu',
    extraMenuLabel: 'More options',
    skipToContentLabel: 'Skip to content',
  },
} as const

export function htmlLang(locale: Locale): 'zh-CN' | 'en-US' {
  return locale === 'en' ? 'en-US' : 'zh-CN'
}

export function readSavedLocale(
  storage: Pick<Storage, 'getItem'> | null | undefined,
): Locale | null {
  if (!storage) return null

  try {
    const value = storage.getItem(LOCALE_STORAGE_KEY)
    return value === 'zh' || value === 'en' ? value : null
  } catch {
    return null
  }
}

export function writeSavedLocale(
  storage: Pick<Storage, 'setItem'> | null | undefined,
  locale: Locale,
): void {
  try {
    storage?.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // Storage can be unavailable in private mode; the route still works.
  }
}
