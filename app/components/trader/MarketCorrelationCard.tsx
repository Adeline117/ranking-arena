'use client'

import React, { useRef, useState, useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import type { TraderMarketCorrelation, MarketCondition } from '@/lib/types/unified-trader'

export interface MarketCorrelationCardProps {
  correlation: TraderMarketCorrelation
  isLoading?: boolean
}

/**
 * MarketCorrelationCard - Displays market correlation metrics
 *
 * Shows:
 * - Beta (BTC) - correlation with Bitcoin
 * - Beta (ETH) - correlation with Ethereum
 * - Alpha - excess returns vs benchmark
 * - Performance by market condition (bull/bear/sideways)
 */
export default function MarketCorrelationCard({
  correlation,
  isLoading = false,
}: MarketCorrelationCardProps) {
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

  const formatBeta = (value: number | null): string => {
    if (value == null || !isFinite(value)) return '—'
    return value.toFixed(2)
  }

  const formatAlpha = (value: number | null): string => {
    if (value == null || !isFinite(value)) return '—'
    const sign = value >= 0 ? '+' : ''
    return `${sign}${value.toFixed(2)}%`
  }

  const formatConditionPerf = (value: number | null): string => {
    if (value == null || !isFinite(value)) return '—'
    const sign = value >= 0 ? '+' : ''
    return `${sign}${value.toFixed(1)}%`
  }

  const getBetaInterpretation = (beta: number | null): { text: string; color: string } => {
    if (beta === null) return { text: '', color: tokens.colors.text.tertiary }
    if (beta > 1.5) return { text: t('betaHighVolatile') || 'High volatility', color: tokens.colors.accent.warning }
    if (beta > 1) return { text: t('betaAboveMarket') || 'Above market', color: tokens.colors.accent.primary }
    if (beta > 0.5) return { text: t('betaModerate') || 'Moderate', color: tokens.colors.text.secondary }
    if (beta > 0) return { text: t('betaDefensive') || 'Defensive', color: tokens.colors.accent.success }
    if (beta < 0) return { text: t('betaInverse') || 'Inverse correlation', color: tokens.colors.accent.error }
    return { text: t('betaNeutral') || 'Market neutral', color: tokens.colors.text.tertiary }
  }

  const getAlphaColor = (alpha: number | null): string => {
    if (alpha === null) return tokens.colors.text.tertiary
    if (alpha > 10) return tokens.colors.accent.success
    if (alpha > 0) return tokens.colors.accent.warning
    return tokens.colors.accent.error
  }

  const getConditionColor = (perf: number | null): string => {
    if (perf === null) return tokens.colors.text.tertiary
    if (perf > 10) return tokens.colors.accent.success
    if (perf > 0) return tokens.colors.accent.warning
    return tokens.colors.accent.error
  }

  const getConditionIcon = (condition: MarketCondition): React.ReactNode => {
    const iconProps = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2 }
    switch (condition) {
      case 'bull': return (
        <svg {...iconProps} style={{ color: tokens.colors.accent.success }}>
          <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
          <polyline points="17 6 23 6 23 12" />
        </svg>
      )
      case 'bear': return (
        <svg {...iconProps} style={{ color: tokens.colors.accent.error }}>
          <polyline points="23 18 13.5 8.5 8.5 13.5 1 6" />
          <polyline points="17 18 23 18 23 12" />
        </svg>
      )
      case 'sideways': return (
        <svg {...iconProps} style={{ color: tokens.colors.text.tertiary }}>
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
      )
    }
  }

  const getConditionLabel = (condition: MarketCondition): string => {
    switch (condition) {
      case 'bull': return t('bullMarket') || 'Bull Market'
      case 'bear': return t('bearMarket') || 'Bear Market'
      case 'sideways': return t('sidewaysMarket') || 'Sideways'
    }
  }

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
          {[1, 2, 3].map((i) => (
            <Box
              key={i}
              style={{
                flex: '1 1 calc(33% - 12px)',
                minWidth: 100,
                height: 80,
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

  const btcInterpretation = getBetaInterpretation(correlation.beta_btc)
  const ethInterpretation = getBetaInterpretation(correlation.beta_eth)

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
          <circle cx="12" cy="12" r="10" />
          <path d="M2 12h20" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
        <Text size="md" weight="bold" style={{ color: tokens.colors.text.primary }}>
          {t('marketCorrelation') || 'Market Correlation'}
        </Text>
      </Box>

      {/* Beta & Alpha Grid */}
      <Box
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: tokens.spacing[3],
          marginBottom: tokens.spacing[4],
        }}
      >
        {/* Beta BTC */}
        <Box
          style={{
            padding: tokens.spacing[3],
            background: tokens.colors.bg.tertiary + '60',
            borderRadius: tokens.radius.lg,
            border: `1px solid ${tokens.colors.border.primary}`,
            textAlign: 'center',
          }}
        >
          <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, marginBottom: 4 }}>
            <span style={{ fontSize: 16 }}>₿</span>
            <Text size="xs" color="tertiary" style={{ fontWeight: 500 }}>
              Beta (BTC)
            </Text>
          </Box>
          <Text
            style={{
              fontSize: 24,
              fontWeight: 700,
              color: correlation.beta_btc !== null ? tokens.colors.text.primary : tokens.colors.text.tertiary,
              fontFamily: tokens.typography.fontFamily.mono.join(', '),
            }}
          >
            {formatBeta(correlation.beta_btc)}
          </Text>
          {correlation.beta_btc !== null && (
            <Text size="xs" style={{ color: btcInterpretation.color, marginTop: 4 }}>
              {btcInterpretation.text}
            </Text>
          )}
        </Box>

        {/* Beta ETH */}
        <Box
          style={{
            padding: tokens.spacing[3],
            background: tokens.colors.bg.tertiary + '60',
            borderRadius: tokens.radius.lg,
            border: `1px solid ${tokens.colors.border.primary}`,
            textAlign: 'center',
          }}
        >
          <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, marginBottom: 4 }}>
            <span style={{ fontSize: 16 }}>Ξ</span>
            <Text size="xs" color="tertiary" style={{ fontWeight: 500 }}>
              Beta (ETH)
            </Text>
          </Box>
          <Text
            style={{
              fontSize: 24,
              fontWeight: 700,
              color: correlation.beta_eth !== null ? tokens.colors.text.primary : tokens.colors.text.tertiary,
              fontFamily: tokens.typography.fontFamily.mono.join(', '),
            }}
          >
            {formatBeta(correlation.beta_eth)}
          </Text>
          {correlation.beta_eth !== null && (
            <Text size="xs" style={{ color: ethInterpretation.color, marginTop: 4 }}>
              {ethInterpretation.text}
            </Text>
          )}
        </Box>

        {/* Alpha */}
        <Box
          style={{
            padding: tokens.spacing[3],
            background: correlation.alpha !== null && correlation.alpha > 0
              ? `${tokens.colors.accent.success}10`
              : tokens.colors.bg.tertiary + '60',
            borderRadius: tokens.radius.lg,
            border: `1px solid ${correlation.alpha !== null && correlation.alpha > 0 ? tokens.colors.accent.success + '30' : tokens.colors.border.primary}`,
            textAlign: 'center',
          }}
        >
          <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, marginBottom: 4 }}>
            <span style={{ fontSize: 14 }}>α</span>
            <Text size="xs" color="tertiary" style={{ fontWeight: 500 }}>
              Alpha
            </Text>
          </Box>
          <Text
            style={{
              fontSize: 24,
              fontWeight: 700,
              color: getAlphaColor(correlation.alpha),
              fontFamily: tokens.typography.fontFamily.mono.join(', '),
            }}
          >
            {formatAlpha(correlation.alpha)}
          </Text>
          {correlation.alpha !== null && (
            <Text size="xs" style={{ color: tokens.colors.text.tertiary, marginTop: 4 }}>
              {correlation.alpha > 0 ? (t('excessReturns') || 'Excess returns') : (t('underperforming') || 'Below benchmark')}
            </Text>
          )}
        </Box>
      </Box>

      {/* Market Condition Performance */}
      {correlation.market_condition_performance && (
        <Box
          style={{
            paddingTop: tokens.spacing[3],
            borderTop: `1px solid ${tokens.colors.border.primary}40`,
          }}
        >
          <Text size="xs" color="tertiary" weight="bold" style={{ marginBottom: tokens.spacing[3], textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            {t('performanceByCondition') || 'Performance by Market Condition'}
          </Text>
          <Box style={{ display: 'flex', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
            {(['bull', 'bear', 'sideways'] as MarketCondition[]).map((condition) => {
              const perf = correlation.market_condition_performance[condition]
              return (
                <Box
                  key={condition}
                  style={{
                    flex: '1 1 calc(33% - 8px)',
                    minWidth: 90,
                    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                    background: tokens.colors.bg.tertiary,
                    borderRadius: tokens.radius.md,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center' }}>{getConditionIcon(condition)}</span>
                  <Box>
                    <Text size="xs" color="tertiary" style={{ fontSize: 10 }}>
                      {getConditionLabel(condition)}
                    </Text>
                    <Text
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: getConditionColor(perf),
                        fontFamily: tokens.typography.fontFamily.mono.join(', '),
                      }}
                    >
                      {formatConditionPerf(perf)}
                    </Text>
                  </Box>
                </Box>
              )
            })}
          </Box>
        </Box>
      )}
    </div>
  )
}
