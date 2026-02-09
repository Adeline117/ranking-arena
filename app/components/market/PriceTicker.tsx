'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
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

export default function PriceTicker() {
  const [coins, setCoins] = useState<TickerCoin[]>([])

  useEffect(() => {
    fetch('/api/market/spot')
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) {
          setCoins(data.slice(0, 20).map((c: Record<string, unknown>) => ({
            symbol: c.symbol as string,
            price: c.price as number,
            change24h: c.change24h as number,
            image: c.image as string,
          })))
        }
      })
      .catch(() => {})
  }, [])

  if (coins.length === 0) return null

  const doubled = [...coins, ...coins]

  return (
    <div style={{
      overflow: 'hidden',
      padding: '10px 0',
      borderBottom: `1px solid ${tokens.colors.border.primary}`,
      position: 'relative',
      background: tokens.colors.bg.secondary,
    }}>
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

      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 28,
        animation: 'price-ticker-scroll 40s linear infinite',
        willChange: 'transform',
        width: 'max-content',
      }}>
        {doubled.map((coin, i) => {
          const color = coin.change24h >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error
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
              {coin.image && (
                <Image
                  src={coin.image}
                  alt={coin.symbol}
                  width={18}
                  height={18}
                  style={{ borderRadius: '50%', flexShrink: 0 }}
                />
              )}
              <span style={{ fontWeight: 600, color: tokens.colors.text.primary }}>{coin.symbol}</span>
              <span style={{
                fontFamily: tokens.typography.fontFamily.mono.join(','),
                color: tokens.colors.text.secondary,
              }}>
                {formatPrice(coin.price)}
              </span>
              <span style={{ color, fontWeight: 600, fontSize: 12 }}>
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
        @media (hover: hover) {
          div:has(> [style*="price-ticker-scroll"]):hover [style*="price-ticker-scroll"] {
            animation-play-state: paused;
          }
        }
      `}</style>
    </div>
  )
}
