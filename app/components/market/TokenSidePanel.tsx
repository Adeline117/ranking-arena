'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
// CSS animations replace framer-motion (~40KB bundle savings)
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import dynamic from 'next/dynamic'
import type { OHLCVDataPoint } from '@/app/components/charts/TradingViewChart'
import type { Time } from 'lightweight-charts'

const TradingViewChart = dynamic(
  () => import('@/app/components/charts/TradingViewChart'),
  { ssr: false }
)

interface TokenInfo {
  id: string
  symbol: string
  name: string
  image: string
  price: number
  change24h: number
  marketCap: number
  volume24h: number
  high24h: number
  low24h: number
  rank: number
}

interface CoinDetail {
  market_data: {
    circulating_supply: number | null
    total_supply: number | null
    max_supply: number | null
    ath: { usd: number }
    ath_date: { usd: string }
    ath_change_percentage: { usd: number }
    atl: { usd: number }
    atl_date: { usd: string }
    fully_diluted_valuation: { usd: number | null }
    price_change_percentage_1h_in_currency: { usd: number | null }
    price_change_percentage_24h: number | null
    price_change_percentage_7d: number | null
    price_change_percentage_30d: number | null
  }
  links: {
    homepage: string[]
    blockchain_site: string[]
  }
}

const PERIODS = [
  { label: '1D', days: '1' },
  { label: '7D', days: '7' },
  { label: '30D', days: '30' },
  { label: '90D', days: '90' },
  { label: '1Y', days: '365' },
] as const

function formatNum(n: number | null | undefined): string {
  if (n == null) return '--'
  if (Math.abs(n) >= 1e12) return `$${(n / 1e12).toFixed(2)}T`
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(2)}K`
  return `$${n.toFixed(2)}`
}

function formatSupply(n: number | null | undefined): string {
  if (n == null) return '--'
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(2)}K`
  return n.toLocaleString('en-US')
}

function formatPrice(n: number): string {
  if (n >= 1) return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return `$${n.toPrecision(4)}`
}

// Use formatDateLocalized from shared utils instead of this local function.
// Kept as wrapper for backward compatibility within this file.
function formatDate(iso: string, locale = 'en'): string {
  return new Date(iso).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      padding: '7px 0',
      borderBottom: `1px solid ${tokens.colors.border.primary}`,
      fontSize: 13,
    }}>
      <span style={{ color: tokens.colors.text.tertiary }}>{label}</span>
      <span style={{ color: tokens.colors.text.primary, fontWeight: 500 }}>{value}</span>
    </div>
  )
}

function PriceChangeBar({ label, value }: { label: string; value: number | null | undefined }) {
  if (value == null) return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '4px 0' }}>
      <span style={{ color: tokens.colors.text.tertiary, width: 32, flexShrink: 0 }}>{label}</span>
      <span style={{ color: tokens.colors.text.tertiary }}>--</span>
    </div>
  )
  const isPositive = value >= 0
  const color = isPositive ? tokens.colors.accent.success : tokens.colors.accent.error
  const barWidth = Math.min(Math.abs(value), 100)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '4px 0' }}>
      <span style={{ color: tokens.colors.text.tertiary, width: 32, flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, height: 6, background: tokens.colors.bg.tertiary, borderRadius: tokens.radius.sm, overflow: 'hidden' }}>
        <div style={{
          width: `${barWidth}%`,
          height: '100%',
          background: color,
          borderRadius: tokens.radius.sm,
          transition: 'width 0.3s ease',
        }} />
      </div>
      <span style={{ color, fontWeight: 500, minWidth: 52, textAlign: 'right', fontFamily: 'var(--font-mono, monospace)' }}>
        {isPositive ? '+' : ''}{value.toFixed(2)}%
      </span>
    </div>
  )
}

export default function TokenSidePanel({ token, onClose }: {
  token: TokenInfo | null
  onClose: () => void
}) {
  const { t, language } = useLanguage()
  const panelRef = useRef<HTMLDivElement>(null)
  const [coinDetail, setCoinDetail] = useState<CoinDetail | null>(null)
  const [ohlcData, setOhlcData] = useState<OHLCVDataPoint[]>([])
  const [selectedPeriod, setSelectedPeriod] = useState('30')
  const [chartLoading, setChartLoading] = useState(false)
  const [chartTheme, setChartTheme] = useState<'dark' | 'light'>('dark')

  useEffect(() => {
    const getTheme = () => (document.documentElement.getAttribute('data-theme') as 'dark' | 'light') || 'dark'
    setChartTheme(getTheme())
    const observer = new MutationObserver(() => setChartTheme(getTheme()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // Scroll lock when panel is open
  useEffect(() => {
    if (token) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [token])

  // Fetch coin detail
  useEffect(() => {
    if (!token) return
    setCoinDetail(null)
    fetch(`/api/market/coin/${token.id}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setCoinDetail(d))
      .catch(err => console.warn('[TokenSidePanel] fetch failed', err))
  // eslint-disable-next-line react-hooks/exhaustive-deps -- token.id is sufficient
  }, [token?.id])

  // Fetch OHLC data
  const fetchOhlc = useCallback(async (id: string, days: string) => {
    setChartLoading(true)
    try {
      const r = await fetch(`/api/market/ohlc/${id}?days=${days}`)
      if (!r.ok) return
      const raw: number[][] = await r.json()
      const data: OHLCVDataPoint[] = raw.map(([ts, o, h, l, c]) => ({
        time: (ts / 1000) as Time,
        open: o,
        high: h,
        low: l,
        close: c,
      }))
      setOhlcData(data)
    } catch {
      // Chart data fetch failed; panel still shows token info without chart
    } finally {
      setChartLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!token) return
    fetchOhlc(token.id, selectedPeriod)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- token.id is sufficient
  }, [token?.id, selectedPeriod, fetchOhlc])

  const md = coinDetail?.market_data

  return (
    <>
      {token && (
        <>
          <div
            onClick={onClose}
            aria-label="Close panel"
            style={{
              position: 'fixed',
              inset: 0,
              background: 'var(--color-backdrop-light)',
              zIndex: tokens.zIndex.overlay,
              animation: 'fadeIn 0.2s ease-out',
            }}
          />
          <div style={{
            position: 'fixed',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: tokens.zIndex.overlay + 1,
            pointerEvents: 'none',
          }}>
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={`${token.symbol} token details`}
            style={{
              animation: 'fadeInScale 0.2s ease-out',
              width: 'min(95vw, 900px)',
              maxHeight: '90vh',
              background: tokens.colors.bg.primary,
              border: `1px solid ${tokens.colors.border.primary}`,
              borderRadius: tokens.radius.xl,
              overflowY: 'auto',
              padding: 'clamp(16px, 4vw, 28px)',
              pointerEvents: 'auto',
            }}
          >
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {token.image ? (
                  <Image
                    src={token.image}
                    alt={`${token.symbol} icon`}
                    width={36}
                    height={36}
                    style={{ borderRadius: '50%' }}
                    unoptimized
                  />
                ) : (
                  <span style={{ width: 36, height: 36, borderRadius: '50%', background: tokens.colors.bg.tertiary, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 14, color: tokens.colors.text.secondary }}>
                    {token.symbol.charAt(0)}
                  </span>
                )}
                <div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: tokens.colors.text.primary }}>
                    {token.symbol}
                  </div>
                  <div style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>{token.name}</div>
                </div>
                <span style={{
                  fontSize: 11,
                  color: tokens.colors.text.tertiary,
                  background: tokens.colors.bg.tertiary,
                  padding: '2px 8px',
                  borderRadius: tokens.radius.sm,
                  marginLeft: 4,
                }}>
                  #{token.rank}
                </span>
              </div>
              <button
                onClick={onClose}
                aria-label="Close panel"
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  width: 44,
                  height: 44,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: tokens.colors.text.tertiary,
                  borderRadius: tokens.radius.md,
                }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Price */}
            <div style={{ marginBottom: 16 }}>
              <div style={{
                fontSize: 28,
                fontWeight: 700,
                color: tokens.colors.text.primary,
                fontFamily: 'var(--font-mono, monospace)',
              }}>
                {formatPrice(token.price)}
              </div>
              <span style={{
                fontSize: 14,
                fontWeight: 600,
                color: token.change24h >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
              }}>
                {token.change24h >= 0 ? '+' : ''}{token.change24h.toFixed(2)}% (24h)
              </span>
            </div>

            {/* Chart */}
            <div style={{
              marginBottom: 20,
              border: `1px solid ${tokens.colors.border.primary}`,
              borderRadius: tokens.radius.lg,
              overflow: 'hidden',
            }}>
              {/* Period selector */}
              <div style={{
                display: 'flex',
                gap: 4,
                padding: '8px 12px',
                borderBottom: `1px solid ${tokens.colors.border.primary}`,
              }}>
                {PERIODS.map(p => (
                  <button
                    key={p.days}
                    onClick={() => setSelectedPeriod(p.days)}
                    style={{
                      background: selectedPeriod === p.days ? tokens.colors.accent.primary : 'transparent',
                      color: selectedPeriod === p.days ? tokens.colors.white : tokens.colors.text.tertiary,
                      border: 'none',
                      borderRadius: tokens.radius.sm,
                      padding: '4px 10px',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                      transition: tokens.transition.fast,
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div style={{ position: 'relative', minHeight: 280 }}>
                {chartLoading && (
                  <div style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    zIndex: 2,
                    color: tokens.colors.text.tertiary,
                    fontSize: 13,
                  }}>
                    {t('loading')}
                  </div>
                )}
                {ohlcData.length > 0 && (
                  <TradingViewChart
                    data={ohlcData}
                    type="candlestick"
                    height={280}
                    theme={chartTheme}
                    locale={language === 'zh' ? 'zh' : 'en'}
                  />
                )}
              </div>
            </div>

            {/* Price change bars */}
            {md && (
              <div style={{ marginBottom: 20 }}>
                <div style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: tokens.colors.text.primary,
                  marginBottom: 8,
                }}>
                  {t('priceChanges')}
                </div>
                <PriceChangeBar label="1h" value={md.price_change_percentage_1h_in_currency?.usd} />
                <PriceChangeBar label="24h" value={md.price_change_percentage_24h} />
                <PriceChangeBar label="7d" value={md.price_change_percentage_7d} />
                <PriceChangeBar label="30d" value={md.price_change_percentage_30d} />
              </div>
            )}

            {/* Market data */}
            <div style={{ marginBottom: 20 }}>
              <div style={{
                fontSize: 14,
                fontWeight: 600,
                color: tokens.colors.text.primary,
                marginBottom: 8,
              }}>
                {t('fundamentalData')}
              </div>
              <StatRow label={t('marketRank')} value={`${token.rank}`} />
              <StatRow label={t('tokenMarketCap')} value={formatNum(token.marketCap)} />
              <StatRow label={t('tokenVolume24h')} value={formatNum(token.volume24h)} />
              <StatRow label={t('tokenHigh24h')} value={formatPrice(token.high24h)} />
              <StatRow label={t('tokenLow24h')} value={formatPrice(token.low24h)} />
              {md && (
                <>
                  <StatRow label={t('fullyDilutedValuation')} value={formatNum(md.fully_diluted_valuation?.usd)} />
                  <StatRow label={t('circulatingSupply')} value={formatSupply(md.circulating_supply)} />
                  <StatRow label={t('totalSupply')} value={formatSupply(md.total_supply)} />
                  <StatRow label={t('maxSupply')} value={formatSupply(md.max_supply)} />
                </>
              )}
            </div>

            {/* ATH / ATL */}
            {md && (
              <div style={{ marginBottom: 20 }}>
                <div style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: tokens.colors.text.primary,
                  marginBottom: 8,
                }}>
                  {t('historicalExtremes')}
                </div>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 12,
                }}>
                  <div style={{
                    padding: 12,
                    background: tokens.colors.bg.tertiary,
                    borderRadius: tokens.radius.md,
                  }}>
                    <div style={{ fontSize: 11, color: tokens.colors.text.tertiary, marginBottom: 4 }}>{t('allTimeHigh')}</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: tokens.colors.accent.success, fontFamily: 'var(--font-mono, monospace)' }}>
                      {formatPrice(md.ath.usd)}
                    </div>
                    <div style={{ fontSize: 11, color: tokens.colors.text.tertiary, marginTop: 2 }}>
                      {formatDate(md.ath_date.usd)}
                    </div>
                    <div style={{ fontSize: 11, color: tokens.colors.accent.error, marginTop: 2 }}>
                      {(md.ath_change_percentage?.usd ?? 0).toFixed(1)}%
                    </div>
                  </div>
                  <div style={{
                    padding: 12,
                    background: tokens.colors.bg.tertiary,
                    borderRadius: tokens.radius.md,
                  }}>
                    <div style={{ fontSize: 11, color: tokens.colors.text.tertiary, marginBottom: 4 }}>{t('allTimeLow')}</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: tokens.colors.accent.error, fontFamily: 'var(--font-mono, monospace)' }}>
                      {formatPrice(md.atl.usd)}
                    </div>
                    <div style={{ fontSize: 11, color: tokens.colors.text.tertiary, marginTop: 2 }}>
                      {formatDate(md.atl_date.usd)}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Links - official website only */}
            {(coinDetail?.links?.homepage?.filter(Boolean)?.length ?? 0) > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {coinDetail!.links.homepage.filter(Boolean).slice(0, 1).map((url: string, i: number) => (
                    <a
                      key={i}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '6px 12px',
                        background: tokens.colors.bg.tertiary,
                        borderRadius: tokens.radius.md,
                        color: tokens.colors.accent.primary,
                        fontSize: 12,
                        textDecoration: 'none',
                        border: `1px solid ${tokens.colors.border.primary}`,
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="2" y1="12" x2="22" y2="12" />
                        <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
                      </svg>
                      {t('officialWebsite')}
                    </a>
                  ))}
                </div>
              </div>
            )}

            {/* Related Traders */}
            <div>
              <div style={{
                fontSize: 14,
                fontWeight: 600,
                color: tokens.colors.text.primary,
                marginBottom: 8,
              }}>
                {t('relatedTraders')}
              </div>
              <div style={{
                padding: 16,
                background: tokens.colors.bg.tertiary,
                borderRadius: tokens.radius.md,
                textAlign: 'center',
                color: tokens.colors.text.tertiary,
                fontSize: 13,
              }}>
                {t('noDataComingSoon')}
              </div>
            </div>
          </div>
          </div>
        </>
      )}
    </>
  )
}
