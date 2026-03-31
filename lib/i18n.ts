// Internationalization - split by language for code splitting
// en is loaded synchronously (default), others loaded on-demand
// Future optimization: split en.ts (~4400 lines) into domain-specific chunks
// (e.g., en/rankings.ts, en/trader.ts, en/library.ts) and lazy-load
// non-critical chunks to reduce initial bundle size.
import en from './i18n/en'

export type Language = 'en' | 'zh' | 'ja' | 'ko'

export const SUPPORTED_LANGUAGES: { code: Language; label: string; nativeLabel: string }[] = [
  { code: 'en', label: 'English', nativeLabel: 'English' },
  { code: 'zh', label: 'Chinese', nativeLabel: '中文' },
  { code: 'ja', label: 'Japanese', nativeLabel: '日本語' },
  { code: 'ko', label: 'Korean', nativeLabel: '한국어' },
]

export type TranslationKey = keyof typeof en

// Translation dictionaries - en always available, others loaded lazily
const translationCache: Record<Language, Record<string, string>> = {
  en: en as Record<string, string>,
  zh: en as Record<string, string>,
  ja: en as Record<string, string>,
  ko: en as Record<string, string>,
}

const loadedLangs = new Set<Language>(['en'])

async function loadLang(lang: Language): Promise<void> {
  if (loadedLangs.has(lang)) return
  const loaders: Record<string, () => Promise<{ default: Record<string, string> }>> = {
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
  return
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
  return translationCache[lang][key as string] || translationCache.en[key as string] || key
}
