'use client'

import { tokens } from '@/lib/design-tokens'
import { Box } from '../../base'
import { useLanguage } from '../../Providers/LanguageProvider'
import { MetricBadge } from './MetricBadge'

export interface MetricBadgesGridProps {
  sharpeRatio: number | undefined
  maxDrawdown: number | undefined
  winRate: number | undefined
  winningPositions: number | undefined
  totalPositions: number | undefined
  sortinoRatio: number | undefined
  calmarRatio: number | undefined
  alpha: number | undefined
  tradesCount: number | undefined
  avgHoldingTimeHours: number | undefined
  isVisible: boolean
}

export function MetricBadgesGrid({
  sharpeRatio,
  maxDrawdown,
  winRate,
  winningPositions,
  totalPositions,
  sortinoRatio,
  calmarRatio,
  alpha,
  tradesCount,
  avgHoldingTimeHours,
  isVisible,
}: MetricBadgesGridProps) {
  const { t } = useLanguage()

  return (
    <Box
      className="metric-badges-grid"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: `${tokens.spacing[2]} ${tokens.spacing[2]}`,
        opacity: isVisible ? 1 : 0,
        transform: isVisible ? 'translateY(0)' : 'translateY(10px)',
        transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1) 0.3s',
      }}
    >
      <MetricBadge
        label={t('sharpe')}
        value={sharpeRatio != null && sharpeRatio < 9000 ? sharpeRatio.toFixed(2) : '—'}
        highlight={sharpeRatio != null && sharpeRatio > 1 && sharpeRatio < 9000}
        tooltip={sharpeRatio == null ? t('sharpeNotAvailable') : sharpeRatio >= 9000 ? t('sharpeNotAvailable') : undefined}
      />
      <MetricBadge
        label={t('maxDrawdownShort')}
        value={maxDrawdown != null && Math.abs(maxDrawdown) <= 100 ? (Math.abs(maxDrawdown) < 0.05 ? '< 0.1%' : `${Math.abs(maxDrawdown).toFixed(1)}%`) : '—'}
        negative
        tooltip={maxDrawdown == null ? t('drawdownNotAvailable') : Math.abs(maxDrawdown) > 100 ? t('drawdownNotAvailable') : undefined}
      />
      <MetricBadge
        label={t('winRateShort')}
        value={winRate != null ? `${winRate.toFixed(1)}%` : '—'}
        highlight={winRate != null && winRate > 60}
        tooltip={winRate == null ? t('winRateNotAvailable') : undefined}
      />
      <MetricBadge
        label={t('winningPositions')}
        value={winningPositions != null && totalPositions != null ? `${winningPositions}/${totalPositions}` : '—'}
        tooltip={winningPositions == null ? t('positionStatsNotAvailable') : undefined}
      />
      {sortinoRatio != null && (
        <MetricBadge
          label="Sortino"
          value={sortinoRatio.toFixed(2)}
          highlight={sortinoRatio >= 2}
          tooltip={t('sortinoTooltip') || 'Risk-adjusted return using downside volatility'}
        />
      )}
      {calmarRatio != null && (
        <MetricBadge
          label="Calmar"
          value={calmarRatio.toFixed(2)}
          highlight={calmarRatio >= 3}
          tooltip={t('calmarTooltip') || 'Annualized return / max drawdown'}
        />
      )}
      {alpha != null && (
        <MetricBadge
          label="Alpha"
          value={`${alpha >= 0 ? '+' : ''}${alpha.toFixed(2)}%`}
          highlight={alpha > 0}
          negative={alpha < 0}
          tooltip={t('alphaTooltip') || 'Excess return vs market benchmark'}
        />
      )}
      {tradesCount != null && (
        <MetricBadge
          label={t('tradesLabel') || 'Trades'}
          value={String(tradesCount)}
        />
      )}
      {avgHoldingTimeHours != null && (
        <MetricBadge
          label={t('avgHoldingTime') || 'Avg Hold'}
          value={avgHoldingTimeHours < 1 ? `${Math.round(avgHoldingTimeHours * 60)}m` : `${Math.round(avgHoldingTimeHours)}h`}
        />
      )}
    </Box>
  )
}
