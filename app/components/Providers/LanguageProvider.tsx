'use client'

import { createContext, useContext, useState, useEffect, useMemo, useCallback, ReactNode } from 'react'
import { Language, getLanguage, setLanguage as setLang, translations, loadZhTranslations } from '@/lib/i18n'

// Translation function type - accepts any string but returns the key if not found
export type TranslationFunction = (key: string) => string

type LanguageContextType = {
  language: Language
  setLanguage: (lang: Language) => void
  t: TranslationFunction
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined)

export function LanguageProvider({ children }: { children: ReactNode }) {
  // Default to 'en' (sync-loaded). zh loads on-demand.
  // Use 'en' for SSR to match the sync-loaded translations and avoid hydration mismatch.
  const [language, setLanguageState] = useState<Language>('en')
  const [isMounted, setIsMounted] = useState(false)

  useEffect(() => {
    setIsMounted(true)
    const savedLanguage = getLanguage()
    
    // Load Chinese translations on-demand if needed
    if (savedLanguage === 'zh') {
      loadZhTranslations().then(() => setLanguageState('zh'))
    } else {
      setLanguageState(savedLanguage)
    }

    const handleLanguageChange = (e: CustomEvent<Language>) => {
      if (e.detail === 'zh') {
        loadZhTranslations().then(() => setLanguageState(e.detail))
      } else {
        setLanguageState(e.detail)
      }
    }

    window.addEventListener('languageChange', handleLanguageChange as EventListener)
    return () => window.removeEventListener('languageChange', handleLanguageChange as EventListener)
  }, [])

  const setLanguage = useCallback((lang: Language) => {
    setLang(lang)
    if (lang === 'zh') {
      loadZhTranslations().then(() => setLanguageState(lang))
    } else {
      setLanguageState(lang)
    }
  }, [])

  // Reactive translation function — uses 'en' before hydration to match SSR
  const t = useMemo((): TranslationFunction => {
    const currentLang = isMounted ? language : 'en'
    return (key: string): string => {
      const k = key as keyof typeof translations.en
      return translations[currentLang][k] || translations.en[k] || key
    }
  }, [language, isMounted])

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
        return translations[defaultLanguage][k] || translations.en[k] || key
      }) as TranslationFunction
    }
  }
  return context
}
