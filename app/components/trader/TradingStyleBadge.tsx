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
    case 'scalper':
      return <svg {...props}><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
    case 'swing':
      return <svg {...props}><path d="M2 12c0-3.5 2.5-6 6-6 4.5 0 4.5 6 9 6 3.5 0 5-2.5 5-6"/><path d="M2 18c0-3.5 2.5-6 6-6 4.5 0 4.5 6 9 6 3.5 0 5-2.5 5-6"/></svg>
    case 'trend':
      return <svg {...props}><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
    case 'position':
      return <svg {...props}><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>
    case 'unknown':
      return <svg {...props}><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
  }
}

const STYLE_CONFIGS: Record<TradingStyle, StyleConfig> = {
  scalper: {
    label: 'Scalper',
    labelZh: '超短线',
    color: 'var(--color-accent-error)',
    bgColor: 'var(--color-accent-error-10)',
    description: 'High-frequency trading with very short holding periods',
    descriptionZh: '高频交易，持仓时间极短',
  },
  swing: {
    label: 'Swing',
    labelZh: '波段',
    color: 'var(--color-chart-blue)',
    bgColor: 'var(--color-accent-primary-15)',
    description: 'Medium-term trades, holding 4-48 hours',
    descriptionZh: '中期波段，持仓4-48小时',
  },
  trend: {
    label: 'Trend',
    labelZh: '趋势',
    color: 'var(--color-chart-teal)',
    bgColor: 'var(--color-accent-success-10)',
    description: 'Trend following with positions lasting days to weeks',
    descriptionZh: '趋势跟踪，持仓数天到数周',
  },
  position: {
    label: 'Position',
    labelZh: '长线',
    color: 'var(--color-accent-warning)',
    bgColor: 'var(--color-accent-warning-10)',
    description: 'Long-term holding, over 2 weeks',
    descriptionZh: '长线持仓，超过两周',
  },
  unknown: {
    label: 'Unknown',
    labelZh: '未知',
    color: 'var(--color-text-tertiary)',
    bgColor: 'var(--color-bg-tertiary)',
    description: 'Trading style not yet classified',
    descriptionZh: '交易风格尚未分类',
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
  const { t } = useLanguage()

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
  const label = t('tradingStyle' + style.charAt(0).toUpperCase() + style.slice(1)) || config.label
  const description = t('tradingStyle' + style.charAt(0).toUpperCase() + style.slice(1) + 'Desc') || config.description

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
  const { t, language: _language } = useLanguage()

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
  const description = t('tradingStyle' + style.charAt(0).toUpperCase() + style.slice(1) + 'Desc') || config.description

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
              {t('tradingStyle' + style.charAt(0).toUpperCase() + style.slice(1)) || config.label}
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
