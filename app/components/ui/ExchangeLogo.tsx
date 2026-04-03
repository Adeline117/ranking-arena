'use client'

import { useState } from 'react'
import { Box } from '@/app/components/base'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'

interface ExchangeLogoProps {
  exchange: string
  size?: number
  className?: string
}

// Local logo files in /public/icons/exchanges/
// All logos downloaded locally for reliability (CoinGecko CDN often 403s)
const LOCAL_LOGOS: Record<string, string> = {
  binance: '/icons/exchanges/binance.jpg',
  bybit: '/icons/exchanges/bybit.png',
  bitget: '/icons/exchanges/bitget.png',
  mexc: '/icons/exchanges/mexc.jpeg',
  htx: '/icons/exchanges/htx.png',
  weex: '/icons/exchanges/weex.png',
  coinex: '/icons/exchanges/coinex.jpg',
  okx: '/icons/exchanges/okx.svg',
  kucoin: '/icons/exchanges/kucoin.png',
  gate: '/icons/exchanges/gate.jpg',
  bingx: '/icons/exchanges/bingx.png',
  phemex: '/icons/exchanges/phemex.svg',
  hyperliquid: '/icons/exchanges/hyperliquid.png',
  gmx: '/icons/exchanges/gmx.svg',
  dydx: '/icons/exchanges/dydx.png',
  jupiter: '/icons/exchanges/jupiter.png',
  drift: '/icons/exchanges/drift.png',
  aevo: '/icons/exchanges/aevo.png',
  vertex: '/icons/exchanges/vertex.png',
  toobit: '/icons/exchanges/toobit.png',
  btse: '/icons/exchanges/btse.png',
  cryptocom: '/icons/exchanges/cryptocom.jpg',
  bitfinex: '/icons/exchanges/bitfinex.png',
  whitebit: '/icons/exchanges/whitebit.png',
  lbank: '/icons/exchanges/lbank.png',
  pionex: '/icons/exchanges/pionex.png',
  blofin: '/icons/exchanges/blofin.png',
  xt: '/icons/exchanges/xt.png',
  uniswap: '/icons/exchanges/uniswap.png',
  pancakeswap: '/icons/exchanges/pancakeswap.jpeg',
  kwenta: '/icons/exchanges/kwenta.png',
  synthetix: '/icons/exchanges/synthetix.png',
  mux: '/icons/exchanges/mux.png',
  gains: '/icons/exchanges/gains.svg',
  btcc: '/icons/exchanges/btcc.png',
  bitunix: '/icons/exchanges/bitunix.png',
  bitmart: '/icons/exchanges/bitmart.png',
  etoro: '/icons/exchanges/etoro.svg',
  woox: '/icons/exchanges/woox.svg',
  polymarket: '/icons/exchanges/polymarket.svg',
  copin: '/icons/exchanges/copin.svg',
  // Aliases for DB source names (e.g. "binance_futures" -> binance logo)
  binance_futures: '/icons/exchanges/binance.jpg',
  binance_spot: '/icons/exchanges/binance.jpg',
  binance_web3: '/icons/exchanges/binance.jpg',
  bybit_spot: '/icons/exchanges/bybit.png',
  bitget_futures: '/icons/exchanges/bitget.png',
  bitget_spot: '/icons/exchanges/bitget.png',
  okx_futures: '/icons/exchanges/okx.svg',
  okx_spot: '/icons/exchanges/okx.svg',
  okx_web3: '/icons/exchanges/okx.svg',
  okx_wallet: '/icons/exchanges/okx.svg',
  htx_futures: '/icons/exchanges/htx.png',
  gateio: '/icons/exchanges/gate.jpg',
  jupiter_perps: '/icons/exchanges/jupiter.png',
  dune_gmx: '/icons/exchanges/gmx.svg',
  dune_hyperliquid: '/icons/exchanges/hyperliquid.png',
  dune_uniswap: '/icons/exchanges/uniswap.png',
  dune_defi: '/icons/exchanges/uniswap.png',
  web3_bot: '/icons/exchanges/hyperliquid.png',
  bingx_spot: '/icons/exchanges/bingx.png',
  paradex: '/icons/exchanges/dydx.png',
}

// CoinGecko CDN fallback URLs
const CDN_FALLBACK: Record<string, string> = {
  binance: 'https://assets.coingecko.com/markets/images/52/small/binance.jpg',
  bybit: 'https://assets.coingecko.com/markets/images/698/small/bybit_spot.png',
  mexc: 'https://assets.coingecko.com/markets/images/409/small/MEXC_logo_square.jpeg',
  htx: 'https://assets.coingecko.com/markets/images/25/small/logo_V_colour_black.png',
  coinex: 'https://assets.coingecko.com/markets/images/135/small/coinex.jpg',
  okx: 'https://assets.coingecko.com/markets/images/96/small/WeChat_Image_20220117220452.png',
  kucoin: 'https://assets.coingecko.com/markets/images/61/small/kucoin.png',
  gate: 'https://assets.coingecko.com/markets/images/60/small/gate_io_logo1.jpg',
  cryptocom: 'https://assets.coingecko.com/markets/images/589/small/crypto_com.jpg',
}

// React SVG fallback components for when both local and CDN fail
function BinanceSvg({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width={size} height={size}>
      <rect width="24" height="24" rx="4" fill="var(--color-chart-amber)" />
      <path d="M12 2L7.5 6.5L9 8L12 5L15 8L16.5 6.5L12 2Z" fill="white" />
      <path d="M2 12L6.5 7.5L8 9L5 12L8 15L6.5 16.5L2 12Z" fill="white" />
      <path d="M22 12L17.5 16.5L16 15L19 12L16 9L17.5 7.5L22 12Z" fill="white" />
      <path d="M12 19L9 16L7.5 17.5L12 22L16.5 17.5L15 16L12 19Z" fill="white" />
    </svg>
  )
}

const EXCHANGE_SVG_COMPONENTS: Record<string, React.FC<{ size: number }>> = {
  binance: BinanceSvg,
}

export default function ExchangeLogo({ exchange, size = 24, className }: ExchangeLogoProps) {
  const [fallbackLevel, setFallbackLevel] = useState(0)
  // 0 = local, 1 = CDN, 2 = SVG

  const localUrl = LOCAL_LOGOS[exchange]
  const cdnUrl = CDN_FALLBACK[exchange]

  const currentUrl = fallbackLevel === 0 ? localUrl : fallbackLevel === 1 ? cdnUrl : null

  if (currentUrl) {
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
          src={currentUrl}
          alt={`${exchange} logo`}
          width={size}
          height={size}
          sizes={`${size}px`}
          style={{
            objectFit: 'contain',
            borderRadius: tokens.radius.sm,
          }}
          onError={() => {
            if (fallbackLevel === 0 && cdnUrl) {
              setFallbackLevel(1)
            } else {
              setFallbackLevel(2)
            }
          }}
        />
      </Box>
    )
  }

  // SVG fallback
  const SvgComponent = EXCHANGE_SVG_COMPONENTS[exchange]
  if (SvgComponent) {
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
      >
        <SvgComponent size={size} />
      </Box>
    )
  }

  // Generic fallback - first letter
  return (
    <Box
      style={{
        width: size,
        height: size,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: tokens.radius.sm,
        background: 'var(--color-bg-tertiary)',
        color: 'var(--color-text-secondary)',
        fontSize: size * 0.5,
        fontWeight: 700,
        flexShrink: 0,
      }}
      className={className}
    >
      {exchange.charAt(0).toUpperCase()}
    </Box>
  )
}
