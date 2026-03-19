'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import TopNav from '@/app/components/layout/TopNav'
import FloatingActionButton from '@/app/components/layout/FloatingActionButton'
import { tokens } from '@/lib/design-tokens'

interface OpenInterestRow {
  platform: string
  symbol: string
  open_interest_usd: number
  open_interest_contracts: number | null
  timestamp: string
}

type SortField = 'platform' | 'symbol' | 'open_interest_usd' | 'timestamp'
type SortDir = 'asc' | 'desc'

const PLATFORM_LABELS: Record<string, string> = {
  binance: 'Binance',
  bybit: 'Bybit',
  okx: 'OKX',
  bitget: 'Bitget',
}

function normalizeSymbol(symbol: string): string {
  return symbol.replace(/-/g, '').replace('SWAP', '')
}

function formatUsd(value: number): string {
  if (value >= 1_000_000_000) return '$' + (value / 1_000_000_000).toFixed(2) + 'B'
  if (value >= 1_000_000) return '$' + (value / 1_000_000).toFixed(2) + 'M'
  if (value >= 1_000) return '$' + (value / 1_000).toFixed(1) + 'K'
  return '$' + value.toFixed(0)
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

export default function OpenInterestClient({ rows }: { rows: OpenInterestRow[] }) {
  const [sortField, setSortField] = useState<SortField>('open_interest_usd')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [filterPlatform, setFilterPlatform] = useState<string>('all')

  const platforms = useMemo(() => {
    const set = new Set(rows.map(r => r.platform))
    return Array.from(set).sort()
  }, [rows])

  const sorted = useMemo(() => {
    const filtered = filterPlatform === 'all' ? rows : rows.filter(r => r.platform === filterPlatform)
    return [...filtered].sort((a, b) => {
      let cmp = 0
      switch (sortField) {
        case 'platform':
          cmp = a.platform.localeCompare(b.platform)
          break
        case 'symbol':
          cmp = normalizeSymbol(a.symbol).localeCompare(normalizeSymbol(b.symbol))
          break
        case 'open_interest_usd':
          cmp = a.open_interest_usd - b.open_interest_usd
          break
        case 'timestamp':
          cmp = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
          break
      }
      return sortDir === 'desc' ? -cmp : cmp
    })
  }, [rows, sortField, sortDir, filterPlatform])

  // Aggregate by symbol across exchanges
  const aggregated = useMemo(() => {
    const map = new Map<string, number>()
    for (const row of rows) {
      const sym = normalizeSymbol(row.symbol)
      map.set(sym, (map.get(sym) || 0) + row.open_interest_usd)
    }
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
  }, [rows])

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir(field === 'open_interest_usd' ? 'desc' : 'asc')
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
          <span>Open Interest</span>
        </nav>

        {/* Header */}
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0, letterSpacing: '-0.5px' }}>
            Open Interest
          </h1>
          <p style={{ fontSize: 14, color: tokens.colors.text.secondary, marginTop: 6 }}>
            Total outstanding perpetual futures positions across exchanges. Rising OI with price increases
            signals strong trend; rising OI with falling price signals potential squeeze.
          </p>
        </div>

        {/* Aggregate summary cards */}
        {aggregated.length > 0 && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: 12,
            marginBottom: 24,
          }}>
            {aggregated.map(([sym, total]) => (
              <div key={sym} style={{
                padding: '16px',
                background: tokens.glass.bg.secondary,
                borderRadius: tokens.radius.lg,
                border: tokens.glass.border.light,
              }}>
                <div style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: tokens.colors.text.tertiary,
                  textTransform: 'uppercase',
                  letterSpacing: '0.3px',
                  marginBottom: 6,
                }}>
                  {sym}
                </div>
                <div style={{
                  fontSize: 20,
                  fontWeight: 700,
                  fontFamily: 'var(--font-mono, monospace)',
                  fontVariantNumeric: 'tabular-nums',
                } as React.CSSProperties}>
                  {formatUsd(total)}
                </div>
              </div>
            ))}
          </div>
        )}

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
        {rows.length === 0 ? (
          <div style={{
            padding: '60px 20px',
            textAlign: 'center',
            color: tokens.colors.text.tertiary,
            fontSize: 14,
          }}>
            No open interest data available yet. Data will appear after the next cron cycle.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${tokens.colors.border.primary}` }}>
                  {([
                    ['platform', 'Exchange'],
                    ['symbol', 'Symbol'],
                    ['open_interest_usd', 'Open Interest (USD)'],
                    ['timestamp', 'Updated'],
                  ] as [SortField, string][]).map(([field, label]) => (
                    <th
                      key={field}
                      onClick={() => handleSort(field)}
                      style={{
                        padding: '12px 16px',
                        textAlign: field === 'open_interest_usd' ? 'right' : 'left',
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
                {sorted.map((row, i) => (
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
                    }}>
                      {formatUsd(row.open_interest_usd)}
                    </td>
                    <td style={{
                      padding: '12px 16px',
                      color: tokens.colors.text.tertiary,
                      fontSize: 13,
                    }}>
                      {formatTime(row.timestamp)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <FloatingActionButton />
    </div>
  )
}
