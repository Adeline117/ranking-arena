'use client'

import { useEffect, useState, useRef } from 'react'
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
  const scrollRef = useRef<HTMLDivElement>(null)

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

  // Auto-scroll animation
  useEffect(() => {
    const el = scrollRef.current
    if (!el || coins.length === 0) return
    let animId: number
    let pos = 0
    const speed = 0.5 // px per frame

    function tick() {
      pos += speed
      if (pos >= el!.scrollWidth / 2) pos = 0
      el!.scrollLeft = pos
      animId = requestAnimationFrame(tick)
    }
    animId = requestAnimationFrame(tick)

    // Pause on hover
    const pause = () => cancelAnimationFrame(animId)
    const resume = () => { animId = requestAnimationFrame(tick) }
    el.addEventListener('mouseenter', pause)
    el.addEventListener('mouseleave', resume)

    return () => {
      cancelAnimationFrame(animId)
      el.removeEventListener('mouseenter', pause)
      el.removeEventListener('mouseleave', resume)
    }
  }, [coins])

  if (coins.length === 0) return null

  // Duplicate for seamless loop
  const items = [...coins, ...coins]

  return (
    <div
      ref={scrollRef}
      style={{
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        background: tokens.colors.bg.secondary,
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
        padding: '8px 0',
      }}
    >
      <div style={{ display: 'inline-flex', gap: 24 }}>
        {items.map((coin, i) => {
          const color = coin.change24h >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error
          return (
            <span
              key={`${coin.symbol}-${i}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                color: tokens.colors.text.secondary,
              }}
            >
              {coin.image && (
                <img src={coin.image} alt={`${coin.symbol} icon`} width={14} height={14} loading="lazy" style={{ borderRadius: '50%' }} />
              )}
              <span style={{ fontWeight: 600, color: tokens.colors.text.primary }}>{coin.symbol}</span>
              <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{formatPrice(coin.price)}</span>
              <span style={{ color, fontWeight: 600 }}>
                {coin.change24h >= 0 ? '+' : ''}{coin.change24h?.toFixed(2)}%
              </span>
            </span>
          )
        })}
      </div>
    </div>
  )
}
