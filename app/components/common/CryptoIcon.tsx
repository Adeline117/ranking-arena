'use client'

import { useState } from 'react'
import { normalizeCoinSymbol, getSymbolLabel } from '@/lib/utils/crypto-icons'

const ICON_BASE_PATH = '/icons/crypto'
// Version suffix busts CDN-cached 404s that arose from files being added
// after the initial cache warm-up (stale immutable 404s last up to 1 year).
const ICON_VERSION = 'v5'

// CoinCap CDN uses symbol-based URLs
function getCdnUrl(symbol: string): string {
  const normalized = normalizeCoinSymbol(symbol)
  return `https://assets.coincap.io/assets/icons/${normalized}@2x.png`
}

interface CryptoIconProps {
  symbol: string
  size?: number
  style?: React.CSSProperties
  className?: string
}

/**
 * Renders a cryptocurrency icon for the given symbol.
 * Tries: 1) local SVG, 2) CoinCap CDN, 3) styled text fallback (1-2 letter initials).
 *
 * Handles Hyperliquid exotic/RWA markets with xyz: prefix (e.g. xyz:tsla, xyz:nvda).
 * These strip to their base symbol for icon lookups and text fallback.
 */
export default function CryptoIcon({ symbol, size = 20, style, className }: CryptoIconProps) {
  const [fallbackLevel, setFallbackLevel] = useState(0)
  const normalized = normalizeCoinSymbol(symbol)
  const label = getSymbolLabel(symbol)

  // Level 0: local SVG
  // Level 1: CoinCap CDN PNG
  // Level 2: styled text fallback (no more img)
  if (fallbackLevel >= 2) {
    return (
      <span
        aria-label={label}
        className={className}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: size,
          height: size,
          borderRadius: '50%',
          backgroundColor: 'var(--color-bg-tertiary, #2a2a3a)',
          color: 'var(--color-text-tertiary, #9ca3af)',
          fontSize: Math.max(8, Math.round(size * 0.38)),
          fontWeight: 600,
          fontFamily: 'ui-monospace, monospace',
          flexShrink: 0,
          userSelect: 'none',
          ...style,
        }}
      >
        {label}
      </span>
    )
  }

  const src = fallbackLevel === 0
    ? `${ICON_BASE_PATH}/${normalized}.svg?${ICON_VERSION}`
    : getCdnUrl(symbol)

  return (
    <img
      src={src}
      alt={normalized.toUpperCase()}
      width={size}
      height={size}
      loading="lazy"
      className={className}
      onError={() => setFallbackLevel(prev => prev + 1)}
      style={{
        borderRadius: '50%',
        flexShrink: 0,
        ...style,
      }}
    />
  )
}
