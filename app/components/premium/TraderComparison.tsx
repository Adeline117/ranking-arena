'use client'

import React, { useState, useRef } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { getAvatarGradient, getAvatarInitial, getTraderAvatarUrl, isWalletAddress, generateBlockieSvg } from '@/lib/utils/avatar'
import { useLanguage } from '../Providers/LanguageProvider'
import RadarChart from './RadarChart'
import EquityCurveOverlay, { CHART_COLORS } from './EquityCurveOverlay'
import { CompactErrorBoundary } from '../utils/ErrorBoundary'
import ShareCompareButton from './ShareCompareButton'
import { formatPnL, formatRatio } from '@/lib/utils/format'

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
  is_bot?: boolean
  avatar_url?: string
  followers?: number
  equity_curve?: Array<{ date: string; roi: number }>
}

interface TraderComparisonProps {
  traders: TraderCompareData[]
  onRemove?: (traderId: string) => void
  showRemoveButton?: boolean
}

type TabKey = 'metrics' | 'radar' | 'equity'

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
    'binance_futures': `Binance ${t('categoryFutures')}`,
    'binance_spot': `Binance ${t('categorySpot')}`,
    'binance_web3': `Binance ${t('categoryWeb3')}`,
    'bybit': `Bybit ${t('categoryFutures')}`,
    'bitget_futures': `Bitget ${t('categoryFutures')}`,
    'bitget_spot': `Bitget ${t('categorySpot')}`,
    'mexc': `MEXC ${t('categoryFutures')}`,
    'coinex': `CoinEx ${t('categoryFutures')}`,
    'okx_web3': `OKX ${t('categoryWeb3')}`,
    'kucoin': `KuCoin ${t('categoryFutures')}`,
    'gmx': `GMX ${t('categoryWeb3')}`,
  }
}

export default function TraderComparison({ traders, onRemove, showRemoveButton = true }: TraderComparisonProps) {
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
        <Text size="lg" color="tertiary">{t('compareEmptyTitle')}</Text>
        <Text size="sm" color="tertiary" style={{ marginTop: tokens.spacing[2] }}>
          {t('compareEmptyDesc')}
        </Text>
      </Box>
    )
  }

  // Metrics rows - bilingual
  const metrics = [
    { key: 'arena_score', label: t('compareArenaScore'), format: (v: number) => formatRatio(v, 1), higherBetter: true },
    { key: 'roi', label: t('compareROI90D'), format: (v: number) => `${v >= 0 ? '+' : ''}${formatRatio(v)}%`, higherBetter: true, isPercent: true },
    { key: 'roi_30d', label: t('compareROI30D'), format: (v: number) => `${v >= 0 ? '+' : ''}${formatRatio(v)}%`, higherBetter: true, isPercent: true },
    { key: 'roi_7d', label: t('compareROI7D'), format: (v: number) => `${v >= 0 ? '+' : ''}${formatRatio(v)}%`, higherBetter: true, isPercent: true },
    { key: 'pnl', label: t('comparePnL'), format: formatPnL, higherBetter: true },
    { key: 'win_rate', label: t('compareWinRate'), format: (v: number) => `${formatRatio(v, 1)}%`, higherBetter: true },
    { key: 'max_drawdown', label: t('compareMDD'), format: (v: number) => `-${formatRatio(Math.abs(v))}%`, higherBetter: false, isNegative: true },
    { key: 'trades_count', label: t('compareTrades'), format: (v: number) => v?.toString() || '—', higherBetter: true },
    { key: 'return_score', label: t('compareReturnScore'), format: (v: number) => formatRatio(v, 1), higherBetter: true },
    { key: 'drawdown_score', label: t('compareDrawdownScore'), format: (v: number) => formatRatio(v, 1), higherBetter: true },
    { key: 'stability_score', label: t('compareStabilityScore'), format: (v: number) => formatRatio(v, 1), higherBetter: true },
    { key: 'followers', label: t('compareFollowers'), format: (v: number) => v?.toString() || '0', higherBetter: true },
  ]

  // Radar chart data
  const radarData = [
    { label: t('compareReturnScore'), values: traders.map(tr => Math.min((tr.return_score ?? 0), 100)) },
    { label: t('compareDrawdownScore'), values: traders.map(tr => Math.min((tr.drawdown_score ?? 0), 100)) },
    { label: t('compareStabilityScore'), values: traders.map(tr => Math.min((tr.stability_score ?? 0), 100)) },
    { label: t('compareWinRate'), values: traders.map(tr => Math.min((tr.win_rate ?? 0), 100)) },
    { label: t('compareArenaScore'), values: traders.map(tr => Math.min((tr.arena_score ?? 0), 100)) },
  ]

  // Equity curve data
  const equityTraders = traders.map((tr, i) => ({
    traderId: tr.id,
    traderName: tr.handle || tr.id.slice(0, 10),
    data: tr.equity_curve || [],
    color: CHART_COLORS[i % CHART_COLORS.length],
  }))

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'metrics', label: t('compareMetrics') },
    { key: 'radar', label: t('compareRadar') },
    { key: 'equity', label: t('compareEquityCurve') },
  ]

  return (
    <div ref={comparisonRef}>
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
                background: activeTab === tab.key
                  ? tokens.colors.accent.primary
                  : tokens.colors.bg.secondary,
                color: activeTab === tab.key
                  ? 'var(--color-on-accent)'
                  : tokens.colors.text.secondary,
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

        <ShareCompareButton
          traderIds={traders.map(t => t.id)}
          comparisonRef={comparisonRef}
        />
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
        {/* Header: trader avatars */}
        <Box
          style={{
            display: 'grid',
            gridTemplateColumns: `minmax(80px, 140px) repeat(${traders.length}, minmax(80px, 1fr))`,
            gap: tokens.spacing[2],
            padding: tokens.spacing[4],
            borderBottom: `1px solid ${tokens.colors.border.primary}`,
            background: tokens.colors.bg.tertiary,
            minWidth: traders.length > 2 ? `${140 + traders.length * 120}px` : undefined,
          }}
        >
          <Box />
          {traders.map((trader) => (
            <Box
              key={trader.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: tokens.spacing[2],
                position: 'relative',
              }}
            >
              {showRemoveButton && onRemove && (
                <button aria-label="Close"
                  onClick={() => onRemove(trader.id)}
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
                    fontSize: 14,
                    fontWeight: 'bold',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'transform 0.2s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.1)'}
                  onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
                >
                  ×
                </button>
              )}

              <Link href={`/trader/${encodeURIComponent(trader.id)}`}>
                {(() => {
                  const proxyAvatarUrl = getTraderAvatarUrl(trader.avatar_url)
                  return (
                    <Box
                      style={{
                        width: 56,
                        height: 56,
                        borderRadius: tokens.radius.full,
                        background: proxyAvatarUrl ? tokens.colors.bg.secondary : getAvatarGradient(trader.id),
                        border: `2px solid ${tokens.colors.border.primary}`,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        overflow: 'hidden',
                        cursor: 'pointer',
                        transition: 'border-color 0.2s',
                      }}
                    >
                      {proxyAvatarUrl ? (
                        <img
                          src={proxyAvatarUrl}
                          alt={trader.handle || trader.id}
                          width={48}
                          height={48}
                          loading="lazy"
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                        />
                      ) : isWalletAddress(trader.id) ? (
                        <img
                          src={generateBlockieSvg(trader.id, 112)}
                          alt={trader.handle || trader.id}
                          width={56}
                          height={56}
                          style={{ width: '100%', height: '100%', objectFit: 'cover', imageRendering: 'pixelated' }}
                        />
                      ) : (
                        <Text size="lg" weight="black" style={{ color: tokens.colors.white }}>
                          {getAvatarInitial(trader.handle || trader.id)}
                        </Text>
                      )}
                    </Box>
                  )
                })()}
              </Link>

              <Link href={`/trader/${encodeURIComponent(trader.id)}`} style={{ textDecoration: 'none' }}>
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
                <span style={{
                  padding: '0px 5px', borderRadius: 4, fontSize: 10, fontWeight: 600,
                  color: 'var(--color-brand)', background: 'var(--color-brand-muted)',
                  border: '1px solid color-mix(in srgb, var(--color-brand) 25%, transparent)',
                  lineHeight: 1.4, display: 'inline-flex', alignItems: 'center', gap: 2,
                  marginTop: 2,
                }}>
                  <span style={{ fontSize: 8 }}>{'⚡'}</span>Bot
                </span>
              )}

              <Text size="xs" color="tertiary">
                {sourceLabels[trader.source] || trader.source}
              </Text>
            </Box>
          ))}
        </Box>

        {/* Tab content */}
        {activeTab === 'metrics' && (
          <>
            {metrics.map((metric, metricIdx) => {
              const values = traders.map(tr => (tr as unknown as Record<string, unknown>)[metric.key] as number | undefined)
              const bestIdx = getBestIndex(values, metric.higherBetter)

              return (
                <Box
                  key={metric.key}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: `minmax(80px, 140px) repeat(${traders.length}, minmax(80px, 1fr))`,
                    gap: tokens.spacing[2],
                    padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                    minWidth: traders.length > 2 ? `${140 + traders.length * 120}px` : undefined,
                    borderBottom: metricIdx < metrics.length - 1 ? `1px solid ${tokens.colors.border.primary}` : 'none',
                    background: metricIdx % 2 === 0 ? 'transparent' : `${tokens.colors.bg.tertiary}50`,
                  }}
                >
                  <Text size="sm" weight="semibold" color="secondary">
                    {metric.label}
                  </Text>

                  {traders.map((trader, traderIdx) => {
                    const value = (trader as unknown as Record<string, unknown>)[metric.key] as number | undefined
                    const isBest = traderIdx === bestIdx && value != null && isFinite(value)
                    const color = metric.isPercent || metric.isNegative
                      ? getValueColor(value, metric.higherBetter)
                      : isBest
                        ? tokens.colors.accent.success
                        : tokens.colors.text.primary

                    return (
                      <Box key={trader.id} style={{ textAlign: 'center', position: 'relative' }}>
                        <Text
                          size="sm"
                          weight={isBest ? 'black' : 'semibold'}
                          style={{ color, position: 'relative' }}
                        >
                          {value != null ? metric.format(value) : '—'}
                          {isBest && (
                            <span style={{
                              position: 'absolute', top: -2, right: -16,
                              fontSize: 10, color: tokens.colors.accent.success,
                            }}>👑</span>
                          )}
                        </Text>
                      </Box>
                    )
                  })}
                </Box>
              )
            })}
          </>
        )}

        {activeTab === 'radar' && (
          <Box style={{ padding: tokens.spacing[6], display: 'flex', justifyContent: 'center' }}>
            <RadarChart
              data={radarData}
              traderNames={traders.map(tr => tr.handle || tr.id.slice(0, 10))}
              colors={CHART_COLORS}
              size={340}
            />
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
