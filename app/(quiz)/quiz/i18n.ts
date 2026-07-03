/**
 * Quiz-only i18n — lightweight alternative to lib/i18n.
 *
 * lib/i18n statically imports en.ts (5700 lines, ~200KB) which gets bundled
 * into every page that imports it. Quiz only needs ~360 quiz-specific keys
 * (~20KB). This module provides the same t() API with 90% less bundle size.
 *
 * Language parity: the site ships en/zh/ja/ko. The quiz has a full English
 * dictionary (bundled) + a lazy-loaded Chinese dictionary. ja/ko render the
 * English dictionary as a fallback (the same C5 English-fallback convention
 * lib/i18n uses for not-yet-translated pages) but are first-class members of
 * the union so the quiz can (a) open in the visitor's site-wide language and
 * (b) expose all four languages in its in-quiz switcher, matching the global
 * LanguageToggle. When dedicated i18n-ja.ts / i18n-ko.ts dictionaries are
 * authored later, wire them into loadTranslations() the same way as zh.
 */

import quizEn from './i18n-en'

export type Language = 'en' | 'zh' | 'ja' | 'ko'

/** Languages offered by the in-quiz switcher, in cycle order. */
export const QUIZ_LANGUAGES: Language[] = ['en', 'zh', 'ja', 'ko']

/** Native labels for the in-quiz language switcher. */
export const QUIZ_LANG_LABELS: Record<Language, string> = {
  en: 'EN',
  zh: '中文',
  ja: '日本語',
  ko: '한국어',
}

const translations: Record<Language, Record<string, string>> = {
  en: quizEn,
  zh: {}, // lazy-loaded on demand
  ja: {}, // English fallback (no dedicated dictionary yet — C5 convention)
  ko: {}, // English fallback (no dedicated dictionary yet — C5 convention)
}

let zhLoaded = false
const listeners = new Set<() => void>()

export function onTranslationsReady(cb: () => void) {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export async function loadTranslations(lang: Language): Promise<void> {
  // en is bundled; ja/ko fall back to en (no dedicated dictionary yet).
  if (lang === 'zh' && !zhLoaded) {
    const { default: quizZh } = await import('./i18n-zh')
    translations.zh = quizZh
    zhLoaded = true
    listeners.forEach((cb) => cb())
  }
}

/**
 * Initial quiz language derived from the site-wide language (persisted by the
 * global LanguageProvider under localStorage 'language'), so a visitor who set
 * the site to 中文 opens the quiz in 中文 instead of always English. SSR and any
 * environment without localStorage fall back to 'en' (keeps hydration stable —
 * callers apply the real language in a mount effect).
 */
export function getInitialQuizLanguage(): Language {
  if (typeof window === 'undefined') return 'en'
  try {
    const saved = window.localStorage.getItem('language')
    if (saved && (QUIZ_LANGUAGES as string[]).includes(saved)) return saved as Language
  } catch {
    /* localStorage blocked (private mode / sandboxed iframe) — fall back to en */
  }
  return 'en'
}

/** Next language in the switcher cycle (en → zh → ja → ko → en). */
export function nextQuizLanguage(current: Language): Language {
  const i = QUIZ_LANGUAGES.indexOf(current)
  return QUIZ_LANGUAGES[(i + 1) % QUIZ_LANGUAGES.length]
}

export { translations }
