// Internationalization - split by language for code splitting
// zh is loaded synchronously (default), en is loaded on-demand
import zh from './i18n/zh'

export type Language = 'zh' | 'en'

export type TranslationKey = keyof typeof zh

// Translation dictionaries - zh always available, en loaded lazily
const translationCache: Record<Language, Record<string, string>> = {
  zh: zh as Record<string, string>,
  en: zh as Record<string, string>, // Fallback to zh until en is loaded
}

let enLoaded = false

export async function loadEnTranslations(): Promise<void> {
  if (enLoaded) return
  const { default: en } = await import('./i18n/en')
  translationCache.en = en as Record<string, string>
  enLoaded = true
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
  return translationCache[lang][key as string] || translationCache.zh[key as string] || key
}
