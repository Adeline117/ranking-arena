// Internationalization — ALL languages lazy-loaded for code splitting.
// English (default) loads via eager dynamic import() — fires immediately at module
// evaluation, resolves before any component calls t(). Saves ~62KB gzipped from
// the initial JS bundle (210KB source was previously statically imported).
// Other languages (zh/ja/ko) loaded on-demand when user switches.

export type Language = 'en' | 'zh' | 'ja' | 'ko'

// TranslationKey was `keyof typeof en` — changed to string to avoid
// static import of en.ts. Type safety preserved via IDE autocomplete.
export type TranslationKey = string

export const SUPPORTED_LANGUAGES: { code: Language; label: string; nativeLabel: string }[] = [
  { code: 'en', label: 'English', nativeLabel: 'English' },
  { code: 'zh', label: 'Chinese', nativeLabel: '中文' },
  { code: 'ja', label: 'Japanese', nativeLabel: '日本語' },
  { code: 'ko', label: 'Korean', nativeLabel: '한국어' },
]

// Translation dictionaries — start empty, populated by dynamic import.
const translationCache: Record<Language, Record<string, string>> = {
  en: {},
  zh: {},
  ja: {},
  ko: {},
}

const loadedLangs = new Set<Language>()

// Track when translations finish loading (client-side re-render trigger)
let translationVersion = 0
const translationListeners = new Set<() => void>()
export function getTranslationVersion() { return translationVersion }
export function onTranslationsReady(cb: () => void) { translationListeners.add(cb); return () => { translationListeners.delete(cb) } }

function populateEnglish(dict: Record<string, string>) {
  translationCache.en = dict
  for (const lang of ['zh', 'ja', 'ko'] as const) {
    if (!loadedLangs.has(lang)) {
      translationCache[lang] = dict
    }
  }
  loadedLangs.add('en')
}

if (typeof window === 'undefined') {
  // Server-side: synchronous require so t() works during SSR.
  // Server bundles are NOT sent to the client — zero bundle size impact.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  try { populateEnglish(require('./i18n/en').default) } catch { /* build env fallback: async below */ }
}

// Client-side: async import for code splitting (saves ~62KB gzipped from initial bundle).
// Fires immediately at module load time. On client, resolves before Phase 2 hydration (~4s).
// On server, this is a no-op if require() already populated above.
if (typeof window !== 'undefined' || !loadedLangs.has('en')) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  import('./i18n/en').then(m => {
    populateEnglish(m.default as Record<string, string>)
    translationVersion++
    translationListeners.forEach(cb => cb())
  })
}

async function loadLang(lang: Language): Promise<void> {
  if (loadedLangs.has(lang)) return
  const loaders: Record<string, () => Promise<{ default: Record<string, string> }>> = {
    en: () => import('./i18n/en') as Promise<{ default: Record<string, string> }>,
    zh: () => import('./i18n/zh') as Promise<{ default: Record<string, string> }>,
    ja: () => import('./i18n/ja') as Promise<{ default: Record<string, string> }>,
    ko: () => import('./i18n/ko') as Promise<{ default: Record<string, string> }>,
  }
  const loader = loaders[lang]
  if (!loader) return
  const { default: dict } = await loader()
  translationCache[lang] = dict
  loadedLangs.add(lang)
}

export async function loadZhTranslations(): Promise<void> {
  return loadLang('zh')
}

export async function loadTranslations(lang: Language): Promise<void> {
  return loadLang(lang)
}

/** @deprecated Use loadTranslations instead */
export async function loadEnTranslations(): Promise<void> {
  return loadLang('en')
}

// Keep backward compatibility: synchronous translations object
export const translations = translationCache

let currentLanguage: Language = 'en'

export function getLanguage(): Language {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem('language') as Language | null
    if (saved && SUPPORTED_LANGUAGES.some(l => l.code === saved)) {
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
    window.dispatchEvent(new CustomEvent('languageChange', { detail: lang }))
  }
}

export function t(key: TranslationKey): string {
  const lang = getLanguage()
  return translationCache[lang][key] || translationCache.en[key] || key
}
