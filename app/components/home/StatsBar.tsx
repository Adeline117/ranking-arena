'use client'

import { useState, useEffect, useRef, memo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'

// Convert hex color to rgba with given alpha
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

interface DataSource {
  exchange: string
  market: 'futures' | 'spot' | 'on-chain'
  key: string
}

const dataSources: DataSource[] = [
  // CEX 合约
  { exchange: 'Binance', market: 'futures', key: 'binance_futures' },
  { exchange: 'Bybit', market: 'futures', key: 'bybit' },
  { exchange: 'Bitget', market: 'futures', key: 'bitget_futures' },
  { exchange: 'OKX', market: 'futures', key: 'okx_futures' },
  { exchange: 'MEXC', market: 'futures', key: 'mexc' },
  { exchange: 'HTX', market: 'futures', key: 'htx_futures' },
  { exchange: 'Weex', market: 'futures', key: 'weex' },
  { exchange: 'KuCoin', market: 'futures', key: 'kucoin' },
  { exchange: 'CoinEx', market: 'futures', key: 'coinex' },
  { exchange: 'Phemex', market: 'futures', key: 'phemex' },
  { exchange: 'BingX', market: 'futures', key: 'bingx' },
  { exchange: 'Gate.io', market: 'futures', key: 'gateio' },
  { exchange: 'XT.com', market: 'futures', key: 'xt' },
  { exchange: 'Pionex', market: 'futures', key: 'pionex' },
  { exchange: 'LBank', market: 'futures', key: 'lbank' },
  { exchange: 'BloFin', market: 'futures', key: 'blofin' },
  // CEX 现货
  { exchange: 'Binance', market: 'spot', key: 'binance_spot' },
  { exchange: 'Bitget', market: 'spot', key: 'bitget_spot' },
  // 链上/DEX
  { exchange: 'Binance', market: 'on-chain', key: 'binance_web3' },
  { exchange: 'OKX', market: 'on-chain', key: 'okx_web3' },
  { exchange: 'GMX', market: 'on-chain', key: 'gmx' },
  { exchange: 'Hyperliquid', market: 'on-chain', key: 'hyperliquid' },
  { exchange: 'dYdX', market: 'on-chain', key: 'dydx' },
  { exchange: 'Kwenta', market: 'on-chain', key: 'kwenta' },
  { exchange: 'Gains', market: 'on-chain', key: 'gains' },
  { exchange: 'MUX', market: 'on-chain', key: 'mux' },
]

const getMarketConfig = (t: (key: string) => string): Record<string, { label: string; color: string; icon: React.ReactNode }> => ({
  futures: {
    label: t('futures'),
    color: tokens.colors.accent.brand,
    icon: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
        <polyline points="16 7 22 7 22 13" />
      </svg>
    ),
  },
  spot: {
    label: t('spot'),
    color: tokens.colors.accent.success,
    icon: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 6v12M6 12h12" />
      </svg>
    ),
  },
  'on-chain': {
    label: t('onChain'),
    color: tokens.colors.verified.web3,
    icon: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
    ),
  },
})

const SourceTag = memo(function SourceTag({ source, isDark, t }: { source: DataSource; isDark: boolean; t: (key: string) => string }) {
  const marketConfig = getMarketConfig(t)
  const market = marketConfig[source.market]
  const tagBg = hexToRgba(market.color, isDark ? 0.03 : 0.08)
  const tagBorder = hexToRgba(market.color, isDark ? 0.14 : 0.25)
  const badgeBg = hexToRgba(market.color, isDark ? 0.08 : 0.18)

  return (
    <Box
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 12px',
        borderRadius: 20,
        background: tagBg,
        border: `1px solid ${tagBorder}`,
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      <Text
        size="sm"
        weight="bold"
        style={{ color: tokens.colors.text.primary }}
      >
        {source.exchange}
      </Text>
      <Box
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 3,
          padding: '1px 6px',
          borderRadius: 10,
          background: badgeBg,
          color: market.color,
        }}
      >
        {market.icon}
        <Text
          size="xs"
          weight="semibold"
          style={{ color: market.color, fontSize: 10 }}
        >
          {market.label}
        </Text>
      </Box>
    </Box>
  )
})

export function StatsBar() {
  const { language, t } = useLanguage()
  const [isDark, setIsDark] = useState(true)
  const tickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const detectTheme = () => {
      const theme = document.documentElement.getAttribute('data-theme')
      setIsDark(theme !== 'light')
    }
    detectTheme()

    const observer = new MutationObserver(detectTheme)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  // Performance: Clone the rendered items via DOM to create the seamless scroll duplicate.
  // This halves the React component count (26 instead of 52) while keeping the visual effect.
  useEffect(() => {
    const ticker = tickerRef.current
    if (!ticker) return

    // Find the source items wrapper (first child)
    const sourceWrapper = ticker.firstElementChild as HTMLElement | null
    if (!sourceWrapper) return

    // Clone the wrapper to create the seamless scroll duplicate
    const clone = sourceWrapper.cloneNode(true) as HTMLElement
    clone.setAttribute('aria-hidden', 'true')
    ticker.appendChild(clone)

    return () => {
      // Clean up cloned node on unmount or re-render
      if (clone.parentNode === ticker) {
        ticker.removeChild(clone)
      }
    }
  }, [isDark, language]) // Re-clone when theme or language changes (since SourceTag content depends on these)

  return (
    <Box
      role="region"
      aria-label={t('dataSourcesLabel')}
      suppressHydrationWarning
      style={{
        marginBottom: 16,
        overflow: 'hidden',
        position: 'relative',
        height: 30, // Fixed height to prevent CLS
        minHeight: 30, // Ensure consistent height
        maskImage: 'linear-gradient(to right, transparent 0%, black 5%, black 95%, transparent 100%)',
        WebkitMaskImage: 'linear-gradient(to right, transparent 0%, black 5%, black 95%, transparent 100%)',
      }}
    >
      <div
        ref={tickerRef}
        className="scroll-ticker"
        style={{
          display: 'flex',
          gap: 0, // Gap is handled inside the wrapper divs
          animation: 'scrollTicker 35s linear infinite',
          animationDelay: '3s', // Delay to prioritize LCP
          width: 'max-content',
          contain: 'layout style', // Performance: isolate layout calculations
        }}
      >
        {/* Render 26 items once - the duplicate set is created via DOM cloning in useEffect */}
        <div style={{ display: 'flex', gap: 10, paddingRight: 10 }}>
          {dataSources.map((source) => (
            <SourceTag key={source.key} source={source} isDark={isDark} t={t} />
          ))}
        </div>
      </div>
    </Box>
  )
}

export default memo(StatsBar)
