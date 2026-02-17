// Internationalization - split by language for code splitting
// en is loaded synchronously (default), zh is loaded on-demand
import en from './i18n/en'

export type Language = 'zh' | 'en'

export type TranslationKey = keyof typeof en

// Translation dictionaries - en always available, zh loaded lazily
const translationCache: Record<Language, Record<string, string>> = {
  en: en as Record<string, string>,
  zh: en as Record<string, string>, // Fallback to en until zh is loaded
}

let zhLoaded = false

export async function loadZhTranslations(): Promise<void> {
  if (zhLoaded) return
  const { default: zh } = await import('./i18n/zh')
  translationCache.zh = zh as Record<string, string>
  zhLoaded = true
}

/** @deprecated Use loadZhTranslations instead — en is now the sync default */
export async function loadEnTranslations(): Promise<void> {
  // No-op: en is already loaded synchronously
  return
}

// Keep backward compatibility: synchronous translations object
export const translations = translationCache

let currentLanguage: Language = 'en'

export function getLanguage(): Language {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem('language') as Language | null
    if (saved) {
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
