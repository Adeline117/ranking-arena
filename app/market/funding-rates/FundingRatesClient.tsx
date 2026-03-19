'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import TopNav from '@/app/components/layout/TopNav'
import FloatingActionButton from '@/app/components/layout/FloatingActionButton'
import { tokens } from '@/lib/design-tokens'

interface FundingRateRow {
  platform: string
  symbol: string
  funding_rate: number
  funding_time: string
}

type SortField = 'platform' | 'symbol' | 'funding_rate' | 'funding_time'
type SortDir = 'asc' | 'desc'

const PLATFORM_LABELS: Record<string, string> = {
  binance: 'Binance',
  bybit: 'Bybit',
  okx: 'OKX',
  bitget: 'Bitget',
}

function normalizeSymbol(symbol: string): string {
  // Normalize OKX format: BTC-USDT-SWAP -> BTCUSDT
  return symbol.replace(/-/g, '').replace('SWAP', '')
}

function formatRate(rate: number): string {
  return (rate * 100).toFixed(4) + '%'
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export default function FundingRatesClient({ rates }: { rates: FundingRateRow[] }) {
  const [sortField, setSortField] = useState<SortField>('funding_rate')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [filterPlatform, setFilterPlatform] = useState<string>('all')

  const platforms = useMemo(() => {
    const set = new Set(rates.map(r => r.platform))
    return Array.from(set).sort()
  }, [rates])

  const sorted = useMemo(() => {
    let filtered = filterPlatform === 'all' ? rates : rates.filter(r => r.platform === filterPlatform)
    return [...filtered].sort((a, b) => {
      let cmp = 0
      switch (sortField) {
        case 'platform':
          cmp = a.platform.localeCompare(b.platform)
          break
        case 'symbol':
          cmp = normalizeSymbol(a.symbol).localeCompare(normalizeSymbol(b.symbol))
          break
        case 'funding_rate':
          cmp = a.funding_rate - b.funding_rate
          break
        case 'funding_time':
          cmp = new Date(a.funding_time).getTime() - new Date(b.funding_time).getTime()
          break
      }
      return sortDir === 'desc' ? -cmp : cmp
    })
  }, [rates, sortField, sortDir, filterPlatform])

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir(field === 'funding_rate' ? 'desc' : 'asc')
    }
  }

  const sortIndicator = (field: SortField) =>
    sortField === field ? (sortDir === 'asc' ? ' \u2191' : ' \u2193') : ''

  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={null} />

      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 16px 60px' }}>
        {/* Breadcrumb */}
        <nav style={{ fontSize: 13, color: tokens.colors.text.tertiary, marginBottom: 16 }}>
          <Link href="/market" style={{ color: tokens.colors.text.secondary, textDecoration: 'none' }}>
            Market
          </Link>
          <span style={{ margin: '0 6px' }}>/</span>
          <span>Funding Rates</span>
        </nav>

        {/* Header */}
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0, letterSpacing: '-0.5px' }}>
            Funding Rates
          </h1>
          <p style={{ fontSize: 14, color: tokens.colors.text.secondary, marginTop: 6 }}>
            Perpetual futures funding rates across exchanges. Positive rates indicate longs pay shorts (bullish bias).
            Negative rates indicate shorts pay longs (bearish bias).
          </p>
        </div>

        {/* Filter */}
        <div style={{ marginBottom: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            onClick={() => setFilterPlatform('all')}
            style={{
              padding: '6px 14px',
              borderRadius: tokens.radius.md,
              border: filterPlatform === 'all' ? '1px solid var(--color-accent-primary)' : tokens.glass.border.light,
              background: filterPlatform === 'all' ? 'var(--color-accent-primary-08)' : tokens.glass.bg.secondary,
              color: filterPlatform === 'all' ? 'var(--color-accent-primary)' : tokens.colors.text.secondary,
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            All
          </button>
          {platforms.map(p => (
            <button
              key={p}
              onClick={() => setFilterPlatform(p)}
              style={{
                padding: '6px 14px',
                borderRadius: tokens.radius.md,
                border: filterPlatform === p ? '1px solid var(--color-accent-primary)' : tokens.glass.border.light,
                background: filterPlatform === p ? 'var(--color-accent-primary-08)' : tokens.glass.bg.secondary,
                color: filterPlatform === p ? 'var(--color-accent-primary)' : tokens.colors.text.secondary,
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              {PLATFORM_LABELS[p] || p}
            </button>
          ))}
        </div>

        {/* Table */}
        {rates.length === 0 ? (
          <div style={{
            padding: '60px 20px',
            textAlign: 'center',
            color: tokens.colors.text.tertiary,
            fontSize: 14,
          }}>
            No funding rate data available yet. Data will appear after the next cron cycle.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 14,
            }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${tokens.colors.border.primary}` }}>
                  {([
                    ['platform', 'Exchange'],
                    ['symbol', 'Symbol'],
                    ['funding_rate', 'Funding Rate'],
                    ['funding_time', 'Funding Time'],
                  ] as [SortField, string][]).map(([field, label]) => (
                    <th
                      key={field}
                      onClick={() => handleSort(field)}
                      style={{
                        padding: '12px 16px',
                        textAlign: field === 'funding_rate' ? 'right' : 'left',
                        fontWeight: 600,
                        color: tokens.colors.text.secondary,
                        cursor: 'pointer',
                        userSelect: 'none',
                        whiteSpace: 'nowrap',
                        fontSize: 12,
                        textTransform: 'uppercase',
                        letterSpacing: '0.5px',
                      }}
                    >
                      {label}{sortIndicator(field)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((row, i) => {
                  const rateColor = row.funding_rate > 0
                    ? tokens.colors.accent.success
                    : row.funding_rate < 0
                      ? tokens.colors.accent.error
                      : tokens.colors.text.secondary

                  return (
                    <tr
                      key={`${row.platform}-${row.symbol}-${i}`}
                      style={{
                        borderBottom: `1px solid ${tokens.colors.border.secondary}`,
                        transition: 'background 0.15s',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = tokens.colors.bg.hover)}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <td style={{ padding: '12px 16px', fontWeight: 500 }}>
                        {PLATFORM_LABELS[row.platform] || row.platform}
                      </td>
                      <td style={{
                        padding: '12px 16px',
                        fontFamily: 'var(--font-mono, monospace)',
                        fontWeight: 500,
                      }}>
                        {normalizeSymbol(row.symbol)}
                      </td>
                      <td style={{
                        padding: '12px 16px',
                        textAlign: 'right',
                        fontFamily: 'var(--font-mono, monospace)',
                        fontWeight: 600,
                        color: rateColor,
                      }}>
                        {row.funding_rate > 0 ? '+' : ''}{formatRate(row.funding_rate)}
                      </td>
                      <td style={{
                        padding: '12px 16px',
                        color: tokens.colors.text.tertiary,
                        fontSize: 13,
                      }}>
                        {formatTime(row.funding_time)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <FloatingActionButton />
    </div>
  )
}
