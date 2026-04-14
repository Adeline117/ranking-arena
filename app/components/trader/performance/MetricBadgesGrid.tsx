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
  copiersPnl?: number | undefined
  avgLeverage?: number | undefined
  longPositions?: number | undefined
  shortPositions?: number | undefined
  isVisible: boolean
}

// Metrics beyond this threshold indicate data corruption (division by zero, numerical instability).
// Applied to Sharpe, Sortino, Calmar — all ratio metrics that can overflow.
const RATIO_OVERFLOW_THRESHOLD = 100

/** Check if a ratio metric is valid (non-null, finite, within bounds) */
function isValidRatio(v: number | undefined): v is number {
  return v != null && Number.isFinite(v) && Math.abs(v) < RATIO_OVERFLOW_THRESHOLD
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
  copiersPnl,
  avgLeverage,
  longPositions,
  shortPositions,
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
        value={isValidRatio(sharpeRatio) ? sharpeRatio.toFixed(2) : '—'}
        highlight={isValidRatio(sharpeRatio) && sharpeRatio > 1}
        tooltip={!isValidRatio(sharpeRatio) ? t('sharpeNotAvailable') : (t('sharpeTooltip') || 'Risk-adjusted return per unit of risk. > 1 good, > 2 excellent.')}
      />
      <MetricBadge
        label={t('maxDrawdownShort')}
        value={maxDrawdown != null && Math.abs(maxDrawdown) <= 100 ? (Math.abs(maxDrawdown) < 0.05 ? '< -0.1%' : `-${Math.abs(maxDrawdown).toFixed(1)}%`) : '—'}
        negative
        tooltip={maxDrawdown == null || Math.abs(maxDrawdown) > 100 ? t('drawdownNotAvailable') : (t('mddTooltip') || 'Largest peak-to-trough decline. Lower = better risk control.')}
      />
      <MetricBadge
        label={t('winRateShort')}
        value={winRate != null ? `${winRate.toFixed(1)}%` : '—'}
        highlight={winRate != null && winRate > 60}
        tooltip={winRate == null ? t('winRateNotAvailable') : (t('winRateTooltip') || 'Percentage of profitable trades. Higher = more consistent.')}
      />
      <MetricBadge
        label={t('winningPositions')}
        value={winningPositions != null && totalPositions != null && totalPositions > 0
          ? `${winningPositions} / ${totalPositions}`
          : '—'}
        tooltip={winningPositions == null
          ? t('positionStatsNotAvailable')
          : `${winningPositions} winning out of ${totalPositions} total positions`}
      />
      <MetricBadge
        label={t('sortino') || 'Sortino'}
        value={isValidRatio(sortinoRatio) ? sortinoRatio.toFixed(2) : '—'}
        highlight={isValidRatio(sortinoRatio) && sortinoRatio >= 2}
        tooltip={!isValidRatio(sortinoRatio) ? (t('sortinoNotAvailable') || 'Not enough data') : (t('sortinoTooltip') || 'Risk-adjusted return using downside volatility')}
      />
      <MetricBadge
        label={t('calmar') || 'Calmar'}
        value={isValidRatio(calmarRatio) ? calmarRatio.toFixed(2) : '—'}
        highlight={isValidRatio(calmarRatio) && calmarRatio >= 3}
        tooltip={!isValidRatio(calmarRatio) ? (t('calmarNotAvailable') || 'Not enough data') : (t('calmarTooltip') || 'Annualized return / max drawdown')}
      />
      {alpha != null && (
        <MetricBadge
          label={t('alpha') || 'Alpha'}
          value={`${alpha >= 0 ? '+' : ''}${alpha.toFixed(2)}%`}
          highlight={alpha > 0}
          negative={alpha < 0}
          tooltip={t('alphaTooltip') || 'Excess return vs market benchmark'}
        />
      )}
      {tradesCount != null && (
        <MetricBadge
          label={t('tradesLabel') || 'Trades'}
          value={tradesCount.toLocaleString('en-US')}
        />
      )}
      {avgHoldingTimeHours != null && (
        <MetricBadge
          label={t('avgHoldingTime') || 'Avg Hold'}
          value={avgHoldingTimeHours < 1 ? `${Math.round(avgHoldingTimeHours * 60)}m` : `${Math.round(avgHoldingTimeHours)}h`}
        />
      )}
      {copiersPnl != null && (
        <MetricBadge
          label={t('copiersPnl') || 'Copiers PnL'}
          value={`${copiersPnl >= 0 ? '+' : ''}$${Math.abs(copiersPnl).toLocaleString('en-US', { maximumFractionDigits: 0 })}`}
          highlight={copiersPnl > 0}
          negative={copiersPnl < 0}
        />
      )}
      {avgLeverage != null && avgLeverage > 0 && (
        <MetricBadge
          label={t('avgLeverage') || 'Avg Leverage'}
          value={`${avgLeverage.toFixed(1)}x`}
          highlight={avgLeverage >= 10}
          tooltip={t('avgLeverageTooltip') || 'Average leverage across current open positions'}
        />
      )}
      {longPositions != null && shortPositions != null && (longPositions + shortPositions) > 0 && (
        <MetricBadge
          label={t('longShort') || 'Long/Short'}
          value={`${longPositions}/${shortPositions}`}
          tooltip={t('longShortTooltip') || `${longPositions} long and ${shortPositions} short positions currently open`}
        />
      )}
    </Box>
  )
}
