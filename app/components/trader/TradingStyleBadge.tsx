'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import type { TradingStyle } from '@/lib/types/trader'

export interface TradingStyleBadgeProps {
  style: TradingStyle | null
  confidence?: number | null
  size?: 'sm' | 'md' | 'lg'
  showConfidence?: boolean
  showTooltip?: boolean
}

interface StyleConfig {
  label: string
  labelZh: string
  color: string
  bgColor: string
  description: string
  descriptionZh: string
}

// SVG icon components for each trading style
function getStyleIcon(style: TradingStyle, size: number = 14): React.ReactNode {
  const props = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2 }
  switch (style) {
    case 'hft':
      return <svg {...props}><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
    case 'scalping':
      return <svg {...props}><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>
    case 'day_trader':
      return <svg {...props}><path d="M3 3v18h18"/><path d="M18.7 8l-5.1 5.2-2.8-2.7L7 14.3"/></svg>
    case 'swing':
      return <svg {...props}><path d="M2 12c0-3.5 2.5-6 6-6 4.5 0 4.5 6 9 6 3.5 0 5-2.5 5-6"/><path d="M2 18c0-3.5 2.5-6 6-6 4.5 0 4.5 6 9 6 3.5 0 5-2.5 5-6"/></svg>
    case 'trend':
      return <svg {...props}><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
  }
}

const STYLE_CONFIGS: Record<TradingStyle, StyleConfig> = {
  hft: {
    label: 'HFT',
    labelZh: '高频交易',
    color: 'var(--color-accent-error)',
    bgColor: 'var(--color-accent-error-10)',
    description: 'High-frequency trader with very short holding times',
    descriptionZh: '高频交易者，持仓时间极短',
  },
  scalping: {
    label: 'Scalper',
    labelZh: '剥头皮',
    color: 'var(--color-chart-teal)',
    bgColor: 'var(--color-accent-success-10)',
    description: 'Quick trades for small, consistent profits',
    descriptionZh: '快速交易，获取小额稳定利润',
  },
  day_trader: {
    label: 'Day Trader',
    labelZh: '日内交易',
    color: 'var(--color-chart-blue)',
    bgColor: 'var(--color-accent-primary-15)',
    description: 'Intraday positions, closes before market close',
    descriptionZh: '日内持仓，当日平仓',
  },
  swing: {
    label: 'Swing Trader',
    labelZh: '波段交易',
    color: 'var(--color-chart-sage)',
    bgColor: 'var(--color-accent-success-10)',
    description: 'Multi-day to multi-week positions',
    descriptionZh: '中长期持仓，数天到数周',
  },
  trend: {
    label: 'Trend Follower',
    labelZh: '趋势跟随',
    color: 'var(--color-chart-pink)',
    bgColor: 'var(--color-accent-primary-15)',
    description: 'Long-term positions following market trends',
    descriptionZh: '长期跟随市场趋势',
  },
}

/**
 * TradingStyleBadge - Displays trader's classified trading style
 *
 * Shows the trading style (HFT, Scalping, Day Trading, Swing, Trend)
 * with an icon and optional confidence score.
 */
export default function TradingStyleBadge({
  style,
  confidence = null,
  size = 'md',
  showConfidence = true,
  showTooltip = true,
}: TradingStyleBadgeProps) {
  const { language } = useLanguage()

  if (!style) {
    return null
  }

  const config = STYLE_CONFIGS[style]
  if (!config) return null

  const sizeStyles = {
    sm: {
      padding: '4px 8px',
      fontSize: 11,
      iconSize: 12,
      gap: 4,
    },
    md: {
      padding: '6px 12px',
      fontSize: 13,
      iconSize: 14,
      gap: 6,
    },
    lg: {
      padding: '8px 16px',
      fontSize: 16,
      iconSize: 18,
      gap: 8,
    },
  }

  const s = sizeStyles[size]
  const label = language === 'zh' ? config.labelZh : config.label
  const description = language === 'zh' ? config.descriptionZh : config.description

  return (
    <Box
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: s.gap,
        padding: s.padding,
        background: config.bgColor,
        borderRadius: tokens.radius.full,
        border: `1px solid ${config.color}30`,
        cursor: showTooltip ? 'help' : undefined,
      }}
      title={showTooltip ? description : undefined}
    >
      <span style={{ display: 'flex', alignItems: 'center', color: config.color }}>{getStyleIcon(style)}</span>
      <Text
        style={{
          fontSize: s.fontSize,
          fontWeight: 600,
          color: config.color,
        }}
      >
        {label}
      </Text>
      {showConfidence && confidence !== null && (
        <Box
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            marginLeft: 2,
            padding: '2px 6px',
            background: tokens.colors.bg.primary + '80',
            borderRadius: tokens.radius.full,
          }}
        >
          <ConfidenceIndicator confidence={confidence} />
          <Text
            style={{
              fontSize: s.fontSize - 2,
              color: tokens.colors.text.tertiary,
              fontFamily: tokens.typography.fontFamily.mono.join(', '),
            }}
          >
            {confidence}%
          </Text>
        </Box>
      )}
    </Box>
  )
}

/**
 * Confidence indicator dots
 */
function ConfidenceIndicator({ confidence }: { confidence: number }) {
  const level = confidence >= 80 ? 3 : confidence >= 50 ? 2 : 1
  const colors = [
    tokens.colors.accent.error,
    tokens.colors.accent.warning,
    tokens.colors.accent.success,
  ]

  return (
    <Box style={{ display: 'flex', gap: 2 }}>
      {[1, 2, 3].map((i) => (
        <Box
          key={i}
          style={{
            width: 4,
            height: 4,
            borderRadius: '50%',
            background: i <= level ? colors[level - 1] : tokens.colors.bg.tertiary,
          }}
        />
      ))}
    </Box>
  )
}

/**
 * Compact version for table/list display
 */
export function TradingStyleIcon({ style }: { style: TradingStyle | null }) {
  if (!style) return null
  const config = STYLE_CONFIGS[style]
  if (!config) return null

  return (
    <span
      title={config.label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        color: config.color,
        cursor: 'help',
      }}
    >
      {getStyleIcon(style, 16)}
    </span>
  )
}

/**
 * Full card version with description
 */
export function TradingStyleCard({
  style,
  confidence,
  assetPreference,
}: {
  style: TradingStyle | null
  confidence?: number | null
  assetPreference?: string[]
}) {
  const { t, language } = useLanguage()

  if (!style) {
    return (
      <Box
        style={{
          padding: tokens.spacing[4],
          background: tokens.colors.bg.tertiary + '40',
          borderRadius: tokens.radius.lg,
          border: `1px solid ${tokens.colors.border.primary}`,
          textAlign: 'center',
        }}
      >
        <Text size="sm" color="tertiary">
          {t('styleNotClassified') || 'Trading style not yet classified'}
        </Text>
      </Box>
    )
  }

  const config = STYLE_CONFIGS[style]
  const description = language === 'zh' ? config.descriptionZh : config.description

  return (
    <Box
      style={{
        padding: tokens.spacing[4],
        background: config.bgColor,
        borderRadius: tokens.radius.lg,
        border: `1px solid ${config.color}30`,
      }}
    >
      <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens.spacing[3] }}>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <span style={{ display: 'flex', alignItems: 'center', color: config.color }}>{getStyleIcon(style, 24)}</span>
          <Box>
            <Text size="lg" weight="bold" style={{ color: config.color }}>
              {language === 'zh' ? config.labelZh : config.label}
            </Text>
            {confidence !== null && (
              <Text size="xs" color="tertiary">
                {t('confidence') || 'Confidence'}: {confidence}%
              </Text>
            )}
          </Box>
        </Box>
        {confidence != null && (
          <ConfidenceMeter confidence={confidence} color={config.color} />
        )}
      </Box>

      <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[3] }}>
        {description}
      </Text>

      {assetPreference && assetPreference.length > 0 && (
        <Box>
          <Text size="xs" color="tertiary" weight="bold" style={{ marginBottom: 6 }}>
            {t('preferredAssets') || 'Preferred Assets'}
          </Text>
          <Box style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {assetPreference.slice(0, 5).map((asset) => (
              <Box
                key={asset}
                style={{
                  padding: '4px 8px',
                  background: tokens.colors.bg.primary + '80',
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                }}
              >
                <Text size="xs" weight="bold" style={{ fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
                  {asset}
                </Text>
              </Box>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  )
}

/**
 * Confidence meter component
 */
function ConfidenceMeter({ confidence, color }: { confidence: number; color: string }) {
  return (
    <Box style={{ width: 60, height: 60, position: 'relative' }}>
      <svg width="60" height="60" viewBox="0 0 60 60">
        <circle
          cx="30"
          cy="30"
          r="25"
          fill="none"
          stroke={tokens.colors.bg.tertiary}
          strokeWidth="6"
        />
        <circle
          cx="30"
          cy="30"
          r="25"
          fill="none"
          stroke={color}
          strokeWidth="6"
          strokeDasharray={`${(confidence / 100) * 157} 157`}
          strokeLinecap="round"
          transform="rotate(-90 30 30)"
          style={{ transition: 'stroke-dasharray 1s ease' }}
        />
      </svg>
      <Box
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text
          style={{
            fontSize: 14,
            fontWeight: 700,
            color,
            fontFamily: tokens.typography.fontFamily.mono.join(', '),
          }}
        >
          {confidence}
        </Text>
      </Box>
    </Box>
  )
}
