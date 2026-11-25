import { computed, nextTick, ref } from 'vue'
import { useData, useRoute, useRouter } from 'vitepress'
import { i18n } from '@lingui/core'
import {
  DEFAULT_LOCALE,
  DOCS_HOME,
  type Locale,
  THEME_LABELS,
  docsHomeForLocale,
  docsPathForTarget,
  htmlLang,
  isDocsPath,
  localeFromDocsPath,
  normalizePath,
  readSavedLocale,
  stripBase,
  withBasePath,
  writeSavedLocale,
} from '../locale'

// The landing page is the only place without a language URL, so its choice is
// shared by every component that renders a locale-aware link.
const landingLocale = ref<Locale>(DEFAULT_LOCALE)
const notice = ref('')
let noticeTimer: number | undefined

function browserStorage(): Storage | null {
  if (typeof window === 'undefined') return null

  try {
    return window.localStorage
  } catch {
    return null
  }
}

function activate(locale: Locale): void {
  i18n.activate(locale)
  if (typeof document !== 'undefined') {
    document.documentElement.lang = htmlLang(locale)
  }
}

function clearPending(): void {
  if (typeof document !== 'undefined') {
    document.documentElement.removeAttribute('data-locale-pending')
  }
}

function clearNotice(): void {
  notice.value = ''
  if (noticeTimer) {
    clearTimeout(noticeTimer)
    noticeTimer = undefined
  }
}

function showNotice(message: string): void {
  clearNotice()
  notice.value = message
  if (typeof window !== 'undefined') {
    noticeTimer = window.setTimeout(clearNotice, 4000)
  }
}

export function useLocale() {
  const { site } = useData()
  const route = useRoute()
  const router = useRouter()

  const base = computed(() => site.value.base || '/')
  const path = computed(() => stripBase(route.path, base.value))
  const isDocs = computed(() => isDocsPath(path.value))
  const current = computed<Locale>(() =>
    isDocs.value ? localeFromDocsPath(path.value) : landingLocale.value,
  )
  const docsHref = computed(() => withBasePath(base.value, docsHomeForLocale(current.value)))
  const docsLabel = computed(() => (current.value === 'en' ? 'Docs' : '文档'))

  function applyDocumentLabels(locale: Locale): void {
    if (typeof document === 'undefined') return

    const labels = THEME_LABELS[locale]
    const skip = document.querySelector<HTMLAnchorElement>('.VPSkipLink')
    if (skip) skip.textContent = labels.skipToContentLabel

    const appearance = document.querySelector<HTMLElement>('.VPSwitchAppearance')
    if (appearance) {
      appearance.setAttribute('aria-label', labels.darkModeSwitchLabel)
      const dark = document.documentElement.classList.contains('dark')
      appearance.setAttribute(
        'title',
        dark ? labels.lightModeSwitchTitle : labels.darkModeSwitchTitle,
      )
    }

    const hamburger = document.querySelector<HTMLElement>('.VPNavBarHamburger')
    hamburger?.setAttribute('aria-label', labels.mobileMenuLabel)
  }

  function activateLocale(locale: Locale): void {
    activate(locale)
    applyDocumentMeta(locale)
    void nextTick(() => applyDocumentLabels(locale))
  }

  function applyDocumentMeta(locale: Locale): void {
    if (typeof document === 'undefined') return

    const description =
      locale === 'en'
        ? 'Turn WeChat into an input/output channel for AI'
        : '把微信变成 AI 的输入输出通道'
    document
      .querySelector<HTMLMetaElement>('meta[name="description"]')
      ?.setAttribute('content', description)
  }

  function initialize(): void {
    const saved = readSavedLocale(browserStorage())
    if (saved) landingLocale.value = saved
    syncFromRoute()
  }

  function syncFromRoute(): void {
    if (isDocs.value) {
      const locale = localeFromDocsPath(path.value)
      activateLocale(locale)

      // Opening the English docs is an explicit English choice; remember it so
      // the logo/Home link goes to the English landing page.
      if (locale === 'en') {
        landingLocale.value = 'en'
        writeSavedLocale(browserStorage(), 'en')
      }
    } else {
      const saved = readSavedLocale(browserStorage())
      if (saved) landingLocale.value = saved
      activateLocale(landingLocale.value)
    }

    clearPending()
  }

  function switchTo(target: Locale): void {
    if (target === current.value) return

    if (!isDocs.value) {
      landingLocale.value = target
      writeSavedLocale(browserStorage(), target)
      activateLocale(target)
      return
    }

    const next = docsPathForTarget(path.value, target)
    const normalized = normalizePath(path.value)
    const missingPage =
      next === DOCS_HOME[target] &&
      normalized !== normalizePath(DOCS_HOME.zh) &&
      normalized !== normalizePath(DOCS_HOME.en)

    if (missingPage) {
      showNotice(
        target === 'en'
          ? 'This page is not available in English yet. 这篇还没有英文版。'
          : 'This page is not available in Chinese yet. 这篇还没有中文版。',
      )
    }

    landingLocale.value = target
    writeSavedLocale(browserStorage(), target)
    void router.go(withBasePath(base.value, next) + route.query + route.hash)
  }

  return {
    current,
    isDocs,
    docsHref,
    docsLabel,
    notice,
    initialize,
    syncFromRoute,
    switchTo,
    clearNotice,
  }
}
