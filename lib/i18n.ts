// Internationalization — two-phase loading for performance:
//
// Phase 1 (sync, in bundle): en-core.ts (~300 keys) covers navigation, errors,
//   loading states, rankings table, footer — everything visible in the first paint.
//   This replaces the previous full static import of en.ts (~5700 lines / ~180KB).
//
// Phase 2 (async, after mount): the full en.ts is lazy-loaded and merged in.
//   Once loaded, all ~5400 feature keys become available. Components that already
//   rendered with a core key keep working; components that need a feature key
//   get it after the merge (typically < 100ms on broadband).
//
// For non-English languages, zh-core.ts is also statically imported so Chinese
// users see translated core keys immediately. The full zh.ts is lazy-loaded.
//
// History: en.ts was previously statically imported in its entirety ("always
// available") but at 5700 lines it added ~180KB to the main JS bundle. Before
// that it was fully lazy-loaded which caused raw i18n keys to flash on mobile
// during React hydration. This two-phase approach gives us the best of both.

import enCore from './i18n/en-core'
import zhCore from './i18n/zh-core'

export type Language = 'en' | 'zh' | 'ja' | 'ko'

export type TranslationKey = string

export const SUPPORTED_LANGUAGES: { code: Language; label: string; nativeLabel: string }[] = [
  { code: 'en', label: 'English', nativeLabel: 'English' },
  { code: 'zh', label: 'Chinese', nativeLabel: '中文' },
  { code: 'ja', label: 'Japanese', nativeLabel: '日本語' },
  { code: 'ko', label: 'Korean', nativeLabel: '한국어' },
]

// Translation dictionaries — core keys available immediately, full sets lazy-loaded.
// We use a mutable record so we can merge in the full dictionaries at runtime.
const translationCache: Record<Language, Record<string, string>> = {
  en: { ...(enCore as unknown as Record<string, string>) },
  zh: { ...(zhCore as unknown as Record<string, string>) },
  ja: {},
  ko: {},
}

// Track which languages have their FULL dictionaries loaded.
// 'en' and 'zh' start with core-only; full load happens async.
const loadedLangs = new Set<Language>()
// Track which languages have at least core keys (to avoid setting fallback twice)
const hasCoreLangs = new Set<Language>(['en', 'zh'])

// For unloaded languages, fall back to English core so t() never returns undefined.
for (const lang of ['ja', 'ko'] as const) {
  translationCache[lang] = { ...(enCore as unknown as Record<string, string>) }
}

// Track when translations finish loading (client-side re-render trigger)
let translationVersion = 0
const translationListeners = new Set<() => void>()
export function getTranslationVersion() {
  return translationVersion
}
export function onTranslationsReady(cb: () => void) {
  translationListeners.add(cb)
  return () => {
    translationListeners.delete(cb)
  }
}

function notifyListeners() {
  translationVersion++
  for (const cb of translationListeners) {
    try {
      cb()
    } catch {
      // ignore listener errors
    }
  }
}

// Guard: English core must ALWAYS be synchronously available.
if (Object.keys(translationCache.en).length === 0) {
  throw new Error(
    '[i18n] FATAL: English core translations are empty at module load time. ' +
      'en-core.ts must be statically imported (not lazy-loaded).'
  )
}

// ── Full dictionary loading ───────────────────────────────────────────

// In-flight promises to avoid duplicate loads
const loadingPromises: Partial<Record<Language, Promise<void>>> = {}

async function loadLang(lang: Language): Promise<void> {
  if (loadedLangs.has(lang)) return
  if (loadingPromises[lang]) return loadingPromises[lang]

  const loaders: Record<string, () => Promise<{ default: Record<string, string> }>> = {
    en: () => import('./i18n/en') as Promise<{ default: Record<string, string> }>,
    zh: () => import('./i18n/zh') as Promise<{ default: Record<string, string> }>,
    ja: () => import('./i18n/ja') as Promise<{ default: Record<string, string> }>,
    ko: () => import('./i18n/ko') as Promise<{ default: Record<string, string> }>,
  }
  const loader = loaders[lang]
  if (!loader) return

  const promise = (async () => {
    const { default: dict } = await loader()
    // Merge full dictionary over existing core keys
    Object.assign(translationCache[lang], dict)
    loadedLangs.add(lang)

    // For languages without their own core (ja, ko), also update their fallback
    // from the full English dictionary now that it's available
    if (lang === 'en') {
      for (const fallbackLang of ['ja', 'ko'] as const) {
        if (!loadedLangs.has(fallbackLang) && !hasCoreLangs.has(fallbackLang)) {
          Object.assign(translationCache[fallbackLang], dict)
        }
      }
    }

    notifyListeners()
  })()

  loadingPromises[lang] = promise
  try {
    await promise
  } finally {
    delete loadingPromises[lang]
  }
}

// Eagerly start loading the full English dictionary on module init.
// This is async so it doesn't block; core keys cover the first paint.
if (typeof window !== 'undefined') {
  // Client: load after a microtask so it doesn't compete with hydration
  Promise.resolve().then(() => {
    // eslint-disable-next-line no-restricted-syntax
    loadLang('en').catch(() => {
      // Silent fail — core keys are still available
    })
  })
} else {
  // Server: load synchronously is not possible with dynamic import,
  // but core keys cover SSR output. Full dict loads on client hydration.
}

export async function loadTranslations(lang: Language): Promise<void> {
  return loadLang(lang)
}

// Keep backward compatibility: synchronous translations object
export const translations = translationCache

let currentLanguage: Language = 'en'

export function getLanguage(): Language {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem('language') as Language | null
    if (saved && SUPPORTED_LANGUAGES.some((l) => l.code === saved)) {
      currentLanguage = saved
      return saved
    }
  }
  return currentLanguage
}

export function setLanguage(lang: Language) {
  currentLanguage = lang
  if (typeof window !== 'undefined') {
    localStorage.setItem('language', lang)
    // Sync to cookie so Server Components can read the language preference
    document.cookie = `language=${lang};path=/;max-age=31536000;SameSite=Lax`
    window.dispatchEvent(new CustomEvent('languageChange', { detail: lang }))
    // Client components re-render off the languageChange event, but SSR-only
    // content can't — the homepage hero (#ssr-hero-shell) is server-rendered
    // AND edge-cached, and the homepage omits the LanguageProvider for LCP, so
    // its toggle lands here (the fallback path). When such SSR-only localized
    // content is present, hard-reload so the whole page reflects the new
    // language (with the cookie now set, the SSR render comes back localized).
    // Language switching is rare, so the reload cost is acceptable.
    if (document.getElementById('ssr-hero-shell')) {
      window.location.reload()
    }
  }
}

export function t(key: TranslationKey): string {
  const lang = getLanguage()
  const value = translationCache[lang][key] || translationCache.en[key]
  if (!value) {
    // Surface missing keys loudly in development so they get fixed before deploy.
    // In production, fall back to the key itself to avoid blank UI.
    if (process.env.NODE_ENV === 'development') {
      console.warn(`[i18n] Missing translation key: "${key}" (lang=${lang})`)
    }
    return key
  }
  return value
}
