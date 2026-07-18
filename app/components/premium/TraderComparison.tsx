'use client'

import React, { useState, useRef } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
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
import { CompactErrorBoundary } from '../utils/ErrorBoundary'
import ShareCompareButton from './ShareCompareButton'
import { formatPnL, formatRatio } from '@/lib/utils/format'
import { compareAccountKey, type CompareAccountRef } from '@/lib/compare/identity'

// Lazy load chart components — only rendered when user switches to the equity tab
const EquityCurveOverlay = dynamic(() => import('./EquityCurveOverlay'), { ssr: false })

/** Chart colors used for trader comparison overlays (duplicated from EquityCurveOverlay to avoid eager import). */
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
  roi: number
  roi_7d?: number
  roi_30d?: number
  pnl?: number
  max_drawdown?: number
  win_rate?: number
  trades_count?: number
  arena_score?: number
  return_score?: number
  drawdown_score?: number
  stability_score?: number
  // v4 serving sub-scores (0-100 dimension percentiles)
  profitability_score?: number
  risk_control_score?: number
  execution_score?: number
  is_bot?: boolean
  avatar_url?: string
  followers?: number
  equity_curve?: Array<{ date: string; roi: number }>
}

interface TraderComparisonProps {
  traders: TraderCompareData[]
  onRemove?: (account: CompareAccountRef) => void
  showRemoveButton?: boolean
}

type TabKey = 'metrics' | 'bars' | 'equity'

// Format helpers — formatPnL and formatRatio imported from @/lib/utils/format

function getValueColor(value: number | undefined | null, isPositiveGood = true): string {
  if (value == null) return tokens.colors.text.tertiary
  if (isPositiveGood) return value >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error
  return value <= 0 ? tokens.colors.accent.success : tokens.colors.accent.error
}

function getBestIndex(values: (number | undefined | null)[], isHigherBetter = true): number {
  let bestIdx = -1
  let bestVal = isHigherBetter ? -Infinity : Infinity
  values.forEach((val, idx) => {
    if (val != null && isFinite(val)) {
      if (isHigherBetter ? val > bestVal : val < bestVal) {
        bestVal = val
        bestIdx = idx
      }
    }
  })
  return bestIdx
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
  const metrics = [
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
      format: (v: number) => `-${formatRatio(Math.abs(v))}%`,
      higherBetter: false,
      isNegative: true,
    },
    {
      key: 'trades_count',
      label: t('compareTrades'),
      format: (v: number) => v?.toString() || '—',
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
      format: (v: number) => v?.toString() || '0',
      higherBetter: true,
    },
  ]

  // Grouped-bar dimensions (0-100 normalized scores), one group per metric dimension
  const dimensionData = [
    // v4: 三维 = 盈利/风控/一致性(0-100 百分位),替换 V3 的 return/drawdown/stability
    {
      label: t('scoreProfit'),
      values: traders.map((tr) => Math.min(tr.profitability_score ?? 0, 100)),
    },
    {
      label: t('scoreRisk'),
      values: traders.map((tr) => Math.min(tr.risk_control_score ?? 0, 100)),
    },
    {
      label: t('scoreExecution'),
      values: traders.map((tr) => Math.min(tr.execution_score ?? 0, 100)),
    },
    { label: t('compareWinRate'), values: traders.map((tr) => Math.min(tr.win_rate ?? 0, 100)) },
    {
      label: t('compareArenaScore'),
      values: traders.map((tr) => Math.min(tr.arena_score ?? 0, 100)),
    },
  ]

  // Equity curve data
  const equityTraders = traders.map((tr, i) => ({
    traderId: traderIdentity(tr),
    traderName: tr.handle || tr.id.slice(0, 10),
    data: tr.equity_curve || [],
    color: CHART_COLORS[i % CHART_COLORS.length],
  }))

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'metrics', label: t('compareMetrics') },
    { key: 'bars', label: t('compareScoreBars') },
    { key: 'equity', label: t('compareEquityCurve') },
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
        {/* Header: trader avatars (chart tabs only — the metrics table carries its own <thead>) */}
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
                const values = traders.map(
                  (tr) =>
                    (tr as unknown as Record<string, unknown>)[metric.key] as number | undefined
                )
                const bestIdx = getBestIndex(values, metric.higherBetter)

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
                      const value = (trader as unknown as Record<string, unknown>)[metric.key] as
                        | number
                        | undefined
                      const isBest = traderIdx === bestIdx && value != null && isFinite(value)
                      const color =
                        metric.isPercent || metric.isNegative
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
                            {value != null ? metric.format(value) : '—'}
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
                    const value = Math.max(0, Math.min(rawValue, 100))
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
                          style={{
                            flex: 1,
                            height: 8,
                            borderRadius: tokens.radius.full,
                            background: alpha(tokens.colors.text.tertiary, 14),
                            overflow: 'hidden',
                          }}
                        >
                          <Box
                            style={{
                              width: `${value}%`,
                              height: '100%',
                              borderRadius: tokens.radius.full,
                              background: color,
                            }}
                          />
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
                          {formatRatio(value, 0)}
                        </Text>
                      </Box>
                    )
                  })}
                </Box>
              </Box>
            ))}
          </Box>
        )}

        {activeTab === 'equity' && (
          <Box style={{ padding: tokens.spacing[4] }}>
            <CompactErrorBoundary>
              <EquityCurveOverlay traders={equityTraders} height={300} />
            </CompactErrorBoundary>
          </Box>
        )}
      </Box>
    </div>
  )
}
