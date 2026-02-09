'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
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
  return n.toLocaleString()
}

function formatPrice(n: number): string {
  if (n >= 1) return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return `$${n.toPrecision(4)}`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' })
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
      <div style={{ flex: 1, height: 6, background: tokens.colors.bg.tertiary, borderRadius: 3, overflow: 'hidden' }}>
        <div style={{
          width: `${barWidth}%`,
          height: '100%',
          background: color,
          borderRadius: 3,
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
  const panelRef = useRef<HTMLDivElement>(null)
  const [coinDetail, setCoinDetail] = useState<CoinDetail | null>(null)
  const [ohlcData, setOhlcData] = useState<OHLCVDataPoint[]>([])
  const [selectedPeriod, setSelectedPeriod] = useState('30')
  const [chartLoading, setChartLoading] = useState(false)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // Fetch coin detail
  useEffect(() => {
    if (!token) return
    setCoinDetail(null)
    fetch(`/api/market/coin/${token.id}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setCoinDetail(d))
      .catch(() => {})
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
      // ignore
    } finally {
      setChartLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!token) return
    fetchOhlc(token.id, selectedPeriod)
  }, [token?.id, selectedPeriod, fetchOhlc])

  const md = coinDetail?.market_data

  return (
    <AnimatePresence>
      {token && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            style={{
              position: 'fixed',
              inset: 0,
              background: 'var(--color-backdrop-light)',
              zIndex: 200,
            }}
          />
          <motion.div
            ref={panelRef}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            style={{
              position: 'fixed',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 'min(95vw, 900px)',
              maxHeight: '90vh',
              background: tokens.colors.bg.primary,
              border: `1px solid ${tokens.colors.border.primary}`,
              borderRadius: tokens.radius.xl,
              zIndex: 201,
              overflowY: 'auto',
              padding: 'clamp(16px, 4vw, 28px)',
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
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 4,
                  color: tokens.colors.text.tertiary,
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
                    Loading...
                  </div>
                )}
                {ohlcData.length > 0 && (
                  <TradingViewChart
                    data={ohlcData}
                    type="candlestick"
                    height={280}
                    theme="dark"
                    locale="zh"
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
                  价格变化
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
                基本面数据
              </div>
              <StatRow label="排名" value={`#${token.rank}`} />
              <StatRow label="市值" value={formatNum(token.marketCap)} />
              <StatRow label="24h 成交量" value={formatNum(token.volume24h)} />
              <StatRow label="24h 最高" value={formatPrice(token.high24h)} />
              <StatRow label="24h 最低" value={formatPrice(token.low24h)} />
              {md && (
                <>
                  <StatRow label="完全稀释估值" value={formatNum(md.fully_diluted_valuation?.usd)} />
                  <StatRow label="流通量" value={formatSupply(md.circulating_supply)} />
                  <StatRow label="总供应量" value={formatSupply(md.total_supply)} />
                  <StatRow label="最大供应量" value={formatSupply(md.max_supply)} />
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
                  历史极值
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
                    <div style={{ fontSize: 11, color: tokens.colors.text.tertiary, marginBottom: 4 }}>历史最高</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: tokens.colors.accent.success, fontFamily: 'var(--font-mono, monospace)' }}>
                      {formatPrice(md.ath.usd)}
                    </div>
                    <div style={{ fontSize: 11, color: tokens.colors.text.tertiary, marginTop: 2 }}>
                      {formatDate(md.ath_date.usd)}
                    </div>
                    <div style={{ fontSize: 11, color: tokens.colors.accent.error, marginTop: 2 }}>
                      {md.ath_change_percentage.usd.toFixed(1)}%
                    </div>
                  </div>
                  <div style={{
                    padding: 12,
                    background: tokens.colors.bg.tertiary,
                    borderRadius: tokens.radius.md,
                  }}>
                    <div style={{ fontSize: 11, color: tokens.colors.text.tertiary, marginBottom: 4 }}>历史最低</div>
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
                      官网
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
                相关交易员
              </div>
              <div style={{
                padding: 16,
                background: tokens.colors.bg.tertiary,
                borderRadius: tokens.radius.md,
                textAlign: 'center',
                color: tokens.colors.text.tertiary,
                fontSize: 13,
              }}>
                暂无数据 -- 即将推出
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
