'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import FloatingActionButton from '@/app/components/layout/FloatingActionButton'
import EmptyState from '@/app/components/ui/EmptyState'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens, alpha } from '@/lib/design-tokens'
import { formatMarketTimeUtc } from '@/lib/market/time'

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

function formatShare(share: number): string {
  return (share * 100).toFixed(1) + '%'
}

// NOTE: a "24h Δ" column was requested but is intentionally omitted. The page
// data source (RPC `get_latest_open_interest`) returns only the latest snapshot
// per platform×symbol — no prior-period value is available to this client, and
// fabricating a delta would be misleading. Adding Δ requires a server-side
// change (e.g. a window-function RPC returning value-24h-ago) in page.tsx, which
// is out of scope for this surgical client edit.

export default function OpenInterestClient({ rows }: { rows: OpenInterestRow[] }) {
  const { t } = useLanguage()
  const [sortField, setSortField] = useState<SortField>('open_interest_usd')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [filterPlatform, setFilterPlatform] = useState<string>('all')

  // 陈旧数据过滤(显示层):摄取 cron 自 2/14 起只抓 BTC/ETH/SOL 等少数 symbol,
  // 其余行停在数月前。这些陈旧值若并排展示且计入聚合卡/占比条,会严重误导。
  // 以数据集中最新时间戳为基准(而非 now,因整批可能整体滞后),丢弃比它旧超过
  // 24h 的行 —— 表格与聚合卡都只算新鲜行。摄取端恢复全 symbol 抓取属数据侧(SKIP)。
  const STALE_MS = 24 * 60 * 60 * 1000
  const freshestTs = useMemo(
    () => rows.reduce((mx, r) => Math.max(mx, new Date(r.timestamp).getTime() || 0), 0),
    [rows]
  )
  const freshRows = useMemo(() => {
    if (!freshestTs) return rows
    return rows.filter((r) => {
      const ts = new Date(r.timestamp).getTime()
      return Number.isFinite(ts) && freshestTs - ts <= STALE_MS
    })
  }, [rows, freshestTs, STALE_MS])
  const staleCount = rows.length - freshRows.length

  const platforms = useMemo(() => {
    const set = new Set(freshRows.map((r) => r.platform))
    return Array.from(set).sort()
  }, [freshRows])

  const sorted = useMemo(() => {
    const filtered =
      filterPlatform === 'all' ? freshRows : freshRows.filter((r) => r.platform === filterPlatform)
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
  }, [freshRows, sortField, sortDir, filterPlatform])

  // Aggregate by symbol across exchanges
  const aggregated = useMemo(() => {
    const map = new Map<string, number>()
    for (const row of freshRows) {
      const sym = normalizeSymbol(row.symbol)
      map.set(sym, (map.get(sym) || 0) + row.open_interest_usd)
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1])
  }, [freshRows])

  // Grand total across the loaded set drives the share-of-total bars (no extra
  // data needed — pure derivation, so BTC's dominance is immediately visible).
  const grandTotal = useMemo(
    () => freshRows.reduce((sum, r) => sum + (r.open_interest_usd || 0), 0),
    [freshRows]
  )

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir(field === 'open_interest_usd' ? 'desc' : 'asc')
    }
  }

  const sortIndicator = (field: SortField) =>
    sortField === field ? (sortDir === 'asc' ? ' \u2191' : ' \u2193') : ''

  const ariaSort = (field: SortField): 'ascending' | 'descending' | 'none' =>
    sortField === field ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'

  return (
    <div
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
      }}
    >
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 16px 60px' }}>
        {/* Breadcrumb */}
        <nav
          style={{
            fontSize: tokens.typography.fontSize.sm,
            color: tokens.colors.text.tertiary,
            marginBottom: 16,
          }}
        >
          <Link
            href="/market"
            style={{ color: tokens.colors.text.secondary, textDecoration: 'none' }}
          >
            {t('market')}
          </Link>
          <span style={{ margin: '0 6px' }}>/</span>
          <span>{t('openInterest')}</span>
        </nav>

        {/* Header */}
        <div style={{ marginBottom: 24 }}>
          <h1
            style={{
              fontSize: tokens.typography.fontSize.hero,
              fontWeight: tokens.typography.fontWeight.bold,
              margin: 0,
              letterSpacing: '-0.5px',
            }}
          >
            {t('openInterest')}
          </h1>
          <p
            style={{
              fontSize: tokens.typography.fontSize.base,
              color: tokens.colors.text.secondary,
              marginTop: 6,
            }}
          >
            {t('openInterestDesc')}
          </p>
          {freshestTs > 0 && (
            <p
              style={{
                fontSize: tokens.typography.fontSize.xs,
                color: tokens.colors.text.tertiary,
                marginTop: 6,
              }}
            >
              {t('dataAsOf').replace(
                '{time}',
                formatMarketTimeUtc(new Date(freshestTs).toISOString())
              )}
              {staleCount > 0 && ` · ${t('staleRowsHidden').replace('{n}', String(staleCount))}`}
            </p>
          )}
        </div>

        {/* Aggregate summary cards */}
        {aggregated.length > 0 && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
              gap: 12,
              marginBottom: 24,
            }}
          >
            {aggregated.map(([sym, total]) => {
              const share = grandTotal > 0 ? total / grandTotal : 0
              return (
                <div
                  key={sym}
                  style={{
                    padding: '16px',
                    background: tokens.glass.bg.secondary,
                    borderRadius: tokens.radius.lg,
                    border: tokens.glass.border.light,
                  }}
                >
                  <div
                    style={{
                      fontSize: tokens.typography.fontSize.xs,
                      fontWeight: tokens.typography.fontWeight.semibold,
                      color: tokens.colors.text.tertiary,
                      textTransform: 'uppercase',
                      letterSpacing: '0.3px',
                      marginBottom: 6,
                    }}
                  >
                    {sym}
                  </div>
                  <div
                    style={
                      {
                        fontSize: tokens.typography.fontSize.xl,
                        fontWeight: tokens.typography.fontWeight.bold,
                        fontFamily: 'var(--font-mono, monospace)',
                        fontVariantNumeric: 'tabular-nums',
                      } as React.CSSProperties
                    }
                  >
                    {formatUsd(total)}
                  </div>
                  {/* Share-of-total bar — visualizes per-symbol OI dominance */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      marginTop: 10,
                    }}
                  >
                    <div
                      role="img"
                      aria-label={`${t('colShare')}: ${formatShare(share)}`}
                      style={{
                        flex: 1,
                        height: 4,
                        borderRadius: tokens.radius.full,
                        background: alpha(tokens.colors.accent.primary, 14),
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          width: `${Math.max(share * 100, 1)}%`,
                          height: '100%',
                          borderRadius: tokens.radius.full,
                          background: tokens.colors.accent.primary,
                        }}
                      />
                    </div>
                    <span
                      style={
                        {
                          fontSize: tokens.typography.fontSize.xs,
                          color: tokens.colors.text.tertiary,
                          fontVariantNumeric: 'tabular-nums',
                          minWidth: 38,
                          textAlign: 'right',
                        } as React.CSSProperties
                      }
                    >
                      {formatShare(share)}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Filter */}
        <div style={{ marginBottom: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => setFilterPlatform('all')}
            aria-pressed={filterPlatform === 'all'}
            style={{
              padding: '6px 14px',
              borderRadius: tokens.radius.md,
              border:
                filterPlatform === 'all'
                  ? '1px solid var(--color-accent-primary)'
                  : tokens.glass.border.light,
              background:
                filterPlatform === 'all'
                  ? 'var(--color-accent-primary-08)'
                  : tokens.glass.bg.secondary,
              color:
                filterPlatform === 'all'
                  ? 'var(--color-accent-primary)'
                  : tokens.colors.text.secondary,
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: tokens.typography.fontWeight.medium,
              cursor: 'pointer',
            }}
          >
            {t('all')}
          </button>
          {platforms.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setFilterPlatform(p)}
              aria-pressed={filterPlatform === p}
              style={{
                padding: '6px 14px',
                borderRadius: tokens.radius.md,
                border:
                  filterPlatform === p
                    ? '1px solid var(--color-accent-primary)'
                    : tokens.glass.border.light,
                background:
                  filterPlatform === p
                    ? 'var(--color-accent-primary-08)'
                    : tokens.glass.bg.secondary,
                color:
                  filterPlatform === p
                    ? 'var(--color-accent-primary)'
                    : tokens.colors.text.secondary,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: tokens.typography.fontWeight.medium,
                cursor: 'pointer',
              }}
            >
              {PLATFORM_LABELS[p] || p}
            </button>
          ))}
        </div>

        {/* Table */}
        {sorted.length === 0 ? (
          <EmptyState title={t('noOpenInterestData')} description={t('marketDataPending')} />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                // 同 funding-rates:width:100% 表让 wrapper 感知不到溢出,移动端末列被裁
                // 且不可横滚。minWidth 使表真正溢出,外层 overflowX:auto 才能横滚。
                minWidth: 560,
                borderCollapse: 'collapse',
                fontSize: tokens.typography.fontSize.base,
              }}
            >
              <thead>
                <tr style={{ borderBottom: `1px solid ${tokens.colors.border.primary}` }}>
                  {(
                    [
                      ['platform', t('exchange')],
                      ['symbol', t('symbol')],
                      ['open_interest_usd', t('colOpenInterestUsd')],
                      ['timestamp', t('colUpdated')],
                    ] as [SortField, string][]
                  ).map(([field, label]) => (
                    <th
                      key={field}
                      scope="col"
                      aria-sort={ariaSort(field)}
                      tabIndex={0}
                      onClick={() => handleSort(field)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          handleSort(field)
                        }
                      }}
                      style={{
                        padding: '12px 16px',
                        textAlign: field === 'open_interest_usd' ? 'right' : 'left',
                        fontWeight: tokens.typography.fontWeight.semibold,
                        color: tokens.colors.text.secondary,
                        cursor: 'pointer',
                        userSelect: 'none',
                        whiteSpace: 'nowrap',
                        fontSize: tokens.typography.fontSize.xs,
                        textTransform: 'uppercase',
                        letterSpacing: '0.5px',
                      }}
                    >
                      {label}
                      {sortIndicator(field)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((row, i) => {
                  const share = grandTotal > 0 ? row.open_interest_usd / grandTotal : 0
                  return (
                    <tr
                      key={`${row.platform}-${row.symbol}-${i}`}
                      style={{
                        borderBottom: `1px solid ${tokens.colors.border.secondary}`,
                        transition: 'background 0.15s',
                      }}
                      onMouseEnter={(e) =>
                        (e.currentTarget.style.background = tokens.colors.bg.hover)
                      }
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      <td
                        style={{
                          padding: '12px 16px',
                          fontWeight: tokens.typography.fontWeight.medium,
                        }}
                      >
                        {PLATFORM_LABELS[row.platform] || row.platform}
                      </td>
                      <td
                        style={{
                          padding: '12px 16px',
                          fontFamily: 'var(--font-mono, monospace)',
                          fontWeight: tokens.typography.fontWeight.medium,
                        }}
                      >
                        {normalizeSymbol(row.symbol)}
                      </td>
                      <td
                        style={
                          {
                            padding: '12px 16px',
                            textAlign: 'right',
                            fontFamily: 'var(--font-mono, monospace)',
                            fontVariantNumeric: 'tabular-nums',
                            fontWeight: tokens.typography.fontWeight.semibold,
                          } as React.CSSProperties
                        }
                      >
                        <div>{formatUsd(row.open_interest_usd)}</div>
                        {/* Share-of-total bar — value / sum across the loaded set */}
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'flex-end',
                            gap: 6,
                            marginTop: 5,
                          }}
                        >
                          <div
                            role="img"
                            aria-label={`${t('colShare')}: ${formatShare(share)}`}
                            style={{
                              width: 72,
                              height: 4,
                              borderRadius: tokens.radius.full,
                              background: alpha(tokens.colors.accent.primary, 14),
                              overflow: 'hidden',
                            }}
                          >
                            <div
                              style={{
                                width: `${Math.max(share * 100, 1)}%`,
                                height: '100%',
                                borderRadius: tokens.radius.full,
                                background: tokens.colors.accent.primary,
                              }}
                            />
                          </div>
                          <span
                            style={
                              {
                                fontSize: tokens.typography.fontSize.xs,
                                fontWeight: tokens.typography.fontWeight.medium,
                                color: tokens.colors.text.tertiary,
                                fontVariantNumeric: 'tabular-nums',
                                minWidth: 38,
                              } as React.CSSProperties
                            }
                          >
                            {formatShare(share)}
                          </span>
                        </div>
                      </td>
                      <td
                        style={{
                          padding: '12px 16px',
                          color: tokens.colors.text.tertiary,
                          fontSize: tokens.typography.fontSize.sm,
                        }}
                      >
                        {formatMarketTimeUtc(row.timestamp)}
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
