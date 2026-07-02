'use client'

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
  useCallback,
  ReactNode,
} from 'react'
import {
  type Language,
  getLanguage,
  setLanguage as setLang,
  translations,
  loadTranslations,
  getTranslationVersion,
  onTranslationsReady,
} from '@/lib/i18n'

// Translation function type - accepts any string but returns the key if not found
export type TranslationFunction = (key: string) => string

// Eager-load user's saved language at module eval time (before first render).
// English is already eager-loaded in i18n.ts. This handles non-English users.
if (typeof window !== 'undefined') {
  const saved = localStorage.getItem('language') as Language | null
  if (saved && saved !== 'en') {
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
  // Bump when English translations finish async loading — forces t() consumers to re-render.
  // The version value MUST feed the t/contextValue memo deps below, otherwise the bump
  // re-renders the provider but produces an identical context reference and stale consumers
  // (e.g. a static subtree like /rankings/bots) keep showing raw feature keys.
  const [txnVersion, setTxnVersion] = useState(() => getTranslationVersion())

  useEffect(() => {
    // Re-render once when English translations finish loading (async import on client)
    const unsub = onTranslationsReady(() => setTxnVersion((v) => v + 1))

    const savedLanguage = getLanguage()
    if (savedLanguage !== 'en') {
      loadTranslations(savedLanguage).then(() => setLanguageState(savedLanguage))
    }

    // Pre-cache all language files in the background
    const preloadLangs: Language[] = ['zh', 'ja', 'ko']
    if (requestIdleCallback) {
      requestIdleCallback(() => {
        preloadLangs.forEach((lang) => loadTranslations(lang))
      })
    } else {
      setTimeout(() => {
        preloadLangs.forEach((lang) => loadTranslations(lang))
      }, 2000)
    }

    const handleLanguageChange = (e: CustomEvent<Language>) => {
      if (e.detail !== 'en') {
        loadTranslations(e.detail).then(() => setLanguageState(e.detail))
      } else {
        setLanguageState(e.detail)
      }
    }

    window.addEventListener('languageChange', handleLanguageChange as EventListener)
    return () => {
      unsub()
      window.removeEventListener('languageChange', handleLanguageChange as EventListener)
    }
  }, [])

  const setLanguage = useCallback((lang: Language) => {
    // setLang writes the cookie, fires languageChange (client re-render), and
    // hard-reloads when the page has SSR-only localized content the client tree
    // can't update (e.g. the homepage hero). See lib/i18n.ts setLanguage.
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
      const value = translations[language][k] ?? translations.en[k]
      if (value === undefined) {
        if (process.env.NODE_ENV === 'development') {
          console.warn(`[i18n] Missing translation key: "${key}" (lang=${language})`)
        }
        return key
      }
      return value
    }
    // txnVersion is intentionally in the deps: when the full async dictionary merges in,
    // the version bumps and we must hand consumers a fresh t() so feature keys re-resolve.
  }, [language, txnVersion])

  const contextValue = useMemo(() => ({ language, setLanguage, t }), [language, setLanguage, t])

  return <LanguageContext.Provider value={contextValue}>{children}</LanguageContext.Provider>
}

export function useLanguage() {
  const context = useContext(LanguageContext)

  // Hydration-safe fallback for subtrees rendered OUTSIDE LanguageProvider.
  // The homepage (`/`, `/rankings`) deliberately omits Providers for LCP
  // (see app/layout.tsx), so RankingControls/useRankingFilters/RankingFooter
  // land here. Previously the fallback called getLanguage() inline, which reads
  // localStorage and returns the user's real language on the FIRST client render
  // while the server rendered 'en' (server getLanguage() returns the module
  // default) — a React #418 hydration mismatch on the highest-traffic pages.
  //
  // Fix: mirror the provider's own strategy — start at 'en' to match SSR, then
  // swap to the saved language after mount. Hooks are called unconditionally
  // (above the context branch) to satisfy the rules of hooks; when a provider IS
  // present this state is computed but unused (negligible cost).
  const [fallbackLanguage, setFallbackLanguage] = useState<Language>('en')
  const [, setFallbackTxnVersion] = useState(() => getTranslationVersion())

  useEffect(() => {
    if (context) return // provider present — fallback unused, skip listeners

    const unsub = onTranslationsReady(() => setFallbackTxnVersion((v) => v + 1))

    const savedLanguage = getLanguage()
    if (savedLanguage !== 'en') {
      loadTranslations(savedLanguage).then(() => setFallbackLanguage(savedLanguage))
    }

    const handleLanguageChange = (e: CustomEvent<Language>) => {
      if (e.detail !== 'en') {
        loadTranslations(e.detail).then(() => setFallbackLanguage(e.detail))
      } else {
        setFallbackLanguage(e.detail)
      }
    }
    window.addEventListener('languageChange', handleLanguageChange as EventListener)
    return () => {
      unsub()
      window.removeEventListener('languageChange', handleLanguageChange as EventListener)
    }
  }, [context])

  if (!context) {
    return {
      language: fallbackLanguage,
      setLanguage: setLang,
      t: ((key: string): string => {
        const k = key as keyof typeof translations.en
        return translations[fallbackLanguage][k] ?? translations.en[k] ?? key
      }) as TranslationFunction,
    }
  }
  return context
}
