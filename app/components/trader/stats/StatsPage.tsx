'use client'

import { useState, useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../../base'
import type { TraderStats } from '@/lib/data/trader'
import { useLanguage } from '../../Providers/LanguageProvider'
import {
  TradingSection,
  EquityCurveSection,
  ComparePortfolioSection,
  BreakdownSection,
} from './components'
import { SectionErrorBoundary } from '../../utils/ErrorBoundary'
import { PnlCalendarHeatmap } from '../charts/PnlCalendarHeatmap'

// 扩展类型以支持新数据
interface AssetBreakdownData {
  '90D': Array<{ symbol: string; weightPct: number }>
  '30D': Array<{ symbol: string; weightPct: number }>
  '7D': Array<{ symbol: string; weightPct: number }>
}

interface EquityCurveData {
  '90D': Array<{ date: string; roi: number; pnl: number }>
  '30D': Array<{ date: string; roi: number; pnl: number }>
  '7D': Array<{ date: string; roi: number; pnl: number }>
}

interface PositionHistoryItem {
  symbol: string
  direction: string
  positionType: string
  marginMode: string
  openTime: string
  closeTime: string
  entryPrice: number
  exitPrice: number
  maxPositionSize: number
  closedSize: number
  pnlUsd: number
  pnlPct: number
  status: string
}

interface ExtendedStatsPageProps {
  stats: TraderStats
  traderHandle: string
  assetBreakdown?: AssetBreakdownData
  equityCurve?: EquityCurveData
  positionHistory?: PositionHistoryItem[]
  isPro?: boolean
  onUnlock?: () => void
}

export default function StatsPage({
  stats,
  traderHandle,
  assetBreakdown,
  equityCurve,
  positionHistory = [],
  isPro = true,
  onUnlock,
}: ExtendedStatsPageProps) {
  const { t, language } = useLanguage()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  // UF10: Skeleton placeholder while chart is loading
  if (!mounted) {
    return (
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
        {/* Breakdown skeleton */}
        <Box style={{
          height: 200, borderRadius: tokens.radius.xl,
          background: `linear-gradient(90deg, ${tokens.colors.bg.secondary} 25%, ${tokens.colors.bg.tertiary} 50%, ${tokens.colors.bg.secondary} 75%)`,
          backgroundSize: '200% 100%',
          animation: 'statsSkeletonPulse 1.5s ease-in-out infinite',
        }} />
        {/* Chart skeletons */}
        <Box style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.spacing[6] }}>
          {[1, 2].map(i => (
            <Box key={i} style={{
              height: 280, borderRadius: tokens.radius.xl,
              background: `linear-gradient(90deg, ${tokens.colors.bg.secondary} 25%, ${tokens.colors.bg.tertiary} 50%, ${tokens.colors.bg.secondary} 75%)`,
              backgroundSize: '200% 100%',
              animation: 'statsSkeletonPulse 1.5s ease-in-out infinite',
              animationDelay: `${i * 0.2}s`,
            }} />
          ))}
        </Box>
        {/* Trading section skeleton */}
        <Box style={{
          height: 300, borderRadius: tokens.radius.xl,
          background: `linear-gradient(90deg, ${tokens.colors.bg.secondary} 25%, ${tokens.colors.bg.tertiary} 50%, ${tokens.colors.bg.secondary} 75%)`,
          backgroundSize: '200% 100%',
          animation: 'statsSkeletonPulse 1.5s ease-in-out infinite',
          animationDelay: '0.4s',
        }} />
        {/* statsSkeletonPulse keyframes moved to globals.css (#26) */}
      </Box>
    )
  }

  const frequentlyTraded = stats.frequentlyTraded || []
  const trading = stats.trading
  const additionalStats = stats.additionalStats

  return (
    <Box
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacing[6],
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(20px)',
        transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
        position: 'relative',
      }}
    >
      {/* Pro Lock Overlay - shows UI but blurs content */}
      {!isPro && (
        <Box
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <Box
            style={{
              background: `linear-gradient(135deg, ${tokens.colors.bg.primary}F0, ${tokens.colors.bg.secondary}E8)`,
              backdropFilter: tokens.glass.blur.xs,
              WebkitBackdropFilter: tokens.glass.blur.xs,
              borderRadius: tokens.radius.xl,
              padding: tokens.spacing[6],
              border: `1px solid ${tokens.colors.accent.primary}40`,
              boxShadow: `0 8px 32px var(--color-accent-primary-20)`,
              textAlign: 'center',
              pointerEvents: 'auto',
              maxWidth: 360,
            }}
          >
            <Box style={{
              width: 48,
              height: 48,
              borderRadius: tokens.radius.full,
              background: `linear-gradient(135deg, ${tokens.colors.accent.primary}30, ${tokens.colors.accent.brand}20)`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto',
              marginBottom: tokens.spacing[4],
            }}>
              <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.primary} strokeWidth="2">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </Box>
            <Text size="lg" weight="bold" style={{ color: tokens.colors.text.primary, marginBottom: tokens.spacing[2] }}>
              {t('unlockFullStatistics')}
            </Text>
            <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[4] }}>
              {t('upgradeProStatsDesc')}
            </Text>
            {onUnlock && (
              <button
                onClick={onUnlock}
                style={{
                  padding: `${tokens.spacing[3]} ${tokens.spacing[6]}`,
                  borderRadius: tokens.radius.lg,
                  border: 'none',
                  background: `linear-gradient(135deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.brand})`,
                  color: tokens.colors.white,
                  fontWeight: tokens.typography.fontWeight.bold,
                  fontSize: tokens.typography.fontSize.sm,
                  cursor: 'pointer',
                  transition: 'all 0.25s ease',
                  fontFamily: tokens.typography.fontFamily.sans.join(', '),
                }}
              >
                {t('upgradeToPro')}
              </button>
            )}
          </Box>
        </Box>
      )}

      {/* Content with blur when not Pro */}
      <Box style={{ filter: isPro ? 'none' : 'blur(3px)', pointerEvents: isPro ? 'auto' : 'none' }}>
        {/* Asset Breakdown - 没数据时自动隐藏 */}
        <BreakdownSection
          assetBreakdown={assetBreakdown}
          fallbackData={frequentlyTraded}
          delay={0}
        />

        {/* PnL Calendar Heatmap — daily profit/loss visualization */}
        {equityCurve?.['90D'] && equityCurve['90D'].length > 3 && (
          <Box
            className="glass-card"
            style={{
              padding: tokens.spacing[5],
              background: `linear-gradient(145deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.primary}F0 100%)`,
              borderRadius: tokens.radius.xl,
              border: `1px solid ${tokens.colors.border.primary}60`,
              marginTop: tokens.spacing[6],
            }}
          >
            <PnlCalendarHeatmap data={equityCurve['90D']} days={90} />
          </Box>
        )}

        {/* Chart + Compare Two Columns - 没数据时各自隐藏 */}
        <Box className="stats-two-col" style={{ display: 'grid', gap: tokens.spacing[6], marginTop: tokens.spacing[6] }}>
          <SectionErrorBoundary fallbackMessage="">
            <EquityCurveSection equityCurve={equityCurve} traderHandle={traderHandle} delay={0.1} />
          </SectionErrorBoundary>
          <SectionErrorBoundary fallbackMessage="">
            <ComparePortfolioSection traderHandle={traderHandle} equityCurve={equityCurve} delay={0.15} />
          </SectionErrorBoundary>
        </Box>

        {/* Trading Section - 没数据时自动隐藏 */}
        <Box style={{ marginTop: tokens.spacing[6] }}>
          <TradingSection
            trading={trading}
            additionalStats={additionalStats}
            positionHistory={positionHistory}
            t={t}
            delay={0.2}
          />
        </Box>
      </Box>

      {/* stats-two-col / trading-grid responsive rules moved to globals.css (#26) */}
    </Box>
  )
}
