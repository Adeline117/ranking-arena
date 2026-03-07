'use client'

/**
 * Copy Trade Link Button
 * Generates a referral link to the exchange's copy trading page.
 */

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface CopyTradeLinkProps {
  source: string
  sourceTraderld: string
}

const EXCHANGE_COPY_URLS: Record<string, (id: string) => string> = {
  binance_futures: (id) => `https://www.binance.com/en/copy-trading/lead-details/${id}`,
  binance_spot: (id) => `https://www.binance.com/en/copy-trading/lead-details/${id}`,
  bybit: (id) => `https://www.bybit.com/copyTrade/trade-center/detail?leaderMark=${id}`,
  bitget: (id) => `https://www.bitget.com/copy-trading/trader/${id}`,
  okx: (id) => `https://www.okx.com/copy-trading/account/${id}`,
  mexc: (id) => `https://futures.mexc.com/exchange/copy-trading/trader/${id}`,
  gate: (id) => `https://www.gate.io/copy_trading/${id}`,
  bingx: (id) => `https://bingx.com/en/copy-trading/${id}`,
}

const EXCHANGE_DISPLAY: Record<string, string> = {
  binance_futures: 'Binance',
  binance_spot: 'Binance',
  bybit: 'Bybit',
  bitget: 'Bitget',
  okx: 'OKX',
  mexc: 'MEXC',
  gate: 'Gate.io',
  bingx: 'BingX',
}

export default function CopyTradeLink({ source, sourceTraderld }: CopyTradeLinkProps) {
  const { t } = useLanguage()

  const urlFn = EXCHANGE_COPY_URLS[source]
  if (!urlFn) return null

  const url = urlFn(sourceTraderld)
  const exchangeName = EXCHANGE_DISPLAY[source] || source

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: `${tokens.spacing[2]} ${tokens.spacing[5]}`,
        borderRadius: tokens.radius.lg,
        background: 'linear-gradient(135deg, var(--color-brand) 0%, var(--color-brand-deep) 100%)',
        color: tokens.colors.white,
        fontSize: tokens.typography.fontSize.sm,
        fontWeight: 700,
        textDecoration: 'none',
        transition: `all ${tokens.transition.base}`,
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
      </svg>
      {t('copyTradeOnExchange').replace('{exchange}', exchangeName)}
    </a>
  )
}
