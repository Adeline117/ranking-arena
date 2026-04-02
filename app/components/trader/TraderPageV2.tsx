'use client'

/**
 * TraderPageV2 - New trader detail page component using /api/trader/:platform/:trader_key
 * Pure DB read (< 200ms), staleness indicator, refresh button, graceful degradation.
 */

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useTraderDetailV2 } from '@/lib/hooks/useTraderDetailV2'
import dynamic from 'next/dynamic'
import TraderRefreshButton from './TraderRefreshButton'
import DataStateWrapper from '@/app/components/ui/DataStateWrapper'
import TradingStyleBadge from './TradingStyleBadge'
import { isWalletAddress, generateBlockieSvg, getAvatarGradient } from '@/lib/utils/avatar'

// Lazy load heavy below-the-fold components
const AdvancedMetricsCard = dynamic(() => import('./AdvancedMetricsCard'), { ssr: false })
const MarketCorrelationCard = dynamic(() => import('./MarketCorrelationCard'), { ssr: false })
import type { SnapshotWindow, SnapshotMetrics } from '@/lib/types/trading-platform'
import type { TraderAdvancedMetrics, TraderMarketCorrelation } from '@/lib/types/unified-trader'
import type { TradingStyle } from '@/lib/types/trader'

interface TraderPageV2Props {
  platform: string
  traderKey: string
}

export default function TraderPageV2({ platform, traderKey }: TraderPageV2Props) {
  const { t } = useLanguage()
  const {
    data,
    error,
    isLoading,
    isStale,
    triggerRefresh,
    isRefreshing,
    refreshError,
  } = useTraderDetailV2({ platform: platform as Parameters<typeof useTraderDetailV2>[0]['platform'], traderKey })

  return (
    <DataStateWrapper
      isLoading={isLoading}
      error={error}
      isEmpty={!data}
      onRetry={() => window.location.reload()}
    >
      {data && (
        <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
          {/* Header */}
          <div className="flex items-start justify-between flex-wrap gap-4">
            <div className="flex items-center gap-4">
              <div
                className="w-16 h-16 rounded-full flex items-center justify-center overflow-hidden"
                style={{ background: data.profile.avatar_url ? tokens.colors.bg.secondary : getAvatarGradient(traderKey), position: 'relative' }}
              >
                {data.profile.avatar_url ? (
                  <img
                    src={data.profile.avatar_url?.startsWith("/") ? data.profile.avatar_url : `/api/avatar?url=${encodeURIComponent(data.profile.avatar_url || "")}`}
                    alt={data.profile.display_name || traderKey}
                    width={64}
                    height={64}
                    className="w-full h-full object-cover"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                  />
                ) : isWalletAddress(traderKey) ? (
                  <img
                    src={generateBlockieSvg(traderKey, 128)}
                    alt={data.profile.display_name || traderKey}
                    width={64}
                    height={64}
                    className="w-full h-full object-cover"
                    style={{ imageRendering: 'pixelated' }}
                  />
                ) : (
                  <span className="text-2xl font-bold" style={{ color: '#fff', textShadow: '0 1px 3px rgba(0,0,0,0.3)' }}>
                    {(data.profile.display_name || traderKey).charAt(0).toUpperCase()}
                  </span>
                )}
              </div>

              <div>
                <h1 className="text-xl font-bold" style={{ color: tokens.colors.text.primary }}>
                  {data.profile.display_name || traderKey}
                </h1>
                <div className="flex items-center gap-2 mt-1">
                  <span
                    className="px-2 py-0.5 rounded text-xs font-medium"
                    style={{
                      backgroundColor: tokens.colors.accent.brand + '15',
                      color: tokens.colors.accent.brand,
                    }}
                  >
                    {platform.replace('_', ' ')}
                  </span>
                  {data.profile.bio ? (
                    <span className="text-sm truncate max-w-[200px]" style={{ color: tokens.colors.text.secondary }}>
                      {data.profile.bio}
                    </span>
                  ) : (
                    <span className="text-sm" style={{ color: tokens.colors.text.tertiary, opacity: 0.6 }}>
                      {platform.replace('_', ' ')} trader
                    </span>
                  )}
                </div>
              </div>
            </div>

            <TraderRefreshButton
              isRefreshing={isRefreshing}
              isStale={isStale}
              onRefresh={triggerRefresh}
              refreshError={refreshError}
              updatedAt={data.updated_at}
              refreshJob={data.refresh_job}
            />
          </div>

          {/* Profile stats bar */}
          <div
            className="grid grid-cols-2 gap-4 p-4 rounded-xl"
            style={{ backgroundColor: tokens.colors.bg.secondary }}
          >
            <StatItem label={t('followers')} value={data.profile.followers} format="number" />
            <StatItem label={t('aumLabel')} value={data.profile.aum} format="currency" />
          </div>

          {/* Performance Snapshots */}
          <div className="space-y-4">
            <h2 className="text-lg font-semibold" style={{ color: tokens.colors.text.primary }}>
              {t('performance')}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <SnapshotCard window="7D" metrics={data.snapshots['7D']} />
              <SnapshotCard window="30D" metrics={data.snapshots['30D']} />
              <SnapshotCard window="90D" metrics={data.snapshots['90D']} />
            </div>
          </div>

          {/* Trading Style Badge */}
          {(() => {
            const snapshot = data.snapshots['90D'] || data.snapshots['30D'] || data.snapshots['7D']
            if (snapshot?.trading_style) {
              return (
                <div className="flex items-center gap-2">
                  <TradingStyleBadge
                    style={snapshot.trading_style as TradingStyle}
                    confidence={snapshot.style_confidence}
                    size="lg"
                  />
                </div>
              )
            }
            return null
          })()}

          {/* Advanced Metrics Card */}
          {(() => {
            const snapshot = data.snapshots['90D'] || data.snapshots['30D'] || data.snapshots['7D']
            if (snapshot && (snapshot.sortino_ratio != null || snapshot.calmar_ratio != null)) {
              const advancedMetrics: TraderAdvancedMetrics = {
                sortino_ratio: snapshot.sortino_ratio ?? null,
                calmar_ratio: snapshot.calmar_ratio ?? null,
                profit_factor: snapshot.profit_factor ?? null,
                recovery_factor: snapshot.recovery_factor ?? null,
                max_consecutive_wins: snapshot.max_consecutive_wins ?? null,
                max_consecutive_losses: snapshot.max_consecutive_losses ?? null,
                avg_holding_hours: snapshot.avg_holding_hours ?? null,
                volatility_pct: snapshot.volatility_pct ?? null,
                downside_volatility_pct: snapshot.downside_volatility_pct ?? null,
              }
              return <AdvancedMetricsCard metrics={advancedMetrics} />
            }
            return null
          })()}

          {/* Market Correlation Card */}
          {(() => {
            const snapshot = data.snapshots['90D'] || data.snapshots['30D'] || data.snapshots['7D']
            if (snapshot && (snapshot.beta_btc != null || snapshot.alpha != null)) {
              const correlation: TraderMarketCorrelation = {
                beta_btc: snapshot.beta_btc ?? null,
                beta_eth: snapshot.beta_eth ?? null,
                alpha: snapshot.alpha ?? null,
                market_condition_performance: { bull: null, bear: null, sideways: null },
              }
              return <MarketCorrelationCard correlation={correlation} />
            }
            return null
          })()}

          {/* Equity Curve */}
          {data.timeseries.equity_curve && data.timeseries.equity_curve.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-lg font-semibold" style={{ color: tokens.colors.text.primary }}>
                {t('equityCurve')}
              </h2>
              <div className="p-4 rounded-xl" style={{ backgroundColor: tokens.colors.bg.secondary }}>
                <SimpleChart data={data.timeseries.equity_curve} />
              </div>
            </div>
          )}

          {/* Tags */}
          {data.profile.tags && data.profile.tags.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {data.profile.tags.map((tag, i) => (
                <span
                  key={i}
                  className="px-2 py-1 rounded-full text-xs"
                  style={{
                    backgroundColor: tokens.colors.bg.secondary,
                    color: tokens.colors.text.secondary,
                  }}
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </DataStateWrapper>
  )
}

function StatItem({ label, value, format }: {
  label: string
  value: number | null | undefined
  format: 'number' | 'currency' | 'percent'
}) {
  const isNull = value == null
  const formatValue = (): string => {
    if (isNull) return '—'
    switch (format) {
      case 'currency':
        return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
      case 'percent':
        return `${value.toFixed(2)}%`
      default:
        return value.toLocaleString()
    }
  }

  return (
    <div className="text-center">
      <div className="text-xs mb-1" style={{ color: tokens.colors.text.secondary }}>{label}</div>
      <div
        className="text-base font-semibold"
        style={{
          color: isNull ? tokens.colors.text.tertiary : tokens.colors.text.primary,
          opacity: isNull ? 0.4 : 1,
        }}
      >
        {formatValue()}
      </div>
    </div>
  )
}

function SnapshotCard({ window, metrics }: { window: SnapshotWindow; metrics: SnapshotMetrics | null }) {
  const { t } = useLanguage()

  if (!metrics) {
    return (
      <div className="p-4 rounded-xl opacity-60" style={{ backgroundColor: tokens.colors.bg.secondary }}>
        <div className="text-sm font-medium mb-3" style={{ color: tokens.colors.text.secondary }}>{window}</div>
        <div className="text-center py-4 text-xs" style={{ color: tokens.colors.text.tertiary }}>
          {t('noDataAvailable')}
        </div>
      </div>
    )
  }

  const roi = metrics.roi ?? 0
  const pnl = metrics.pnl ?? 0
  const roiColor = roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error

  return (
    <div className="p-4 rounded-xl" style={{ backgroundColor: tokens.colors.bg.secondary }}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium" style={{ color: tokens.colors.text.secondary }}>{window}</span>
        <div className="flex items-center gap-2">
          {metrics.arena_score_v3 != null && (
            <span
              className="text-xs font-bold px-2 py-0.5 rounded"
              style={{ backgroundColor: tokens.colors.accent.success + '20', color: tokens.colors.accent.success }}
            >
              V3: {metrics.arena_score_v3.toFixed(1)}
            </span>
          )}
          {metrics.arena_score != null && (
            <span
              className="text-xs font-bold px-2 py-0.5 rounded"
              style={{ backgroundColor: tokens.colors.accent.brand + '20', color: tokens.colors.accent.brand }}
            >
              Score: {metrics.arena_score.toFixed(1)}
            </span>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex justify-between">
          <span className="text-xs" style={{ color: tokens.colors.text.secondary }}>ROI</span>
          <span className="text-sm font-semibold" style={{ color: roiColor }}>
            {roi >= 0 ? '+' : ''}{roi.toFixed(2)}%
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-xs" style={{ color: tokens.colors.text.secondary }}>PnL</span>
          <span className="text-sm font-medium" style={{ color: tokens.colors.text.primary }}>
            ${pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </span>
        </div>
        {metrics.win_rate != null && (
          <div className="flex justify-between">
            <span className="text-xs" style={{ color: tokens.colors.text.secondary }}>{t('winRate')}</span>
            <span className="text-sm" style={{ color: tokens.colors.text.primary }}>{metrics.win_rate.toFixed(1)}%</span>
          </div>
        )}
        {metrics.max_drawdown != null && Math.abs(metrics.max_drawdown) <= 100 && (
          <div className="flex justify-between">
            <span className="text-xs" style={{ color: tokens.colors.text.secondary }}>{t('mddLabel')}</span>
            <span className="text-sm" style={{ color: tokens.colors.accent.error }}>{Math.abs(metrics.max_drawdown) < 0.05 ? '< 0.1%' : `-${Math.abs(metrics.max_drawdown).toFixed(1)}%`}</span>
          </div>
        )}
        {metrics.trades_count != null && (
          <div className="flex justify-between">
            <span className="text-xs" style={{ color: tokens.colors.text.secondary }}>{t('tradesLabel')}</span>
            <span className="text-sm" style={{ color: tokens.colors.text.primary }}>{metrics.trades_count}</span>
          </div>
        )}
        {metrics.sortino_ratio != null && (
          <div className="flex justify-between">
            <span className="text-xs" style={{ color: tokens.colors.text.secondary }}>Sortino</span>
            <span className="text-sm" style={{ color: metrics.sortino_ratio >= 2 ? tokens.colors.accent.success : tokens.colors.text.primary }}>
              {metrics.sortino_ratio.toFixed(2)}
            </span>
          </div>
        )}
        {metrics.alpha != null && (
          <div className="flex justify-between">
            <span className="text-xs" style={{ color: tokens.colors.text.secondary }}>Alpha</span>
            <span className="text-sm" style={{ color: metrics.alpha >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error }}>
              {metrics.alpha >= 0 ? '+' : ''}{metrics.alpha.toFixed(2)}%
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

function SimpleChart({ data }: { data: Array<{ date: string; roi: number }> }) {
  if (data.length < 2) return null

  const width = 600
  const height = 120
  const padding = 8

  const values = data.map(d => d.roi)
  const minVal = Math.min(...values)
  const maxVal = Math.max(...values)
  const range = maxVal - minVal || 1

  const points = data.map((d, i) => {
    const x = padding + (i / (data.length - 1)) * (width - 2 * padding)
    const y = height - padding - ((d.roi - minVal) / range) * (height - 2 * padding)
    return `${x},${y}`
  })

  const pathData = `M ${points.join(' L ')}`
  const isPositive = values[values.length - 1] >= values[0]
  const color = isPositive ? tokens.colors.accent.success : tokens.colors.accent.error

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-24" preserveAspectRatio="none">
      <path d={pathData} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
      <defs>
        <linearGradient id="chartGradient" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.2" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path
        d={`${pathData} L ${width - padding},${height - padding} L ${padding},${height - padding} Z`}
        fill="url(#chartGradient)"
      />
    </svg>
  )
}
