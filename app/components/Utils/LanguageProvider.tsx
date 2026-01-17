'use client'

import { createContext, useContext, useState, useEffect, useMemo, ReactNode } from 'react'
import { Language, getLanguage, setLanguage as setLang, translations } from '@/lib/i18n'

// Translation function type - accepts any string but returns the key if not found
export type TranslationFunction = (key: string) => string

type LanguageContextType = {
  language: Language
  setLanguage: (lang: Language) => void
  t: TranslationFunction
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined)

export function LanguageProvider({ children }: { children: ReactNode }) {
  // 在服务器端和客户端首次渲染时都使用 'zh' 作为默认值，避免 hydration mismatch
  // 然后在客户端 hydration 后再从 localStorage 读取实际值
  const [language, setLanguageState] = useState<Language>('zh')
  const [isMounted, setIsMounted] = useState(false)

  useEffect(() => {
    // 客户端 hydration 后，从 localStorage 读取实际语言设置
    setIsMounted(true)
    const savedLanguage = getLanguage()
    setLanguageState(savedLanguage)

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
  // 在 hydration 完成前，始终使用 'zh' 避免不匹配
  const t = useMemo((): TranslationFunction => {
    const currentLang = isMounted ? language : 'zh'
    return (key: string): string => {
      const k = key as keyof typeof translations.zh
      return translations[currentLang][k] || translations.zh[k] || key
    }
  }, [language, isMounted])

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
      t: ((key: string): string => {
        const k = key as keyof typeof translations.zh
        return translations[defaultLanguage][k] || translations.zh[k] || key
      }) as TranslationFunction
    }
  }
  return context
}

