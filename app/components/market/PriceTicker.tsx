'use client'

import { useEffect, useState } from 'react'
// Use plain <img> for crypto icons (SVGs cause 400 on Vercel image optimizer)
import { tokens } from '@/lib/design-tokens'

interface TickerCoin {
  symbol: string
  price: number
  change24h: number
  image: string
}

function formatPrice(n: number): string {
  if (n >= 1) return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return `$${n.toPrecision(4)}`
}

const ICON_VERSION = 'v5'

function getCryptoIcon(symbol: string, fallbackImage: string): string {
  const localPath = `/icons/crypto/${symbol.toLowerCase()}.svg?${ICON_VERSION}`
  return localPath || fallbackImage
}

export default function PriceTicker() {
  const [coins, setCoins] = useState<TickerCoin[]>([])
  const [imgErrors, setImgErrors] = useState<Set<string>>(new Set())

  useEffect(() => {
    let alive = true

    const load = () => {
      fetch('/api/market/spot')
        .then(r => r.json())
        .then(data => {
          if (!alive || !Array.isArray(data)) return
          setCoins(data.slice(0, 20).map((c: Record<string, unknown>) => ({
            symbol: c.symbol as string,
            price: c.price as number,
            change24h: c.change24h as number,
            image: c.image as string,
          })))
        })
        .catch(() => {})
    }

    load()
    const interval = setInterval(load, 30000)

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      alive = false
      clearInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [])

  if (coins.length === 0) return <div style={{ height: 48 }} />

  const doubled = [...coins, ...coins]

  return (
    <div
      className="price-ticker-container"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 100,
        overflow: 'hidden',
        height: 48,
        display: 'flex',
        alignItems: 'center',
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
        background: tokens.colors.bg.secondary,
      }}
    >
      {/* Fade edges */}
      <div style={{
        position: 'absolute', left: 0, top: 0, bottom: 0, width: 40,
        background: `linear-gradient(to right, ${tokens.colors.bg.secondary}, transparent)`,
        zIndex: 1, pointerEvents: 'none',
      }} />
      <div style={{
        position: 'absolute', right: 0, top: 0, bottom: 0, width: 40,
        background: `linear-gradient(to left, ${tokens.colors.bg.secondary}, transparent)`,
        zIndex: 1, pointerEvents: 'none',
      }} />

      <div className="price-ticker-track" style={{
        display: 'flex',
        alignItems: 'center',
        gap: 28,
        animation: 'price-ticker-scroll 45s linear infinite',
        willChange: 'transform',
        width: 'max-content',
      }}>
        {doubled.map((coin, i) => {
          const color = coin.change24h >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error
          const localIcon = getCryptoIcon(coin.symbol, coin.image)
          const useLocal = !imgErrors.has(coin.symbol)
          const imgSrc = useLocal ? localIcon : coin.image

          return (
            <span
              key={`${coin.symbol}-${i}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 13,
                flexShrink: 0,
                whiteSpace: 'nowrap',
              }}
            >
              {imgSrc && (
                <img
                  src={imgSrc}
                  alt={coin.symbol}
                  width={18}
                  height={18}
                  loading="lazy"
                  style={{ borderRadius: '50%', flexShrink: 0 }}
                  onError={() => {
                    if (useLocal) {
                      setImgErrors(prev => new Set(prev).add(coin.symbol))
                    }
                  }}
                />
              )}
              <span style={{ fontWeight: 600, color: tokens.colors.text.primary }}>{coin.symbol}</span>
              <span style={{
                fontFamily: tokens.typography.fontFamily.mono.join(','),
                color: tokens.colors.text.secondary,
                fontVariantNumeric: 'tabular-nums',
                letterSpacing: '-0.3px',
              } as React.CSSProperties}>
                {formatPrice(coin.price)}
              </span>
              <span style={{
                color,
                fontWeight: 600,
                fontSize: 12,
                fontFamily: tokens.typography.fontFamily.mono.join(','),
                fontVariantNumeric: 'tabular-nums',
                padding: '1px 4px',
                borderRadius: 3,
                background: coin.change24h >= 0
                  ? 'var(--color-accent-success-05)'
                  : 'var(--color-accent-error-04)',
              } as React.CSSProperties}>
                {coin.change24h >= 0 ? '+' : ''}{coin.change24h?.toFixed(2)}%
              </span>
            </span>
          )
        })}
      </div>

      <style>{`
        @keyframes price-ticker-scroll {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        .price-ticker-container:hover .price-ticker-track {
          animation-play-state: paused;
        }
      `}</style>
    </div>
  )
}
