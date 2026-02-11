'use client'

import { useState } from 'react'
import { Box } from '@/app/components/base'
import Image from 'next/image'
import type { Exchange } from '@/lib/exchange'
import { tokens } from '@/lib/design-tokens'

interface ExchangeLogoProps {
  exchange: Exchange
  size?: number
  className?: string
}

// 交易所logo URL（使用CDN或官方logo）
// Exchange logos: use CoinGecko /markets/ endpoints (more stable than /coins/)
// with CoinMarketCap fallbacks for exchanges where CoinGecko returns 403
// Use CoinGecko asset platform images (more reliable than favicons which often 403)
// Fallback chain: CoinGecko → CoinMarketCap → SVG fallback
const EXCHANGE_LOGOS: Record<string, string> = {
  binance: 'https://assets.coingecko.com/markets/images/52/small/binance.jpg',
  bybit: 'https://assets.coingecko.com/markets/images/698/small/bybit_spot.png',
  bitget: 'https://assets.coingecko.com/markets/images/540/small/bitget.png',
  mexc: 'https://assets.coingecko.com/markets/images/409/small/MEXC_logo_square.jpeg',
  htx: 'https://assets.coingecko.com/markets/images/25/small/logo_V_colour_black.png',
  weex: 'https://assets.coingecko.com/markets/images/1013/small/weex.png',
  coinex: 'https://assets.coingecko.com/markets/images/135/small/coinex.jpg',
  okx: 'https://assets.coingecko.com/markets/images/96/small/WeChat_Image_20220117220452.png',
  kucoin: 'https://assets.coingecko.com/markets/images/61/small/kucoin.png',
  gate: 'https://assets.coingecko.com/markets/images/60/small/gate_io_logo1.jpg',
  bingx: 'https://assets.coingecko.com/markets/images/812/small/BingX_brand_logo.png',
  phemex: 'https://assets.coingecko.com/markets/images/380/small/phemex.png',
  hyperliquid: 'https://assets.coingecko.com/markets/images/1242/small/hyperliquid.jpeg',
  gmx: 'https://assets.coingecko.com/markets/images/929/small/gmx.png',
  dydx: 'https://assets.coingecko.com/markets/images/580/small/dydx.jpg',
  jupiter: 'https://assets.coingecko.com/markets/images/1093/small/jup.png',
  drift: 'https://assets.coingecko.com/markets/images/1061/small/drift.jpeg',
  aevo: 'https://assets.coingecko.com/markets/images/1083/small/aevo.jpeg',
  vertex: 'https://assets.coingecko.com/markets/images/958/small/vertex.jpeg',
  toobit: 'https://assets.coingecko.com/markets/images/1040/small/toobit.jpeg',
  btse: 'https://assets.coingecko.com/markets/images/464/small/btse.png',
  cryptocom: 'https://assets.coingecko.com/markets/images/589/small/crypto_com.jpg',
  bitfinex: 'https://assets.coingecko.com/markets/images/4/small/BFX_Logo.png',
  whitebit: 'https://assets.coingecko.com/markets/images/474/small/whitebit.png',
  lbank: 'https://assets.coingecko.com/markets/images/143/small/lbank.png',
  pionex: 'https://assets.coingecko.com/markets/images/566/small/Pionex_logo.png',
  blofin: 'https://assets.coingecko.com/markets/images/1063/small/blofin.jpeg',
  xt: 'https://assets.coingecko.com/markets/images/404/small/logo400x400.png',
  uniswap: 'https://assets.coingecko.com/markets/images/535/small/256x256_Black-1.png',
  pancakeswap: 'https://assets.coingecko.com/markets/images/687/small/pancakeswap.jpeg',
  kwenta: 'https://assets.coingecko.com/markets/images/1006/small/kwenta.jpeg',
  synthetix: 'https://assets.coingecko.com/coins/images/3406/small/SNX.png',
  mux: 'https://assets.coingecko.com/markets/images/995/small/mux.jpeg',
  gains: 'https://assets.coingecko.com/markets/images/957/small/gains.jpeg',
}

// 如果CDN不可用，使用SVG fallback
const EXCHANGE_SVG: Record<string, string> = {
  binance: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="24" height="24" rx="4" fill="var(--color-chart-amber)"/>
    <path d="M12 2L7.5 6.5L9 8L12 5L15 8L16.5 6.5L12 2Z" fill="white"/>
    <path d="M5 7.5L6.5 9L9 6.5L7.5 5L5 7.5Z" fill="white"/>
    <path d="M2 12L6.5 7.5L8 9L5 12L8 15L6.5 16.5L2 12Z" fill="white"/>
    <path d="M12 5L15 8L16.5 6.5L12 2L7.5 6.5L9 8L12 5Z" fill="white"/>
    <path d="M19 7.5L20.5 9L18 11.5L16.5 10L19 7.5Z" fill="white"/>
    <path d="M22 12L17.5 16.5L16 15L19 12L16 9L17.5 7.5L22 12Z" fill="white"/>
    <path d="M12 19L9 16L7.5 17.5L12 22L16.5 17.5L15 16L12 19Z" fill="white"/>
    <path d="M5 16.5L6.5 15L9 17.5L7.5 19L5 16.5Z" fill="white"/>
    <path d="M12 19L15 16L16.5 17.5L12 22L7.5 17.5L9 16L12 19Z" fill="white"/>
  </svg>`,
  bybit: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="24" height="24" rx="4" fill="var(--color-chart-orange)"/>
    <path d="M12 4L4 8V16L12 20L20 16V8L12 4Z" stroke="white" stroke-width="2" fill="none"/>
    <path d="M12 4V12M12 12L20 8M12 12L4 8" stroke="white" stroke-width="2"/>
  </svg>`,
  bitget: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="24" height="24" rx="4" fill="var(--color-chart-teal)"/>
    <circle cx="12" cy="12" r="6" fill="white"/>
    <path d="M12 6L14 10H18L15 13L17 17L12 14L7 17L9 13L6 10H10L12 6Z" fill="var(--color-chart-teal)"/>
  </svg>`,
  mexc: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="24" height="24" rx="4" fill="var(--color-chart-blue)"/>
    <path d="M12 2L2 7V17L12 22L22 17V7L12 2Z" fill="white"/>
    <path d="M12 6L8 8V16L12 18L16 16V8L12 6Z" fill="var(--color-chart-blue)"/>
  </svg>`,
  htx: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="24" height="24" rx="4" fill="var(--color-chart-indigo)"/>
    <path d="M12 4C8.5 7 7 10.5 7 13.5C7 17 9.2 20 12 20C14.8 20 17 17 17 13.5C17 10.5 15.5 7 12 4Z" fill="white"/>
    <circle cx="12" cy="14" r="2.5" fill="var(--color-chart-indigo)"/>
  </svg>`,
  weex: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="24" height="24" rx="4" fill="var(--color-accent-success)"/>
    <path d="M4 8L8 16L12 10L16 16L20 8" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </svg>`,
  coinex: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="24" height="24" rx="4" fill="var(--color-chart-violet)"/>
    <circle cx="12" cy="12" r="8" fill="white"/>
    <path d="M12 4L16 8H12V12H8L12 16V12H16L12 8V4Z" fill="var(--color-chart-violet)"/>
  </svg>`,
  okx: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="24" height="24" rx="4" fill="var(--color-text-primary)"/>
    <circle cx="12" cy="12" r="6" stroke="white" stroke-width="2" fill="none"/>
  </svg>`,
  kucoin: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="24" height="24" rx="4" fill="var(--color-chart-teal)"/>
    <path d="M12 4L18 8V16L12 20L6 16V8L12 4Z" fill="white"/>
  </svg>`,
  gate: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="24" height="24" rx="4" fill="var(--color-chart-indigo)"/>
    <circle cx="12" cy="12" r="6" fill="white"/>
  </svg>`,
}

export default function ExchangeLogo({ exchange, size = 24, className }: ExchangeLogoProps) {
  const logoUrl = EXCHANGE_LOGOS[exchange]
  const [useFallback, setUseFallback] = useState(false)
  
  if (logoUrl && !useFallback) {
    return (
      <Box
        style={{
          width: size,
          height: size,
          position: 'relative',
          flexShrink: 0,
        }}
        className={className}
      >
        <Image
          src={logoUrl}
          alt={`${exchange} logo`}
          width={size}
          height={size}
          sizes={`${size}px`}
          unoptimized={true} // 禁用 Next.js 图片优化以避免私有IP解析警告
          style={{
            objectFit: 'contain',
            borderRadius: tokens.radius.sm,
          }}
          onError={() => {
            // 如果图片加载失败，使用SVG fallback
            setUseFallback(true)
          }}
        />
      </Box>
    )
  }

  // SVG fallback
  return (
    <Box
      style={{
        width: size,
        height: size,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      className={className}
      dangerouslySetInnerHTML={{ __html: EXCHANGE_SVG[exchange] || '' }}
    />
  )
}

