'use client'

import React, { useRef, useState, useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { NULL_DISPLAY } from '@/lib/utils/format'
import { useLanguage } from '../Providers/LanguageProvider'
import type { TraderAdvancedMetrics } from '@/lib/types/unified-trader'

export interface AdvancedMetricsCardProps {
  metrics: TraderAdvancedMetrics
  isLoading?: boolean
  /** Average profit per trade (percentage) for risk/reward ratio */
  avgProfit?: number | null
  /** Average loss per trade (percentage) for risk/reward ratio */
  avgLoss?: number | null
  /** Largest single trade win (USD) */
  largestWin?: number | null
  /** Largest single trade loss (USD) */
  largestLoss?: number | null
}

/**
 * AdvancedMetricsCard - Displays advanced trading metrics
 *
 * Shows:
 * - Sortino Ratio (risk-adjusted returns considering only downside volatility)
 * - Calmar Ratio (annualized return / max drawdown)
 * - Profit Factor (gross profit / gross loss)
 * - Recovery Factor (net profit / max drawdown)
 * - Consecutive wins/losses
 * - Average holding time
 * - Volatility metrics
 */
export default function AdvancedMetricsCard({
  metrics,
  isLoading = false,
  avgProfit,
  avgLoss,
  largestWin,
  largestLoss,
}: AdvancedMetricsCardProps) {
  const { t } = useLanguage()
  const [isVisible, setIsVisible] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!cardRef.current) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true)
          observer.disconnect()
        }
      },
      { threshold: 0.2 }
    )
    observer.observe(cardRef.current)
    return () => observer.disconnect()
  }, [])

  const formatRatio = (value: number | null, decimals = 2): string => {
    if (value === null || value === undefined) return '—'
    return value.toFixed(decimals)
  }

  const formatHours = (hours: number | null): string => {
    if (hours === null || hours === undefined) return '—'
    if (hours < 1) return `${Math.round(hours * 60)}m`
    if (hours < 24) return `${hours.toFixed(1)}h`
    if (hours < 168) return `${(hours / 24).toFixed(1)}d`
    return `${(hours / 168).toFixed(1)}w`
  }

  const getRatioColor = (value: number | null, thresholds: { good: number; excellent: number }): string => {
    if (value === null) return tokens.colors.text.tertiary
    if (value >= thresholds.excellent) return tokens.colors.accent.success
    if (value >= thresholds.good) return tokens.colors.accent.warning
    if (value < 0) return tokens.colors.accent.error
    return tokens.colors.text.secondary
  }

  const hasAnyData =
    metrics.sortino_ratio != null ||
    metrics.calmar_ratio != null ||
    metrics.profit_factor != null ||
    metrics.recovery_factor != null ||
    metrics.max_consecutive_wins != null ||
    metrics.max_consecutive_losses != null ||
    metrics.avg_holding_hours != null ||
    metrics.volatility_pct != null ||
    metrics.downside_volatility_pct != null

  if (isLoading) {
    return (
      <Box
        style={{
          background: `linear-gradient(145deg, ${tokens.colors.bg.secondary} 0%, ${tokens.colors.bg.primary}90 100%)`,
          borderRadius: tokens.radius.xl,
          border: `1px solid ${tokens.colors.border.primary}`,
          padding: tokens.spacing[5],
        }}
      >
        <Box style={{ display: 'flex', gap: tokens.spacing[4], flexWrap: 'wrap' }}>
          {[1, 2, 3, 4].map((i) => (
            <Box
              key={i}
              style={{
                flex: '1 1 calc(50% - 8px)',
                minWidth: 140,
                height: 72,
                background: tokens.colors.bg.tertiary,
                borderRadius: tokens.radius.lg,
                animation: 'pulse 2s infinite',
              }}
            />
          ))}
        </Box>
      </Box>
    )
  }

  return (
    <div
      ref={cardRef}
      style={{
        background: `linear-gradient(145deg, ${tokens.colors.bg.secondary} 0%, ${tokens.colors.bg.primary}90 100%)`,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}`,
        padding: tokens.spacing[5],
        opacity: isVisible ? 1 : 0,
        transform: isVisible ? 'translateY(0)' : 'translateY(20px)',
        transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      {/* Header */}
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[4] }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.primary} strokeWidth="2">
          <path d="M3 3v18h18" />
          <path d="M18.7 8l-5.1 5.2-2.8-2.7L7 14.3" />
        </svg>
        <Text size="md" weight="bold" style={{ color: tokens.colors.text.primary }}>
          {t('advancedMetrics') || 'Advanced Metrics'}
        </Text>
      </Box>

      {/* Primary Metrics Grid */}
      <Box
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: tokens.spacing[3],
          marginBottom: tokens.spacing[4],
          opacity: hasAnyData ? 1 : 0.5,
        }}
      >
        {/* Sortino Ratio */}
        <MetricCard
          label={t('sortinoRatio') || 'Sortino'}
          value={formatRatio(metrics.sortino_ratio)}
          color={getRatioColor(metrics.sortino_ratio, { good: 1, excellent: 2 })}
          tooltip={t('sortinoTooltip') || 'Risk-adjusted return using only downside volatility. Higher is better.'}
          icon={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
            </svg>
          }
        />

        {/* Calmar Ratio */}
        <MetricCard
          label={t('calmarRatio') || 'Calmar'}
          value={formatRatio(metrics.calmar_ratio)}
          color={getRatioColor(metrics.calmar_ratio, { good: 1, excellent: 3 })}
          tooltip={t('calmarTooltip') || 'Annualized return divided by max drawdown. Higher is better.'}
          icon={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
              <polyline points="17 6 23 6 23 12" />
            </svg>
          }
        />

        {/* Profit Factor */}
        <MetricCard
          label={t('profitFactor') || 'Profit Factor'}
          value={formatRatio(metrics.profit_factor)}
          color={getRatioColor(metrics.profit_factor, { good: 1.5, excellent: 2 })}
          tooltip={t('profitFactorTooltip') || 'Gross profit / gross loss. Above 1.5 is good, above 2 is excellent.'}
          icon={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="1" x2="12" y2="23" />
              <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
            </svg>
          }
        />

        {/* Recovery Factor */}
        <MetricCard
          label={t('recoveryFactor') || 'Recovery'}
          value={formatRatio(metrics.recovery_factor)}
          color={getRatioColor(metrics.recovery_factor, { good: 1, excellent: 2 })}
          tooltip={t('recoveryFactorTooltip') || 'Net profit / max drawdown. Shows ability to recover from losses.'}
          icon={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
          }
        />

        {/* Risk/Reward Ratio */}
        {avgProfit != null && avgLoss != null && Math.abs(avgLoss) > 0 && (
          <MetricCard
            label={t('riskReward') || 'Risk/Reward'}
            value={`1:${(avgProfit / Math.abs(avgLoss)).toFixed(1)}`}
            color={
              avgProfit / Math.abs(avgLoss) >= 1.5
                ? tokens.colors.accent.success
                : avgProfit / Math.abs(avgLoss) >= 1
                  ? tokens.colors.accent.warning
                  : tokens.colors.accent.error
            }
            tooltip={t('riskRewardTooltip') || 'Average win / average loss ratio. Above 1.5 is good.'}
            icon={
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
            }
          />
        )}
      </Box>

      {/* Insufficient data note */}
      {!hasAnyData && (
        <Box style={{ marginBottom: tokens.spacing[3], padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`, background: `${tokens.colors.bg.tertiary}80`, borderRadius: tokens.radius.md, border: `1px solid ${tokens.colors.border.primary}40` }}>
          <Text size="xs" style={{ color: tokens.colors.text.tertiary, lineHeight: 1.5 }}>
            {t('metricsInsufficientData') || 'Insufficient trading history to compute these metrics. They will populate as more data becomes available.'}
          </Text>
        </Box>
      )}

      {/* Secondary Metrics */}
      <Box
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: tokens.spacing[2],
          paddingTop: tokens.spacing[3],
          borderTop: `1px solid ${tokens.colors.border.primary}40`,
          opacity: hasAnyData ? 1 : 0.5,
        }}
      >
        {/* Consecutive Wins */}
        <SecondaryBadge
          label={t('maxConsecWins') || 'Max Wins'}
          value={metrics.max_consecutive_wins?.toString() ?? '—'}
          icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>}
          highlight={metrics.max_consecutive_wins !== null && metrics.max_consecutive_wins >= 5}
        />

        {/* Consecutive Losses */}
        <SecondaryBadge
          label={t('maxConsecLosses') || 'Max Losses'}
          value={metrics.max_consecutive_losses?.toString() ?? '—'}
          icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/></svg>}
          negative={metrics.max_consecutive_losses !== null && metrics.max_consecutive_losses >= 5}
        />

        {/* Average Holding Time */}
        <SecondaryBadge
          label={t('avgHolding') || 'Avg Hold'}
          value={formatHours(metrics.avg_holding_hours)}
          icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>}
        />

        {/* Volatility */}
        <SecondaryBadge
          label={t('volatility') || 'Volatility'}
          value={metrics.volatility_pct !== null ? `${metrics.volatility_pct.toFixed(1)}%` : '—'}
          icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="M18.7 8l-5.1 5.2-2.8-2.7L7 14.3"/></svg>}
          negative={metrics.volatility_pct !== null && metrics.volatility_pct > 50}
        />

        {/* Downside Volatility */}
        <SecondaryBadge
          label={t('downsideVol') || 'Downside Vol'}
          value={metrics.downside_volatility_pct !== null ? `${metrics.downside_volatility_pct.toFixed(1)}%` : '—'}
          icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>}
          negative={metrics.downside_volatility_pct !== null && metrics.downside_volatility_pct > 30}
        />
      </Box>

      {/* Largest Win / Loss */}
      {(largestWin != null || largestLoss != null) && (
        <Box
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: tokens.spacing[3],
            paddingTop: tokens.spacing[3],
            borderTop: `1px solid ${tokens.colors.border.primary}40`,
          }}
        >
          {largestWin != null && (
            <Box
              style={{
                padding: tokens.spacing[3],
                background: `${tokens.colors.accent.success}08`,
                borderRadius: tokens.radius.lg,
                border: `1px solid ${tokens.colors.accent.success}15`,
              }}
            >
              <Text
                size="xs"
                style={{
                  color: tokens.colors.text.tertiary,
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  fontSize: 10,
                  fontWeight: 500,
                  marginBottom: 4,
                }}
              >
                {t('largestWin') || 'Largest Win'}
              </Text>
              <Text
                style={{
                  fontSize: 18,
                  fontWeight: 700,
                  color: tokens.colors.accent.success,
                  fontFamily: tokens.typography.fontFamily.mono.join(', '),
                }}
              >
                +${largestWin.toLocaleString(undefined, { maximumFractionDigits: largestWin < 1000 ? 2 : 0 })}
              </Text>
            </Box>
          )}
          {largestLoss != null && (
            <Box
              style={{
                padding: tokens.spacing[3],
                background: `${tokens.colors.accent.error}08`,
                borderRadius: tokens.radius.lg,
                border: `1px solid ${tokens.colors.accent.error}15`,
              }}
            >
              <Text
                size="xs"
                style={{
                  color: tokens.colors.text.tertiary,
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  fontSize: 10,
                  fontWeight: 500,
                  marginBottom: 4,
                }}
              >
                {t('largestLoss') || 'Largest Loss'}
              </Text>
              <Text
                style={{
                  fontSize: 18,
                  fontWeight: 700,
                  color: tokens.colors.accent.error,
                  fontFamily: tokens.typography.fontFamily.mono.join(', '),
                }}
              >
                -${Math.abs(largestLoss).toLocaleString(undefined, { maximumFractionDigits: Math.abs(largestLoss) < 1000 ? 2 : 0 })}
              </Text>
            </Box>
          )}
        </Box>
      )}
    </div>
  )
}

/**
 * Primary metric card component
 */
function MetricCard({
  label,
  value,
  color,
  tooltip,
  icon,
}: {
  label: string
  value: string
  color: string
  tooltip?: string
  icon?: React.ReactNode
}) {
  const isNA = value === '—'

  return (
    <Box
      style={{
        padding: tokens.spacing[3],
        background: tokens.colors.bg.tertiary + '60',
        borderRadius: tokens.radius.lg,
        border: `1px solid ${isNA ? tokens.colors.border.primary : color}20`,
        cursor: tooltip ? 'help' : undefined,
      }}
      title={tooltip}
    >
      <Box style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        {icon && <Box style={{ color: tokens.colors.text.tertiary }}>{icon}</Box>}
        <Text
          size="xs"
          style={{
            color: tokens.colors.text.tertiary,
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            fontSize: 10,
            fontWeight: 500,
          }}
        >
          {label}
        </Text>
      </Box>
      <Text
        style={{
          fontSize: 22,
          fontWeight: 700,
          color: isNA ? tokens.colors.text.tertiary : color,
          fontFamily: tokens.typography.fontFamily.mono.join(', '),
          letterSpacing: '-0.02em',
        }}
      >
        {value}
      </Text>
    </Box>
  )
}

/**
 * Secondary metric badge component
 */
function SecondaryBadge({
  label,
  value,
  icon,
  highlight = false,
  negative = false,
}: {
  label: string
  value: string
  icon?: React.ReactNode
  highlight?: boolean
  negative?: boolean
}) {
  const isNA = value === '—'
  const color = isNA
    ? tokens.colors.text.tertiary
    : highlight
      ? tokens.colors.accent.success
      : negative
        ? tokens.colors.accent.error
        : tokens.colors.text.primary

  return (
    <Box
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: `6px 10px`,
        background: tokens.colors.bg.tertiary,
        borderRadius: tokens.radius.full,
        border: `1px solid ${highlight ? tokens.colors.accent.success + '30' : negative ? tokens.colors.accent.error + '20' : tokens.colors.border.primary}`,
      }}
    >
      {icon && <span style={{ display: 'flex', alignItems: 'center', color: tokens.colors.text.tertiary }}>{icon}</span>}
      <Text style={{ fontSize: 11, color: tokens.colors.text.tertiary, fontWeight: 500 }}>
        {label}
      </Text>
      <Text
        style={{
          fontSize: 12,
          color,
          fontWeight: 600,
          fontFamily: tokens.typography.fontFamily.mono.join(', '),
        }}
      >
        {isNA ? NULL_DISPLAY : value}
      </Text>
    </Box>
  )
}
