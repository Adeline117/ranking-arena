'use client'

import { createContext, useContext, useState, useEffect, useMemo, useCallback, ReactNode } from 'react'
import { Language, getLanguage, setLanguage as setLang, translations, loadTranslations } from '@/lib/i18n'

// Translation function type - accepts any string but returns the key if not found
export type TranslationFunction = (key: string) => string

type LanguageContextType = {
  language: Language
  setLanguage: (lang: Language) => void
  t: TranslationFunction
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined)

export function LanguageProvider({ children }: { children: ReactNode }) {
  // Start with 'en' to match SSR output — getLanguage() reads localStorage which is only
  // available after hydration. We update in useEffect once mounted.
  // Previously, `isMounted` state (false→true after hydration) triggered ALL 343 useLanguage()
  // consumers to re-render on every page load. Removing that state eliminates that mass re-render.
  const [language, setLanguageState] = useState<Language>('en')

  useEffect(() => {
    const savedLanguage = getLanguage()

    if (savedLanguage !== 'en') {
      // Only update state if language differs from default — avoids unnecessary re-render
      loadTranslations(savedLanguage).then(() => setLanguageState(savedLanguage))
    }
    // If 'en', no state update needed — already initialized to 'en'

    // Pre-cache all language files in the background to eliminate flash when switching
    // Language files are small (~15KB each gzipped), so this is safe to do eagerly
    const preloadLangs: Language[] = ['zh', 'ja', 'ko']
    requestIdleCallback
      ? requestIdleCallback(() => { preloadLangs.forEach(lang => loadTranslations(lang)) })
      : setTimeout(() => { preloadLangs.forEach(lang => loadTranslations(lang)) }, 2000)

    const handleLanguageChange = (e: CustomEvent<Language>) => {
      if (e.detail !== 'en') {
        loadTranslations(e.detail).then(() => setLanguageState(e.detail))
      } else {
        setLanguageState(e.detail)
      }
    }

    window.addEventListener('languageChange', handleLanguageChange as EventListener)
    return () => window.removeEventListener('languageChange', handleLanguageChange as EventListener)
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
