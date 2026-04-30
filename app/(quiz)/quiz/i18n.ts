/**
 * Quiz-only i18n — lightweight alternative to lib/i18n.
 *
 * lib/i18n statically imports en.ts (5700 lines, ~200KB) which gets bundled
 * into every page that imports it. Quiz only needs ~360 quiz-specific keys
 * (~20KB). This module provides the same t() API with 90% less bundle size.
 */

import quizEn from './i18n-en'

export type Language = 'en' | 'zh'

const translations: Record<Language, Record<string, string>> = {
  en: quizEn,
  zh: {}, // lazy-loaded on demand
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
  if (lang === 'en') return
  if (lang === 'zh' && !zhLoaded) {
    const { default: quizZh } = await import('./i18n-zh')
    translations.zh = quizZh
    zhLoaded = true
    listeners.forEach((cb) => cb())
  }
}

export { translations }
