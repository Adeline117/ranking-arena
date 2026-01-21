'use client'

import { ReactNode } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import PremiumGate, { ProLabel } from '../premium/PremiumGate'

// Icons
const ChartIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3 3v18h18" />
    <path d="M18 17l-5-5-4 4-5-5" />
  </svg>
)

const TrendUpIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M23 6l-9.5 9.5-5-5L1 18" />
    <path d="M17 6h6v6" />
  </svg>
)

const TrendDownIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M23 18l-9.5-9.5-5 5L1 6" />
    <path d="M17 18h6v-6" />
  </svg>
)

const ShieldIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
)

const InfoIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4M12 8h.01" />
  </svg>
)

interface ContributionItem {
  label: string
  value: number
  percentage: number
  color: string
  description?: string
}

interface DetailedExplanationProps {
  isPro: boolean
  isLoggedIn?: boolean
  /** Trader's Arena Score */
  arenaScore?: number
  /** Score breakdown */
  returnScore?: number
  drawdownScore?: number
  stabilityScore?: number
  /** Performance metrics */
  roi?: number
  pnl?: number
  winRate?: number
  maxDrawdown?: number
  /** Historical comparison */
  roiChange7d?: number
  roiChange30d?: number
  rankChange7d?: number
  /** Risk metrics */
  sharpeRatio?: number
  sortinoRatio?: number
  calmarRatio?: number
  volatility?: number
}

/**
 * Detailed Explanation Panel (Pro Only)
 * Shows contribution breakdown, change attribution, and risk decomposition
 */
export default function DetailedExplanation({
  isPro,
  isLoggedIn = true,
  arenaScore,
  returnScore,
  drawdownScore,
  stabilityScore,
  roi,
  pnl,
  winRate,
  maxDrawdown,
  roiChange7d,
  roiChange30d,
  rankChange7d,
  sharpeRatio,
  sortinoRatio,
  calmarRatio,
  volatility,
}: DetailedExplanationProps) {
  const { t, language } = useLanguage()

  // Placeholder data for demo
  const contributions: ContributionItem[] = [
    {
      label: language === 'zh' ? '收益贡献' : 'Return Contribution',
      value: returnScore ?? 0,
      percentage: arenaScore ? ((returnScore ?? 0) / arenaScore) * 100 : 85,
      color: tokens.colors.accent.success,
      description: language === 'zh' ? '基于 ROI 表现计算' : 'Based on ROI performance',
    },
    {
      label: language === 'zh' ? '回撤控制' : 'Drawdown Control',
      value: drawdownScore ?? 0,
      percentage: arenaScore ? ((drawdownScore ?? 0) / arenaScore) * 100 : 8,
      color: tokens.colors.accent.warning,
      description: language === 'zh' ? '回撤越小得分越高' : 'Lower drawdown = higher score',
    },
    {
      label: language === 'zh' ? '稳定性' : 'Stability',
      value: stabilityScore ?? 0,
      percentage: arenaScore ? ((stabilityScore ?? 0) / arenaScore) * 100 : 7,
      color: tokens.colors.accent.primary,
      description: language === 'zh' ? '基于胜率计算' : 'Based on win rate',
    },
  ]

  const content = (
    <Box
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacing[6],
      }}
    >
      {/* Section: Contribution Breakdown */}
      <Box>
        <Box
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[2],
            marginBottom: tokens.spacing[4],
          }}
        >
          <ChartIcon size={18} />
          <Text size="md" weight="bold">
            {t('contributionBreakdown')}
          </Text>
          <ProLabel size="xs" />
        </Box>

        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
          {contributions.map((item) => (
            <Box key={item.label}>
              <Box
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: tokens.spacing[1],
                }}
              >
                <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                  <Text size="sm" weight="semibold">
                    {item.label}
                  </Text>
                  {item.description && (
                    <Box
                      title={item.description}
                      style={{ cursor: 'help', color: tokens.colors.text.tertiary }}
                    >
                      <InfoIcon size={12} />
                    </Box>
                  )}
                </Box>
                <Text size="sm" weight="bold" style={{ color: item.color }}>
                  {item.value.toFixed(1)} ({item.percentage.toFixed(0)}%)
                </Text>
              </Box>
              <Box
                style={{
                  height: 6,
                  borderRadius: tokens.radius.full,
                  background: tokens.colors.bg.tertiary,
                  overflow: 'hidden',
                }}
              >
                <Box
                  style={{
                    height: '100%',
                    width: `${item.percentage}%`,
                    borderRadius: tokens.radius.full,
                    background: item.color,
                    transition: 'width 0.5s ease',
                  }}
                />
              </Box>
            </Box>
          ))}
        </Box>

        {/* Total */}
        <Box
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: tokens.spacing[4],
            paddingTop: tokens.spacing[3],
            borderTop: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          <Text size="sm" weight="bold">
            {language === 'zh' ? '总分' : 'Total Score'}
          </Text>
          <Text size="lg" weight="black" style={{ color: tokens.colors.accent.primary }}>
            {arenaScore?.toFixed(1) ?? '—'}
          </Text>
        </Box>
      </Box>

      {/* Section: Change Attribution */}
      <Box>
        <Box
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[2],
            marginBottom: tokens.spacing[4],
          }}
        >
          <TrendUpIcon size={18} />
          <Text size="md" weight="bold">
            {t('changeAttribution')}
          </Text>
          <ProLabel size="xs" />
        </Box>

        <Box
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: tokens.spacing[3],
          }}
        >
          <ChangeCard
            label={language === 'zh' ? '7天ROI变化' : '7D ROI Change'}
            value={roiChange7d}
            isPercentage
          />
          <ChangeCard
            label={language === 'zh' ? '30天ROI变化' : '30D ROI Change'}
            value={roiChange30d}
            isPercentage
          />
          <ChangeCard
            label={language === 'zh' ? '7天排名变化' : '7D Rank Change'}
            value={rankChange7d}
            inverted // Lower is better for rank
          />
          <ChangeCard
            label={language === 'zh' ? '胜率' : 'Win Rate'}
            value={winRate}
            isPercentage
            neutral
          />
        </Box>
      </Box>

      {/* Section: Risk Decomposition */}
      <Box>
        <Box
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[2],
            marginBottom: tokens.spacing[4],
          }}
        >
          <ShieldIcon size={18} />
          <Text size="md" weight="bold">
            {t('riskDecomposition')}
          </Text>
          <ProLabel size="xs" />
        </Box>

        <Box
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: tokens.spacing[3],
          }}
        >
          <RiskMetricCard
            label={language === 'zh' ? '夏普比率' : 'Sharpe Ratio'}
            value={sharpeRatio}
            description={language === 'zh' ? '风险调整收益，>1 为佳' : 'Risk-adjusted return, >1 is good'}
            threshold={1}
          />
          <RiskMetricCard
            label={language === 'zh' ? '索提诺比率' : 'Sortino Ratio'}
            value={sortinoRatio}
            description={language === 'zh' ? '仅考虑下行风险，>1.5 为佳' : 'Downside risk only, >1.5 is good'}
            threshold={1.5}
          />
          <RiskMetricCard
            label={language === 'zh' ? '卡尔马比率' : 'Calmar Ratio'}
            value={calmarRatio}
            description={language === 'zh' ? '收益/最大回撤，>1 为佳' : 'Return/Max DD, >1 is good'}
            threshold={1}
          />
          <RiskMetricCard
            label={language === 'zh' ? '波动率' : 'Volatility'}
            value={volatility}
            description={language === 'zh' ? '收益波动程度，越低越稳定' : 'Return volatility, lower is more stable'}
            threshold={30}
            inverted
            isPercentage
          />
        </Box>
      </Box>
    </Box>
  )

  return (
    <PremiumGate
      isPro={isPro}
      isLoggedIn={isLoggedIn}
      featureName={t('detailedExplanation')}
      blurAmount={10}
      minHeight={400}
    >
      {content}
    </PremiumGate>
  )
}

/**
 * Change Card Component
 */
function ChangeCard({
  label,
  value,
  isPercentage = false,
  inverted = false,
  neutral = false,
}: {
  label: string
  value?: number
  isPercentage?: boolean
  inverted?: boolean
  neutral?: boolean
}) {
  const isPositive = value !== undefined ? (inverted ? value < 0 : value > 0) : false
  const isNegative = value !== undefined ? (inverted ? value > 0 : value < 0) : false

  const color = neutral
    ? tokens.colors.text.primary
    : isPositive
    ? tokens.colors.accent.success
    : isNegative
    ? tokens.colors.accent.error
    : tokens.colors.text.secondary

  return (
    <Box
      style={{
        padding: tokens.spacing[3],
        borderRadius: tokens.radius.lg,
        background: tokens.glass.bg.light,
        border: tokens.glass.border.light,
      }}
    >
      <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
        {label}
      </Text>
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}>
        {value !== undefined && !neutral && (
          isPositive ? <TrendUpIcon size={14} /> : isNegative ? <TrendDownIcon size={14} /> : null
        )}
        <Text size="md" weight="bold" style={{ color }}>
          {value !== undefined
            ? `${!neutral && value > 0 ? '+' : ''}${value.toFixed(isPercentage ? 1 : 0)}${isPercentage ? '%' : ''}`
            : '—'}
        </Text>
      </Box>
    </Box>
  )
}

/**
 * Risk Metric Card Component
 */
function RiskMetricCard({
  label,
  value,
  description,
  threshold,
  inverted = false,
  isPercentage = false,
}: {
  label: string
  value?: number
  description: string
  threshold: number
  inverted?: boolean
  isPercentage?: boolean
}) {
  const isGood = value !== undefined ? (inverted ? value < threshold : value >= threshold) : false

  return (
    <Box
      style={{
        padding: tokens.spacing[3],
        borderRadius: tokens.radius.lg,
        background: tokens.glass.bg.light,
        border: `1px solid ${isGood ? tokens.colors.accent.success + '30' : tokens.colors.border.primary}`,
      }}
    >
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: tokens.spacing[1],
        }}
      >
        <Text size="xs" weight="semibold">
          {label}
        </Text>
        {isGood && (
          <Box
            style={{
              width: 6,
              height: 6,
              borderRadius: tokens.radius.full,
              background: tokens.colors.accent.success,
            }}
          />
        )}
      </Box>
      <Text
        size="lg"
        weight="bold"
        style={{
          color: isGood ? tokens.colors.accent.success : tokens.colors.text.primary,
          marginBottom: tokens.spacing[1],
        }}
      >
        {value !== undefined ? `${value.toFixed(2)}${isPercentage ? '%' : ''}` : '—'}
      </Text>
      <Text size="xs" color="tertiary" style={{ lineHeight: 1.4 }}>
        {description}
      </Text>
    </Box>
  )
}

/**
 * Simple Pro Feature Teaser
 * Shows a blurred preview with upgrade prompt
 */
export function ProFeatureTeaser({
  title,
  description,
  children,
  isPro,
  isLoggedIn = true,
}: {
  title: string
  description?: string
  children: ReactNode
  isPro: boolean
  isLoggedIn?: boolean
}) {
  return (
    <PremiumGate
      isPro={isPro}
      isLoggedIn={isLoggedIn}
      featureName={title}
      customMessage={description}
      blurAmount={8}
    >
      {children}
    </PremiumGate>
  )
}
