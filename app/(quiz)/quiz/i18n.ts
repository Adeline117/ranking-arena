/**
 * Quiz-only i18n — lightweight alternative to lib/i18n.
 *
 * lib/i18n statically imports en.ts (5700 lines, ~200KB) which gets bundled
 * into every page that imports it. Quiz only needs ~360 quiz-specific keys
 * (~20KB). This module provides the same t() API with 90% less bundle size.
 *
 * Language parity: the site ships en/zh/ja/ko. The quiz bundles the full English
 * dictionary and lazy-loads dedicated zh / ja / ko dictionaries on demand (each
 * a ~20KB chunk fetched only when that language is selected). Any key missing
 * from a dictionary falls back to English per-key at the t() call site.
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
  ja: {}, // lazy-loaded on demand
  ko: {}, // lazy-loaded on demand
}

const loaded: Record<Exclude<Language, 'en'>, boolean> = {
  zh: false,
  ja: false,
  ko: false,
}
const listeners = new Set<() => void>()

export function onTranslationsReady(cb: () => void) {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export async function loadTranslations(lang: Language): Promise<void> {
  // en is bundled; zh/ja/ko are lazy-loaded once each.
  if (lang === 'en' || loaded[lang]) return
  const dict =
    lang === 'zh'
      ? (await import('./i18n-zh')).default
      : lang === 'ja'
        ? (await import('./i18n-ja')).default
        : (await import('./i18n-ko')).default
  translations[lang] = dict
  loaded[lang] = true
  listeners.forEach((cb) => cb())
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
