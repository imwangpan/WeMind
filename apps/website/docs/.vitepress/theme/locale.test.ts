import { describe, expect, it } from 'vite-plus/test'
import {
  DEFAULT_LOCALE,
  DOCS_HOME,
  LOCALE_STORAGE_KEY,
  docsPathForTarget,
  htmlLang,
  isDocsPath,
  localeFromDocsPath,
  normalizePath,
  readSavedLocale,
  stripBase,
  withBasePath,
  writeSavedLocale,
} from './locale'

describe('locale paths', () => {
  it('normalizes VitePress paths with and without html', () => {
    expect(normalizePath('/')).toBe('/')
    expect(normalizePath('/guide/')).toBe('/guide')
    expect(normalizePath('/guide/index.html')).toBe('/guide')
    expect(normalizePath('/guide/getting-started.html')).toBe('/guide/getting-started')
    expect(normalizePath('/en/guide/?from=test')).toBe('/en/guide')
  })

  it('recognizes landing and docs paths', () => {
    expect(isDocsPath('/')).toBe(false)
    expect(isDocsPath('/guidebook')).toBe(false)
    expect(isDocsPath('/guide')).toBe(true)
    expect(isDocsPath('/guide/')).toBe(true)
    expect(isDocsPath('/agents/foo')).toBe(true)
    expect(isDocsPath('/reference')).toBe(true)
    expect(isDocsPath('/faq')).toBe(true)
    expect(isDocsPath('/en')).toBe(true)
    expect(isDocsPath('/en/guide/')).toBe(true)
  })

  it('derives the locale from the docs URL', () => {
    expect(localeFromDocsPath('/guide/')).toBe('zh')
    expect(localeFromDocsPath('/en/guide/')).toBe('en')
    expect(localeFromDocsPath('/en')).toBe('en')
  })
})

describe('docs path mapping', () => {
  it('maps in both directions and falls back to the docs home', () => {
    expect(docsPathForTarget('/guide/', 'en')).toBe('/en/guide/')
    expect(docsPathForTarget('/guide/getting-started', 'en')).toBe('/en/guide/getting-started')
    expect(docsPathForTarget('/guide/media', 'en')).toBe('/en/guide/')
    expect(docsPathForTarget('/agents', 'en')).toBe('/en/guide/agents')
    expect(docsPathForTarget('/en/guide/agents', 'zh')).toBe('/agents')
    expect(docsPathForTarget('/en/guide/getting-started', 'zh')).toBe('/guide/getting-started')
    expect(docsPathForTarget('/en/guide/unknown', 'zh')).toBe('/guide/')
    expect(docsPathForTarget('/', 'en')).toBe('/en/guide/')
    expect(docsPathForTarget('/en', 'zh')).toBe('/guide/')
  })
})

describe('deploy base', () => {
  it('strips and adds the base only when needed', () => {
    expect(stripBase('/guide/', '/')).toBe('/guide/')
    expect(stripBase('/WeMind/guide/', '/WeMind/')).toBe('/guide/')
    expect(stripBase('/WeMind/', '/WeMind/')).toBe('/')
    expect(stripBase('/WeMindish/guide', '/WeMind/')).toBe('/WeMindish/guide')
    expect(withBasePath('/', '/en/guide/')).toBe('/en/guide/')
    expect(withBasePath('/WeMind/', '/en/guide/')).toBe('/WeMind/en/guide/')
  })
})

describe('locale preference', () => {
  it('reads and writes only valid locale preferences', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
    }

    expect(readSavedLocale(storage)).toBeNull()
    writeSavedLocale(storage, 'en')
    expect(values.get(LOCALE_STORAGE_KEY)).toBe('en')
    expect(readSavedLocale(storage)).toBe('en')
    expect(readSavedLocale(null)).toBeNull()

    values.set(LOCALE_STORAGE_KEY, 'fr')
    expect(readSavedLocale(storage)).toBeNull()
  })

  it('keeps the default and html language in sync', () => {
    expect(DEFAULT_LOCALE).toBe('zh')
    expect(DOCS_HOME.zh).toBe('/guide/')
    expect(DOCS_HOME.en).toBe('/en/guide/')
    expect(htmlLang('zh')).toBe('zh-CN')
    expect(htmlLang('en')).toBe('en-US')
  })
})
