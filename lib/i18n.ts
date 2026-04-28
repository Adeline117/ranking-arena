// Internationalization — English statically imported (always available),
// other languages (zh/ja/ko) lazy-loaded on demand for code splitting.
// English was previously lazy-loaded too ("saves 62KB") but this caused raw
// i18n keys (foundingMemberBannerText, categoryAll, etc.) to flash on mobile
// when the async chunk hadn't loaded yet during React hydration.

import enTranslations from './i18n/en'

export type Language = 'en' | 'zh' | 'ja' | 'ko'

export type TranslationKey = string

export const SUPPORTED_LANGUAGES: { code: Language; label: string; nativeLabel: string }[] = [
  { code: 'en', label: 'English', nativeLabel: 'English' },
  { code: 'zh', label: 'Chinese', nativeLabel: '中文' },
  { code: 'ja', label: 'Japanese', nativeLabel: '日本語' },
  { code: 'ko', label: 'Korean', nativeLabel: '한국어' },
]

// Translation dictionaries — English available immediately, others lazy-loaded.
const translationCache: Record<Language, Record<string, string>> = {
  en: enTranslations as unknown as Record<string, string>,
  zh: {},
  ja: {},
  ko: {},
}

const loadedLangs = new Set<Language>(['en'])

// Track when translations finish loading (client-side re-render trigger)
const translationVersion = 0
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

function populateEnglish(dict: Record<string, string>) {
  translationCache.en = dict
  for (const lang of ['zh', 'ja', 'ko'] as const) {
    if (!loadedLangs.has(lang)) {
      translationCache[lang] = dict
    }
  }
  loadedLangs.add('en')
}

// English is statically imported — always available, no async loading needed.
// populateEnglish sets up fallback chains for other languages.
populateEnglish(enTranslations as unknown as Record<string, string>)

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
