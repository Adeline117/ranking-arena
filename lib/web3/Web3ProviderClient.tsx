'use client'

import { ReactNode, useEffect, useState } from 'react'
import { WagmiProvider } from 'wagmi'
// @tanstack/react-query is a required peer dependency of wagmi (>=5.0.0)
// and @rainbow-me/rainbowkit. Do NOT remove this dependency.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RainbowKitProvider, darkTheme, lightTheme, type Locale } from '@rainbow-me/rainbowkit'
import { STALE_RELAXED } from '@/lib/hooks/cache-presets'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { wagmiConfig } from './config'

import '@rainbow-me/rainbowkit/styles.css'

// The site Language union ('en' | 'zh' | 'ja' | 'ko') is a subset of RainbowKit's
// Locale codes, so it maps 1:1 (zh → Simplified Chinese). Cast keeps tsc honest
// without a lookup table.
function toRainbowLocale(lang: string): Locale {
  return (['en', 'zh', 'ja', 'ko'].includes(lang) ? lang : 'en') as Locale
}

/** Observe the site theme (data-theme on <html>) so the wallet modal isn't a
 *  dark island on a light page. Falls back to dark (matches the app default). */
function useSiteTheme(): 'dark' | 'light' {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  useEffect(() => {
    const read = () =>
      document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
    setTheme(read())
    const observer = new MutationObserver(() => setTheme(read()))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    return () => observer.disconnect()
  }, [])
  return theme
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: STALE_RELAXED,
      retry: 1,
    },
  },
})

export function Web3ProviderClient({ children }: { children: ReactNode }) {
  const { language } = useLanguage()
  const siteTheme = useSiteTheme()
  const themeOpts = {
    accentColor: 'var(--color-verified-web3)',
    accentColorForeground: 'white',
    borderRadius: 'medium' as const,
  }
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={siteTheme === 'light' ? lightTheme(themeOpts) : darkTheme(themeOpts)}
          locale={toRainbowLocale(language)}
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
