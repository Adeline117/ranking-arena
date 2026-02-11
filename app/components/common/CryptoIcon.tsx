'use client'

import { useState } from 'react'
import { normalizeCoinSymbol } from '@/lib/utils/crypto-icons'

const ICON_BASE_PATH = '/icons/crypto'

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
 * Tries: 1) local SVG, 2) CoinCap CDN, 3) generic fallback.
 */
export default function CryptoIcon({ symbol, size = 20, style, className }: CryptoIconProps) {
  const [fallbackLevel, setFallbackLevel] = useState(0)
  const normalized = normalizeCoinSymbol(symbol)

  const src = fallbackLevel === 0
    ? `${ICON_BASE_PATH}/${normalized}.svg`
    : fallbackLevel === 1
      ? getCdnUrl(symbol)
      : `${ICON_BASE_PATH}/generic.svg`

  return (
    <img
      src={src}
      alt={normalized.toUpperCase()}
      width={size}
      height={size}
      loading="lazy"
      className={className}
      onError={() => {
        if (fallbackLevel < 2) setFallbackLevel(prev => prev + 1)
      }}
      style={{
        borderRadius: '50%',
        flexShrink: 0,
        ...style,
      }}
    />
  )
}
