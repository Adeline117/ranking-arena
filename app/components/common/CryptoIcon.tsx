'use client'

import { useState } from 'react'
import { getCryptoIconPath, getGenericIconPath, normalizeCoinSymbol } from '@/lib/utils/crypto-icons'

interface CryptoIconProps {
  symbol: string
  size?: number
  style?: React.CSSProperties
  className?: string
}

/**
 * Renders a cryptocurrency icon for the given symbol.
 * Falls back to generic icon if the specific icon fails to load.
 */
export default function CryptoIcon({ symbol, size = 20, style, className }: CryptoIconProps) {
  const [hasError, setHasError] = useState(false)
  const src = hasError ? getGenericIconPath() : getCryptoIconPath(symbol)
  const alt = normalizeCoinSymbol(symbol).toUpperCase()

  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      loading="lazy"
      className={className}
      onError={() => {
        if (!hasError) setHasError(true)
      }}
      style={{
        borderRadius: '50%',
        flexShrink: 0,
        ...style,
      }}
    />
  )
}
