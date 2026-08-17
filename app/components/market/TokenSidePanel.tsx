'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
// CSS animations replace framer-motion (~40KB bundle savings)
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { useModalA11y } from '@/lib/hooks/useModalA11y'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import dynamic from 'next/dynamic'
import { apiFetch } from '@/lib/utils/api-fetch'
import type { OHLCVDataPoint } from '@/app/components/charts/TradingViewChart'
import type { Time } from 'lightweight-charts'

const TradingViewChart = dynamic(() => import('@/app/components/charts/TradingViewChart'), {
  ssr: false,
})

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

function formatPrice(n: number): string {
  if (n >= 1)
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return `$${n.toPrecision(4)}`
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        padding: '7px 0',
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
        fontSize: tokens.typography.fontSize.sm,
      }}
    >
      <span style={{ color: tokens.colors.text.tertiary }}>{label}</span>
      <span
        style={{
          color: tokens.colors.text.primary,
          fontWeight: tokens.typography.fontWeight.medium,
        }}
      >
        {value}
      </span>
    </div>
  )
}

export default function TokenSidePanel({
  token,
  onClose,
}: {
  token: TokenInfo | null
  onClose: () => void
}) {
  const { t, language } = useLanguage()
  const panelRef = useRef<HTMLDivElement>(null)
  const [ohlcData, setOhlcData] = useState<OHLCVDataPoint[]>([])
  const [selectedPeriod, setSelectedPeriod] = useState('30')
  const [chartLoading, setChartLoading] = useState(false)
  const [chartError, setChartError] = useState(false)
  const [chartTheme, setChartTheme] = useState<'dark' | 'light'>('dark')

  useEffect(() => {
    const getTheme = () =>
      (document.documentElement.getAttribute('data-theme') as 'dark' | 'light') || 'dark'
    setChartTheme(getTheme())
    const observer = new MutationObserver(() => setChartTheme(getTheme()))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    return () => observer.disconnect()
  }, [])

  useModalA11y({ open: !!token, onClose })

  // Fetch OHLC data
  const fetchOhlc = useCallback(async (id: string, days: string) => {
    setChartLoading(true)
    setChartError(false)
    try {
      const raw = await apiFetch<number[][]>(`/api/market/ohlc/${id}?days=${days}`)
      const data: OHLCVDataPoint[] = raw.map(([ts, o, h, l, c]) => ({
        time: (ts / 1000) as Time,
        open: o,
        high: h,
        low: l,
        close: c,
      }))
      setOhlcData(data)
    } catch {
      setChartError(true)
      setOhlcData([])
    } finally {
      setChartLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!token) return
    fetchOhlc(token.id, selectedPeriod)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- token.id is sufficient
  }, [token?.id, selectedPeriod, fetchOhlc])

  const headerChange24h = token?.change24h ?? 0

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
          <div
            style={{
              position: 'fixed',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: tokens.zIndex.overlay + 1,
              pointerEvents: 'none',
            }}
          >
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
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 16,
                }}
              >
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
                    <span
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: '50%',
                        background: tokens.colors.bg.tertiary,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontWeight: tokens.typography.fontWeight.bold,
                        fontSize: tokens.typography.fontSize.base,
                        color: tokens.colors.text.secondary,
                      }}
                    >
                      {token.symbol.charAt(0)}
                    </span>
                  )}
                  <div>
                    <div
                      style={{
                        fontSize: tokens.typography.fontSize.lg,
                        fontWeight: tokens.typography.fontWeight.bold,
                        color: tokens.colors.text.primary,
                      }}
                    >
                      {token.symbol}
                    </div>
                    <div
                      style={{
                        fontSize: tokens.typography.fontSize.xs,
                        color: tokens.colors.text.tertiary,
                      }}
                    >
                      {token.name}
                    </div>
                  </div>
                  <span
                    style={{
                      fontSize: tokens.typography.fontSize.xs,
                      color: tokens.colors.text.tertiary,
                      background: tokens.colors.bg.tertiary,
                      padding: '2px 8px',
                      borderRadius: tokens.radius.sm,
                      marginLeft: 4,
                    }}
                  >
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
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Price */}
              <div style={{ marginBottom: 16 }}>
                <div
                  style={{
                    fontSize: tokens.typography.fontSize.hero,
                    fontWeight: tokens.typography.fontWeight.bold,
                    color: tokens.colors.text.primary,
                    fontFamily: 'var(--font-mono, monospace)',
                  }}
                >
                  {formatPrice(token.price)}
                </div>
                <span
                  style={{
                    fontSize: tokens.typography.fontSize.base,
                    fontWeight: tokens.typography.fontWeight.semibold,
                    color:
                      headerChange24h >= 0
                        ? tokens.colors.accent.success
                        : tokens.colors.accent.error,
                  }}
                >
                  {headerChange24h >= 0 ? '+' : ''}
                  {headerChange24h.toFixed(2)}% (24h)
                </span>
              </div>

              {/* Chart */}
              <div
                style={{
                  marginBottom: 20,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  borderRadius: tokens.radius.lg,
                  overflow: 'hidden',
                }}
              >
                {/* Period selector */}
                <div
                  style={{
                    display: 'flex',
                    gap: 4,
                    padding: '8px 12px',
                    borderBottom: `1px solid ${tokens.colors.border.primary}`,
                  }}
                >
                  {PERIODS.map((p) => (
                    <button
                      key={p.days}
                      type="button"
                      onClick={() => setSelectedPeriod(p.days)}
                      aria-pressed={selectedPeriod === p.days}
                      style={{
                        background:
                          selectedPeriod === p.days ? 'var(--color-brand-deep)' : 'transparent',
                        color:
                          selectedPeriod === p.days
                            ? tokens.colors.white
                            : tokens.colors.text.tertiary,
                        border: 'none',
                        borderRadius: tokens.radius.sm,
                        padding: '4px 10px',
                        fontSize: tokens.typography.fontSize.xs,
                        fontWeight: tokens.typography.fontWeight.semibold,
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
                    <div
                      style={{
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 2,
                        color: tokens.colors.text.tertiary,
                        fontSize: tokens.typography.fontSize.sm,
                      }}
                    >
                      {t('loading')}
                    </div>
                  )}
                  {chartError && !chartLoading && (
                    <div
                      style={{
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: tokens.colors.text.tertiary,
                        fontSize: tokens.typography.fontSize.sm,
                      }}
                    >
                      {t('chartUnavailable')}
                    </div>
                  )}
                  {ohlcData.length > 0 && (
                    <TradingViewChart
                      data={ohlcData}
                      type="candlestick"
                      height={280}
                      theme={chartTheme}
                      locale={language}
                    />
                  )}
                </div>
              </div>

              <div
                role="status"
                style={{
                  marginBottom: 20,
                  padding: 16,
                  background: tokens.colors.bg.tertiary,
                  borderRadius: tokens.radius.md,
                  textAlign: 'center',
                  color: tokens.colors.text.tertiary,
                  fontSize: tokens.typography.fontSize.sm,
                }}
              >
                {t('dataUnavailable')}
              </div>

              {/* Market data */}
              <div style={{ marginBottom: 20 }}>
                <div
                  style={{
                    fontSize: tokens.typography.fontSize.base,
                    fontWeight: tokens.typography.fontWeight.semibold,
                    color: tokens.colors.text.primary,
                    marginBottom: 8,
                  }}
                >
                  {t('fundamentalData')}
                </div>
                <StatRow label={t('marketRank')} value={`${token.rank}`} />
                <StatRow label={t('tokenMarketCap')} value={formatNum(token.marketCap)} />
                <StatRow label={t('tokenVolume24h')} value={formatNum(token.volume24h)} />
                <StatRow label={t('tokenHigh24h')} value={formatPrice(token.high24h)} />
                <StatRow label={t('tokenLow24h')} value={formatPrice(token.low24h)} />
              </div>

              {/* Related Traders */}
              <div>
                <div
                  style={{
                    fontSize: tokens.typography.fontSize.base,
                    fontWeight: tokens.typography.fontWeight.semibold,
                    color: tokens.colors.text.primary,
                    marginBottom: 8,
                  }}
                >
                  {t('relatedTraders')}
                </div>
                <div
                  style={{
                    padding: 16,
                    background: tokens.colors.bg.tertiary,
                    borderRadius: tokens.radius.md,
                    textAlign: 'center',
                    color: tokens.colors.text.tertiary,
                    fontSize: tokens.typography.fontSize.sm,
                  }}
                >
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
