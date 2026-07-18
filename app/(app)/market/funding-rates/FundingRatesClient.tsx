'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import FloatingActionButton from '@/app/components/layout/FloatingActionButton'
import EmptyState from '@/app/components/ui/EmptyState'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens, alpha } from '@/lib/design-tokens'
import { formatMarketTimeUtc } from '@/lib/market/time'

interface FundingRateRow {
  platform: string
  symbol: string
  funding_rate: number
  funding_time: string
}

type SortField = 'platform' | 'symbol' | 'funding_rate' | 'apr' | 'funding_time'
type SortDir = 'asc' | 'desc'

const PLATFORM_LABELS: Record<string, string> = {
  binance: 'Binance',
  bybit: 'Bybit',
  okx: 'OKX',
  bitget: 'Bitget',
}

// Funding settles every 8h on Binance/Bybit/OKX/Bitget for most perpetuals → 3
// periods/day. The data layer does not (yet) carry a per-row funding interval,
// so APR is annualized under this assumption (see aprAssumptionNote tooltip).
const FUNDING_PERIODS_PER_DAY = 3

/** Annualized APR (fraction) from a single-period funding rate, assuming 8h cadence. */
function annualizeApr(rate: number): number {
  return rate * FUNDING_PERIODS_PER_DAY * 365
}

function normalizeSymbol(symbol: string): string {
  // Normalize OKX format: BTC-USDT-SWAP -> BTCUSDT
  return symbol.replace(/-/g, '').replace('SWAP', '')
}

function formatRate(rate: number): string {
  return (rate * 100).toFixed(4) + '%'
}

function formatApr(apr: number): string {
  return (apr * 100).toFixed(2) + '%'
}

export default function FundingRatesClient({ rates }: { rates: FundingRateRow[] }) {
  const { t } = useLanguage()
  const [sortField, setSortField] = useState<SortField>('funding_rate')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [filterPlatform, setFilterPlatform] = useState<string>('all')
  const [search, setSearch] = useState<string>('')

  const platforms = useMemo(() => {
    const set = new Set(rates.map((r) => r.platform))
    return Array.from(set).sort()
  }, [rates])

  const sorted = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filtered = rates.filter(
      (r) =>
        (filterPlatform === 'all' || r.platform === filterPlatform) &&
        (q === '' || normalizeSymbol(r.symbol).toLowerCase().includes(q))
    )
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
        case 'apr':
          // APR is a fixed multiple of the period rate, so it sorts identically
          cmp = a.funding_rate - b.funding_rate
          break
        case 'funding_time':
          cmp = new Date(a.funding_time).getTime() - new Date(b.funding_time).getTime()
          break
      }
      return sortDir === 'desc' ? -cmp : cmp
    })
  }, [rates, sortField, sortDir, filterPlatform, search])

  // Heatmap normalization: largest |rate| in the loaded set drives cell intensity.
  const maxAbsRate = useMemo(
    () => rates.reduce((m, r) => Math.max(m, Math.abs(r.funding_rate)), 0),
    [rates]
  )

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir(field === 'funding_rate' || field === 'apr' ? 'desc' : 'asc')
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
          <span>{t('fundingRates')}</span>
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
            {t('fundingRates')}
          </h1>
          <p
            style={{
              fontSize: tokens.typography.fontSize.base,
              color: tokens.colors.text.secondary,
              marginTop: 6,
            }}
          >
            {t('fundingRatesDesc')}
          </p>
        </div>

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
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('searchSymbolPlaceholder')}
            aria-label={t('searchSymbolPlaceholder')}
            style={{
              padding: '6px 12px',
              borderRadius: tokens.radius.md,
              border: tokens.glass.border.light,
              background: tokens.glass.bg.secondary,
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.sm,
              minWidth: 160,
              marginLeft: 'auto',
            }}
          />
        </div>

        {/* Table */}
        {rates.length === 0 ? (
          <EmptyState title={t('noFundingData')} description={t('marketDataPending')} />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                // minWidth 让表在窄视口真正溢出,外层 overflowX:auto 才能横滚。
                // 无它时 width:100% 使 wrapper 感知不到溢出,移动端末列(资金费率时间)
                // 被裁且不可横滚 → 内容不可达。
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
                      ['funding_rate', t('fundingRate')],
                      ['apr', t('colApr')],
                      ['funding_time', t('colFundingTime')],
                    ] as [SortField, string][]
                  ).map(([field, label]) => (
                    <th
                      key={field}
                      scope="col"
                      aria-sort={ariaSort(field)}
                      tabIndex={0}
                      title={field === 'apr' ? t('aprAssumptionNote') : undefined}
                      onClick={() => handleSort(field)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          handleSort(field)
                        }
                      }}
                      style={{
                        padding: '12px 16px',
                        textAlign: field === 'funding_rate' || field === 'apr' ? 'right' : 'left',
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
                  const rateColor =
                    row.funding_rate > 0
                      ? tokens.colors.accent.success
                      : row.funding_rate < 0
                        ? tokens.colors.accent.error
                        : tokens.colors.text.secondary
                  // Heatmap: cell tint opacity ∝ |rate| / max|rate|, hue follows sign.
                  // Capped at 18% so the colored numeral + sign stay legible.
                  const intensity = maxAbsRate > 0 ? Math.abs(row.funding_rate) / maxAbsRate : 0
                  const heatBg =
                    row.funding_rate !== 0
                      ? alpha(rateColor, Math.round(intensity * 18))
                      : undefined
                  const apr = annualizeApr(row.funding_rate)

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
                            color: rateColor,
                            background: heatBg,
                          } as React.CSSProperties
                        }
                      >
                        {row.funding_rate > 0 ? '+' : ''}
                        {formatRate(row.funding_rate)}
                      </td>
                      <td
                        style={
                          {
                            padding: '12px 16px',
                            textAlign: 'right',
                            fontFamily: 'var(--font-mono, monospace)',
                            fontVariantNumeric: 'tabular-nums',
                            fontWeight: tokens.typography.fontWeight.semibold,
                            color: rateColor,
                          } as React.CSSProperties
                        }
                      >
                        {apr > 0 ? '+' : ''}
                        {formatApr(apr)}
                      </td>
                      <td
                        style={{
                          padding: '12px 16px',
                          color: tokens.colors.text.tertiary,
                          fontSize: tokens.typography.fontSize.sm,
                        }}
                      >
                        {formatMarketTimeUtc(row.funding_time)}
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
