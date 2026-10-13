'use client'

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
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

/**
 * Whether a dictionary that just finished loading can change what `t()`
 * returns for the active language: its own dictionary, or English (the
 * fallback for missing keys; also merged into ja/ko placeholders). Loads of
 * any other language must not re-render every translated consumer.
 */
function affectsActiveLanguage(loaded: Language, active: Language): boolean {
  return loaded === active || loaded === 'en'
}

/**
 * zh ships a synchronous core dictionary (lib/i18n/zh-core), so a zh user can
 * switch the moment the provider mounts instead of after the async full
 * dictionary — shortening the post-hydration English flash. ja/ko have no core
 * (their placeholder is English), so they switch once loaded.
 */
function hasSyncCore(lang: Language): boolean {
  return lang === 'en' || lang === 'zh'
}

type LanguageContextType = {
  language: Language
  setLanguage: (lang: Language) => void
  t: TranslationFunction
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined)

export function LanguageProvider({ children }: { children: ReactNode }) {
  // Start with 'en' to match SSR output: the root layout renders lang="en" and
  // every client component's server HTML is English, so reading the saved
  // language (localStorage / the html lang set by the pre-hydration script)
  // during the first render would cause a React #418 hydration mismatch. We
  // switch right after hydration instead (see effect below).
  const [language, setLanguageState] = useState<Language>('en')
  const languageRef = useRef<Language>('en')
  languageRef.current = language
  // Bump when English translations finish async loading — forces t() consumers to re-render.
  // The version value MUST feed the t/contextValue memo deps below, otherwise the bump
  // re-renders the provider but produces an identical context reference and stale consumers
  // (e.g. a static subtree like /rankings/bots) keep showing raw feature keys.
  const [txnVersion, setTxnVersion] = useState(() => getTranslationVersion())

  useEffect(() => {
    // Full dictionaries must start AFTER React's first hydration commit. Starting
    // the English import in a module-level microtask can mutate translationCache
    // between SSR markup and the first client render, producing React #418 on
    // feature pages whose labels are outside en-core.
    const unsub = onTranslationsReady((loaded) => {
      if (affectsActiveLanguage(loaded, languageRef.current)) setTxnVersion((v) => v + 1)
    })
    loadTranslations('en').catch((error) => {
      console.warn('[i18n] Full English dictionary failed to load after hydration', error)
    })

    const savedLanguage = getLanguage()
    if (savedLanguage !== 'en') {
      if (hasSyncCore(savedLanguage)) {
        languageRef.current = savedLanguage
        setLanguageState(savedLanguage)
      }
      loadTranslations(savedLanguage).then(() => setLanguageState(savedLanguage))
    }

    // No idle pre-loading of the other languages: each full dictionary is a
    // large chunk most users never need; a language switch loads its own.

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
  const fallbackLanguageRef = useRef<Language>('en')
  fallbackLanguageRef.current = fallbackLanguage
  const [, setFallbackTxnVersion] = useState(() => getTranslationVersion())

  useEffect(() => {
    if (context) return // provider present — fallback unused, skip listeners

    const unsub = onTranslationsReady((loaded) => {
      if (affectsActiveLanguage(loaded, fallbackLanguageRef.current)) {
        setFallbackTxnVersion((v) => v + 1)
      }
    })
    loadTranslations('en').catch((error) => {
      console.warn('[i18n] Full English dictionary failed to load after hydration', error)
    })

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
