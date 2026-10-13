'use client'

import React, { useState, useRef } from 'react'
import Link from 'next/link'
import { tokens, alpha } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import {
  getAvatarGradient,
  getAvatarInitial,
  getTraderAvatarUrl,
  isWalletAddress,
  generateBlockieSvg,
} from '@/lib/utils/avatar'
import { useLanguage } from '../Providers/LanguageProvider'
import ShareCompareButton from './ShareCompareButton'
import {
  formatDrawdown,
  formatPnL,
  formatRatio,
  normalizeDrawdownMagnitude,
} from '@/lib/utils/format'
import { compareAccountKey, type CompareAccountRef } from '@/lib/compare/identity'

/** Chart colors used for score bars. */
const CHART_COLORS = [
  tokens.colors.accent.brand,
  'var(--color-enterprise-gradient-start)',
  'var(--color-score-average)',
  'var(--color-score-great)',
  'var(--color-accent-error)',
  'var(--color-chart-violet)',
  'var(--color-chart-pink)',
  'var(--color-chart-teal)',
  'var(--color-chart-orange)',
  'var(--color-chart-blue)',
]

interface TraderCompareData {
  id: string
  handle: string | null
  source: string
  roi: number | null
  roi_7d?: number | null
  roi_30d?: number | null
  pnl?: number | null
  max_drawdown?: number | null
  win_rate?: number | null
  trades_count?: number | null
  arena_score?: number | null
  return_score?: number | null
  drawdown_score?: number | null
  stability_score?: number | null
  // v4 serving sub-scores (0-100 dimension percentiles)
  profitability_score?: number | null
  risk_control_score?: number | null
  execution_score?: number | null
  is_bot?: boolean
  avatar_url?: string
  followers?: number | null
  ranking_visibility?: 'verified' | 'partial' | 'unknown'
  ranking_visibility_reason?: string | null
}

interface TraderComparisonProps {
  traders: TraderCompareData[]
  onRemove?: (account: CompareAccountRef) => void
  showRemoveButton?: boolean
}

type TabKey = 'metrics' | 'bars'

type ComparisonMetricKey =
  | 'arena_score'
  | 'roi'
  | 'roi_30d'
  | 'roi_7d'
  | 'pnl'
  | 'win_rate'
  | 'max_drawdown'
  | 'trades_count'
  | 'profitability_score'
  | 'risk_control_score'
  | 'execution_score'
  | 'followers'

type ComparisonMetric = {
  key: ComparisonMetricKey
  label: string
  format: (value: number) => string
  higherBetter: boolean
  isPercent?: boolean
}

const BOUNDED_SCORE_METRICS = new Set<ComparisonMetricKey>([
  'arena_score',
  'win_rate',
  'profitability_score',
  'risk_control_score',
  'execution_score',
])

// Format helpers — formatPnL and formatRatio imported from @/lib/utils/format

function getValueColor(value: number | undefined | null, isPositiveGood = true): string {
  if (value == null || !Number.isFinite(value)) return tokens.colors.text.tertiary
  if (isPositiveGood) return value >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error
  return value <= 0 ? tokens.colors.accent.success : tokens.colors.accent.error
}

function normalizedDimension(value: number | undefined | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null
}

function comparisonMetricValue(trader: TraderCompareData, key: ComparisonMetricKey): number | null {
  const value = trader[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (key === 'max_drawdown') return normalizeDrawdownMagnitude(value)
  return BOUNDED_SCORE_METRICS.has(key) ? normalizedDimension(value) : value
}

function getUniqueBestIndex(values: (number | undefined | null)[], isHigherBetter = true): number {
  const validEntries = values
    .map((value, index) => ({ value, index }))
    .filter(
      (entry): entry is { value: number; index: number } =>
        typeof entry.value === 'number' && Number.isFinite(entry.value)
    )
  if (validEntries.length < 2) return -1

  const bestValue = isHigherBetter
    ? Math.max(...validEntries.map((entry) => entry.value))
    : Math.min(...validEntries.map((entry) => entry.value))
  const bestEntries = validEntries.filter((entry) => entry.value === bestValue)
  return bestEntries.length === 1 ? bestEntries[0].index : -1
}

function _getWorstIndex(values: (number | undefined | null)[], isHigherBetter = true): number {
  let worstIdx = -1
  let worstVal = isHigherBetter ? Infinity : -Infinity
  let validCount = 0
  values.forEach((val, idx) => {
    if (val != null) {
      validCount++
      if (isHigherBetter ? val < worstVal : val > worstVal) {
        worstVal = val
        worstIdx = idx
      }
    }
  })
  return validCount >= 2 ? worstIdx : -1
}

const _SIGNED_METRIC_KEYS = new Set(['roi', 'roi_7d', 'roi_30d', 'pnl'])

function getSourceLabels(t: (key: string) => string): Record<string, string> {
  return {
    binance_futures: `Binance ${t('categoryFutures')}`,
    binance_spot: `Binance ${t('categorySpot')}`,
    binance_web3: `Binance ${t('categoryWeb3')}`,
    bybit: `Bybit ${t('categoryFutures')}`,
    bitget_futures: `Bitget ${t('categoryFutures')}`,
    bitget_spot: `Bitget ${t('categorySpot')}`,
    mexc: `MEXC ${t('categoryFutures')}`,
    coinex: `CoinEx ${t('categoryFutures')}`,
    okx_web3: `OKX ${t('categoryWeb3')}`,
    kucoin: `KuCoin ${t('categoryFutures')}`,
    gmx: `GMX ${t('categoryWeb3')}`,
  }
}

function traderAccount(trader: TraderCompareData): CompareAccountRef {
  return { id: trader.id, source: trader.source }
}

function traderIdentity(trader: TraderCompareData): string {
  return compareAccountKey(traderAccount(trader))
}

function traderHref(trader: TraderCompareData): string {
  return `/trader/${encodeURIComponent(trader.id)}?platform=${encodeURIComponent(trader.source)}`
}

export default function TraderComparison({
  traders,
  onRemove,
  showRemoveButton = true,
}: TraderComparisonProps) {
  const { t } = useLanguage()
  const sourceLabels = getSourceLabels(t)
  const [activeTab, setActiveTab] = useState<TabKey>('metrics')
  const comparisonRef = useRef<HTMLDivElement>(null)

  if (traders.length === 0) {
    return (
      <Box
        style={{
          padding: tokens.spacing[8],
          textAlign: 'center',
          background: tokens.colors.bg.secondary,
          borderRadius: tokens.radius.xl,
          border: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        <Text size="lg" color="tertiary">
          {t('compareEmptyTitle')}
        </Text>
        <Text size="sm" color="tertiary" style={{ marginTop: tokens.spacing[2] }}>
          {t('compareEmptyDesc')}
        </Text>
      </Box>
    )
  }

  // Metrics rows - bilingual
  const metrics: ComparisonMetric[] = [
    {
      key: 'arena_score',
      label: t('compareArenaScore'),
      format: (v: number) => formatRatio(v, 1),
      higherBetter: true,
    },
    {
      key: 'roi',
      label: t('compareROI90D'),
      format: (v: number) => `${v >= 0 ? '+' : ''}${formatRatio(v)}%`,
      higherBetter: true,
      isPercent: true,
    },
    {
      key: 'roi_30d',
      label: t('compareROI30D'),
      format: (v: number) => `${v >= 0 ? '+' : ''}${formatRatio(v)}%`,
      higherBetter: true,
      isPercent: true,
    },
    {
      key: 'roi_7d',
      label: t('compareROI7D'),
      format: (v: number) => `${v >= 0 ? '+' : ''}${formatRatio(v)}%`,
      higherBetter: true,
      isPercent: true,
    },
    { key: 'pnl', label: t('comparePnL'), format: formatPnL, higherBetter: true },
    {
      key: 'win_rate',
      label: t('compareWinRate'),
      format: (v: number) => `${formatRatio(v, 1)}%`,
      higherBetter: true,
    },
    {
      key: 'max_drawdown',
      label: t('compareMDD'),
      format: formatDrawdown,
      higherBetter: false,
    },
    {
      key: 'trades_count',
      label: t('compareTrades'),
      format: (v: number) => v.toString(),
      higherBetter: true,
    },
    // v4 (2026-07): compare on the flagship's real sub-scores (0-100 dimension
    // percentiles: 盈利=PnL+ROI / 风控=回撤+Sharpe / 一致性=胜率+盈利因子)。
    // The old return/drawdown/stability_score trio was live-computed V3.
    {
      key: 'profitability_score',
      label: t('scoreProfit'),
      format: (v: number) => formatRatio(v, 1),
      higherBetter: true,
    },
    {
      key: 'risk_control_score',
      label: t('scoreRisk'),
      format: (v: number) => formatRatio(v, 1),
      higherBetter: true,
    },
    {
      key: 'execution_score',
      label: t('scoreExecution'),
      format: (v: number) => formatRatio(v, 1),
      higherBetter: true,
    },
    {
      key: 'followers',
      label: t('compareFollowers'),
      format: (v: number) => v.toString(),
      higherBetter: true,
    },
  ]

  // Grouped-bar dimensions (0-100 normalized scores), one group per metric dimension
  const dimensionData = [
    // v4: 三维 = 盈利/风控/一致性(0-100 百分位),替换 V3 的 return/drawdown/stability
    {
      label: t('scoreProfit'),
      values: traders.map((tr) => normalizedDimension(tr.profitability_score)),
    },
    {
      label: t('scoreRisk'),
      values: traders.map((tr) => normalizedDimension(tr.risk_control_score)),
    },
    {
      label: t('scoreExecution'),
      values: traders.map((tr) => normalizedDimension(tr.execution_score)),
    },
    {
      label: t('compareWinRate'),
      values: traders.map((tr) => normalizedDimension(tr.win_rate)),
    },
    {
      label: t('compareArenaScore'),
      values: traders.map((tr) => normalizedDimension(tr.arena_score)),
    },
  ]

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'metrics', label: t('compareMetrics') },
    { key: 'bars', label: t('compareScoreBars') },
  ]

  // Shared grid geometry: label column + one column per trader.
  // Used by the div header (chart tabs) and the semantic table rows (metrics tab)
  // so columns always align.
  const gridTemplateColumns = `minmax(80px, 140px) repeat(${traders.length}, minmax(80px, 1fr))`
  const rowMinWidth = traders.length > 2 ? `${140 + traders.length * 120}px` : undefined

  const traderHeaderCellStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: tokens.spacing[2],
    position: 'relative',
  }

  // Header cell content (avatar + name + bot badge + source) — rendered inside a
  // <th scope="col"> on the metrics tab and inside a plain grid cell on chart tabs.
  const renderTraderHeaderContent = (trader: TraderCompareData) => (
    <>
      {showRemoveButton && onRemove && (
        <button
          aria-label="Close"
          onClick={() => onRemove(traderAccount(trader))}
          style={{
            position: 'absolute',
            top: -8,
            right: -8,
            width: 24,
            height: 24,
            borderRadius: tokens.radius.full,
            background: tokens.colors.accent.error,
            border: 'none',
            color: tokens.colors.white,
            cursor: 'pointer',
            // eslint-disable-next-line no-restricted-syntax -- off-scale by design (pre-existing close glyph size)
            fontSize: 14,
            fontWeight: 'bold',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'transform 0.2s',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(1.1)')}
          onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
        >
          ×
        </button>
      )}

      <Link href={traderHref(trader)}>
        {(() => {
          const proxyAvatarUrl = getTraderAvatarUrl(trader.avatar_url)
          return (
            <Box
              style={{
                width: 56,
                height: 56,
                borderRadius: tokens.radius.full,
                background: getAvatarGradient(trader.id),
                border: `2px solid ${tokens.colors.border.primary}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                cursor: 'pointer',
                transition: 'border-color 0.2s',
                position: 'relative',
              }}
            >
              <Text size="lg" weight="black" style={{ color: tokens.colors.white }}>
                {getAvatarInitial(trader.handle || trader.id)}
              </Text>
              {proxyAvatarUrl ? (
                <img
                  src={proxyAvatarUrl}
                  alt={trader.handle || trader.id}
                  width={48}
                  height={48}
                  loading="lazy"
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    position: 'absolute',
                    inset: 0,
                  }}
                  onError={(e) => {
                    ;(e.currentTarget as HTMLImageElement).style.display = 'none'
                  }}
                />
              ) : isWalletAddress(trader.id) ? (
                <img
                  src={generateBlockieSvg(trader.id, 112)}
                  alt={trader.handle || trader.id}
                  width={56}
                  height={56}
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    imageRendering: 'pixelated',
                    position: 'absolute',
                    inset: 0,
                  }}
                />
              ) : null}
            </Box>
          )
        })()}
      </Link>

      <Link href={traderHref(trader)} style={{ textDecoration: 'none' }}>
        <Text
          size="sm"
          weight="bold"
          style={{
            color: tokens.colors.text.primary,
            maxWidth: 100,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            textAlign: 'center',
          }}
        >
          {trader.handle || trader.id.slice(0, 10)}
        </Text>
      </Link>

      {(trader.is_bot || trader.source === 'web3_bot') && (
        <span
          style={{
            padding: '0px 5px',
            // eslint-disable-next-line no-restricted-syntax -- off-scale by design (pre-existing micro badge)
            borderRadius: 4,
            // eslint-disable-next-line no-restricted-syntax -- off-scale by design (pre-existing micro badge)
            fontSize: 10,
            // eslint-disable-next-line no-restricted-syntax -- off-scale by design (pre-existing micro badge)
            fontWeight: 600,
            color: 'var(--color-brand)',
            background: 'var(--color-brand-muted)',
            border: '1px solid color-mix(in srgb, var(--color-brand) 25%, transparent)',
            lineHeight: 1.4,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 2,
            marginTop: 2,
          }}
        >
          <span
            style={{
              // eslint-disable-next-line no-restricted-syntax -- off-scale by design (pre-existing micro glyph)
              fontSize: 8,
            }}
          >
            {'⚡'}
          </span>
          Bot
        </span>
      )}

      <Text size="xs" color="tertiary">
        {sourceLabels[trader.source] || trader.source}
      </Text>
      {trader.ranking_visibility && trader.ranking_visibility !== 'verified' && (
        <Text size="xs" color="tertiary" title={trader.ranking_visibility_reason ?? undefined}>
          {trader.ranking_visibility}
        </Text>
      )}
    </>
  )

  return (
    <div ref={comparisonRef} className="compare-mobile-stack">
      {/* Mobile responsive: stack vertically on small screens */}
      <style>{`
        @media (max-width: 640px) {
          .compare-mobile-stack .compare-header-grid {
            grid-template-columns: repeat(${traders.length}, 1fr) !important;
            min-width: unset !important;
          }
          .compare-mobile-stack .compare-label-col { display: none !important; }
          .compare-mobile-stack .compare-metric-row {
            display: flex !important; flex-wrap: wrap !important; min-width: unset !important;
          }
          .compare-mobile-stack .compare-metric-label { width: 100% !important; text-align: left !important; margin-bottom: 2px; }
          .compare-mobile-stack .compare-metric-cell { flex: 1; min-width: 0; }
        }
      `}</style>
      {/* Tab bar + Share */}
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: tokens.spacing[4],
          flexWrap: 'wrap',
          gap: tokens.spacing[3],
        }}
      >
        <Box style={{ display: 'flex', gap: tokens.spacing[1] }}>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.lg,
                border: 'none',
                background:
                  activeTab === tab.key ? tokens.colors.accent.primary : tokens.colors.bg.secondary,
                color:
                  activeTab === tab.key ? 'var(--color-on-accent)' : tokens.colors.text.secondary,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: activeTab === tab.key ? 700 : 500,
                cursor: 'pointer',
                transition: 'all 0.2s',
              }}
            >
              {tab.label}
            </button>
          ))}
        </Box>

        <ShareCompareButton accounts={traders.map(traderAccount)} comparisonRef={comparisonRef} />
      </Box>

      <Box
        className="compare-grid-scroll"
        style={{
          background: tokens.colors.bg.secondary,
          borderRadius: tokens.radius.xl,
          border: `1px solid ${tokens.colors.border.primary}`,
          overflowX: 'auto',
          overflowY: 'hidden',
        }}
      >
        {/* Header: trader avatars on score bars; the metrics table carries its own <thead>. */}
        {activeTab !== 'metrics' && (
          <Box
            className="compare-header-grid"
            style={{
              display: 'grid',
              gridTemplateColumns,
              gap: tokens.spacing[2],
              padding: tokens.spacing[4],
              borderBottom: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.tertiary,
              minWidth: rowMinWidth,
            }}
          >
            <Box className="compare-label-col" />
            {traders.map((trader) => (
              <Box key={traderIdentity(trader)} style={traderHeaderCellStyle}>
                {renderTraderHeaderContent(trader)}
              </Box>
            ))}
          </Box>
        )}

        {/* Tab content — metrics matrix as a semantic table (caption + row/column headers).
            display overrides keep the original grid layout, explicit ARIA roles keep
            table semantics that display:grid would otherwise strip. */}
        {activeTab === 'metrics' && (
          <table
            role="table"
            style={{ display: 'block', width: '100%', borderCollapse: 'collapse' }}
          >
            <caption className="sr-only">{t('compareTableCaption')}</caption>
            <thead role="rowgroup" style={{ display: 'block' }}>
              <tr
                role="row"
                className="compare-header-grid"
                style={{
                  display: 'grid',
                  gridTemplateColumns,
                  gap: tokens.spacing[2],
                  padding: tokens.spacing[4],
                  borderBottom: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.tertiary,
                  minWidth: rowMinWidth,
                }}
              >
                <td role="cell" className="compare-label-col" />
                {traders.map((trader) => (
                  <th
                    key={traderIdentity(trader)}
                    role="columnheader"
                    scope="col"
                    style={{ ...traderHeaderCellStyle, padding: 0, fontWeight: 'inherit' }}
                  >
                    {renderTraderHeaderContent(trader)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody role="rowgroup" style={{ display: 'block' }}>
              {metrics.map((metric, metricIdx) => {
                const values = traders.map((tr) => comparisonMetricValue(tr, metric.key))
                const bestIdx = getUniqueBestIndex(values, metric.higherBetter)

                return (
                  <tr
                    key={metric.key}
                    role="row"
                    className="compare-metric-row"
                    style={{
                      display: 'grid',
                      gridTemplateColumns,
                      gap: tokens.spacing[2],
                      padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                      minWidth: rowMinWidth,
                      borderBottom:
                        metricIdx < metrics.length - 1
                          ? `1px solid ${tokens.colors.border.primary}`
                          : 'none',
                      background:
                        metricIdx % 2 === 0
                          ? 'transparent'
                          : `${alpha(tokens.colors.bg.tertiary, 31)}`,
                    }}
                  >
                    <th
                      role="rowheader"
                      scope="row"
                      className="compare-metric-label"
                      style={{ textAlign: 'left', padding: 0, fontWeight: 'inherit' }}
                    >
                      <Text as="span" size="sm" weight="semibold" color="secondary">
                        {metric.label}
                      </Text>
                    </th>

                    {traders.map((trader, traderIdx) => {
                      const value = comparisonMetricValue(trader, metric.key)
                      const hasValue = value != null
                      const isBest = traderIdx === bestIdx && hasValue
                      const color =
                        metric.key === 'max_drawdown'
                          ? value == null || value === 0
                            ? tokens.colors.text.tertiary
                            : tokens.colors.accent.error
                          : metric.isPercent
                            ? getValueColor(value, metric.higherBetter)
                            : isBest
                              ? tokens.colors.accent.success
                              : tokens.colors.text.primary

                      return (
                        <td
                          key={traderIdentity(trader)}
                          role="cell"
                          className="compare-metric-cell"
                          style={{ textAlign: 'center', position: 'relative', padding: 0 }}
                        >
                          <Text
                            as="span"
                            size="sm"
                            weight={isBest ? 'black' : 'semibold'}
                            style={{ color, position: 'relative' }}
                          >
                            {hasValue ? metric.format(value) : '—'}
                            {isBest && (
                              <span
                                style={{
                                  position: 'absolute',
                                  top: -2,
                                  right: -16,
                                  // eslint-disable-next-line no-restricted-syntax -- off-scale by design (pre-existing crown marker)
                                  fontSize: 10,
                                  color: tokens.colors.accent.success,
                                }}
                              >
                                <span aria-hidden="true">👑</span>
                                <span className="sr-only">{t('compareBestValue')}</span>
                              </span>
                            )}
                          </Text>
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}

        {activeTab === 'bars' && (
          <Box
            style={{
              padding: tokens.spacing[6],
              display: 'flex',
              flexDirection: 'column',
              gap: tokens.spacing[5],
            }}
          >
            {dimensionData.map((dim) => (
              <Box key={dim.label}>
                <Text
                  as="h3"
                  size="sm"
                  weight="semibold"
                  color="secondary"
                  style={{ marginBottom: tokens.spacing[2] }}
                >
                  {dim.label}
                </Text>
                <Box
                  style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}
                  role="list"
                >
                  {dim.values.map((rawValue, i) => {
                    const trader = traders[i]
                    const value = rawValue
                    const color = CHART_COLORS[i % CHART_COLORS.length]
                    return (
                      <Box
                        key={traderIdentity(trader)}
                        role="listitem"
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: tokens.spacing[2],
                        }}
                      >
                        <Box
                          aria-hidden="true"
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: tokens.radius.full,
                            background: color,
                            flexShrink: 0,
                          }}
                        />
                        <Text
                          as="span"
                          size="xs"
                          color="tertiary"
                          style={{
                            width: 96,
                            flexShrink: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {trader.handle || trader.id.slice(0, 10)}
                        </Text>
                        <Box
                          role="progressbar"
                          aria-label={`${dim.label}: ${trader.handle || trader.id}`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={value ?? undefined}
                          aria-valuetext={value == null ? t('notAvailable') : formatRatio(value, 0)}
                          style={{
                            flex: 1,
                            height: 8,
                            borderRadius: tokens.radius.full,
                            background: alpha(tokens.colors.text.tertiary, 14),
                            overflow: 'hidden',
                          }}
                        >
                          {value != null && (
                            <Box
                              style={{
                                width: `${value}%`,
                                height: '100%',
                                borderRadius: tokens.radius.full,
                                background: color,
                              }}
                            />
                          )}
                        </Box>
                        <Text
                          as="span"
                          size="xs"
                          weight="semibold"
                          style={{
                            width: 36,
                            flexShrink: 0,
                            textAlign: 'right',
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          {value == null ? '—' : formatRatio(value, 0)}
                        </Text>
                      </Box>
                    )
                  })}
                </Box>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </div>
  )
}
