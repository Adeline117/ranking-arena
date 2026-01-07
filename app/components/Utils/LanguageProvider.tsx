'use client'

import { createContext, useContext, useState, useEffect, useMemo, ReactNode } from 'react'
import { Language, getLanguage, setLanguage as setLang, translations } from '@/lib/i18n'

type LanguageContextType = {
  language: Language
  setLanguage: (lang: Language) => void
  t: (key: keyof typeof translations.zh) => string
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined)

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(getLanguage())

  useEffect(() => {
    const handleLanguageChange = (e: CustomEvent<Language>) => {
      setLanguageState(e.detail)
    }

    window.addEventListener('languageChange', handleLanguageChange as EventListener)
    return () => window.removeEventListener('languageChange', handleLanguageChange as EventListener)
  }, [])

  const setLanguage = (lang: Language) => {
    setLang(lang)
    setLanguageState(lang)
  }

  // 创建一个响应式的翻译函数，依赖于 language 状态
  const t = useMemo(() => {
    return (key: keyof typeof translations.zh): string => {
      return translations[language][key] || translations.zh[key] || key
    }
  }, [language])

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  )
}

export function useLanguage() {
  const context = useContext(LanguageContext)
  if (!context) {
    // 如果不在 Provider 中，返回一个默认的翻译函数
    const defaultLanguage = getLanguage()
    return {
      language: defaultLanguage,
      setLanguage: setLang,
      t: (key: keyof typeof translations.zh): string => {
        return translations[defaultLanguage][key] || translations.zh[key] || key
      }
    }
  }
  return context
}

