'use client'

import { createContext, useContext, useState, useEffect, useMemo, useCallback, ReactNode } from 'react'
import { type Language, getLanguage, setLanguage as setLang, translations, loadTranslations, getTranslationVersion, onTranslationsReady } from '@/lib/i18n'

// Translation function type - accepts any string but returns the key if not found
export type TranslationFunction = (key: string) => string

// Eager-load user's saved language at module eval time (before first render).
// English is already eager-loaded in i18n.ts. This handles non-English users.
if (typeof window !== 'undefined') {
  const saved = localStorage.getItem('language') as Language | null
  if (saved && saved !== 'en') {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    loadTranslations(saved)
  }
}

type LanguageContextType = {
  language: Language
  setLanguage: (lang: Language) => void
  t: TranslationFunction
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined)

export function LanguageProvider({ children }: { children: ReactNode }) {
  // Start with 'en' to match SSR output — getLanguage() reads localStorage which is only
  // available after hydration. We update in useEffect once mounted.
  const [language, setLanguageState] = useState<Language>('en')
  // Bump when English translations finish async loading — forces t() consumers to re-render
  const [, setTxnVersion] = useState(() => getTranslationVersion())

  useEffect(() => {
    // Re-render once when English translations finish loading (async import on client)
    const unsub = onTranslationsReady(() => setTxnVersion(v => v + 1))

    const savedLanguage = getLanguage()
    if (savedLanguage !== 'en') {
      loadTranslations(savedLanguage).then(() => setLanguageState(savedLanguage))
    }

    // Pre-cache all language files in the background
    const preloadLangs: Language[] = ['zh', 'ja', 'ko']
    if (requestIdleCallback) {
      requestIdleCallback(() => { preloadLangs.forEach(lang => loadTranslations(lang)) })
    } else {
      setTimeout(() => { preloadLangs.forEach(lang => loadTranslations(lang)) }, 2000)
    }

    const handleLanguageChange = (e: CustomEvent<Language>) => {
      if (e.detail !== 'en') {
        loadTranslations(e.detail).then(() => setLanguageState(e.detail))
      } else {
        setLanguageState(e.detail)
      }
    }

    window.addEventListener('languageChange', handleLanguageChange as EventListener)
    return () => { unsub(); window.removeEventListener('languageChange', handleLanguageChange as EventListener) }
  }, [])

  const setLanguage = useCallback((lang: Language) => {
    setLang(lang)
    if (lang !== 'en') {
      loadTranslations(lang).then(() => setLanguageState(lang))
    } else {
      setLanguageState(lang)
    }
  }, [])

  // Stable translation function — only recreated when language actually changes, not on mount
  const t = useMemo((): TranslationFunction => {
    return (key: string): string => {
      const k = key as keyof typeof translations.en
      return translations[language][k] ?? translations.en[k] ?? key
    }
  }, [language])

  const contextValue = useMemo(() => ({ language, setLanguage, t }), [language, setLanguage, t])

  return (
    <LanguageContext.Provider value={contextValue}>
      {children}
    </LanguageContext.Provider>
  )
}

export function useLanguage() {
  const context = useContext(LanguageContext)
  if (!context) {
    const defaultLanguage = getLanguage()
    return {
      language: defaultLanguage,
      setLanguage: setLang,
      t: ((key: string): string => {
        const k = key as keyof typeof translations.en
        return translations[defaultLanguage][k] ?? translations.en[k] ?? key
      }) as TranslationFunction
    }
  }
  return context
}
