'use client'

/**
 * OverviewTab — extracted from TraderProfileClient.tsx to isolate
 * reconciliation scope. SWR revalidations on stats/portfolio no longer
 * trigger a re-render of this subtree (and vice-versa).
 */

import React from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { tokens } from '@/lib/design-tokens'
import { SectionErrorBoundary } from '@/app/components/utils/ErrorBoundary'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { Box, Text } from '@/app/components/base'
import OverviewPerformanceCard, { type ExtendedPerformance } from '@/app/components/trader/OverviewPerformanceCard'
import { ChartSkeleton } from '@/app/components/ui/Skeleton'
import { features } from '@/lib/features'
import type { TraderProfile } from '@/lib/data/trader'
import type { UnregisteredTraderData } from '@/app/(app)/trader/[handle]/TraderProfileClient'

const AdvancedMetricsCard = dynamic(() => import('@/app/components/trader/AdvancedMetricsCard'), { ssr: false })
const DailyReturnsChart = dynamic(() => import('@/app/components/trader/charts/DailyReturnsChart').then(m => ({ default: m.DailyReturnsChart })), {
  ssr: false,
  loading: () => <ChartSkeleton variant="bar" />,
})
const DrawdownChart = dynamic(() => import('@/app/components/trader/charts/DrawdownChart').then(m => ({ default: m.DrawdownChart })), {
  ssr: false,
  loading: () => <ChartSkeleton />,
})
const EquityCurveSection = dynamic(() => import('@/app/components/trader/stats/components/EquityCurveSection').then(m => ({ default: m.EquityCurveSection })), {
  ssr: false,
  loading: () => <ChartSkeleton />,
})
const TradingStyleRadar = dynamic(() => import('@/app/components/trader/TradingStyleRadar'), {
  ssr: false,
  loading: () => <ChartSkeleton showTitle={false} height={260} />,
})
const SimilarTraders = dynamic(() => import('@/app/components/trader/SimilarTraders'), { ssr: false })
const CopyTradeSimulator = dynamic(() => import('@/app/components/trader/CopyTradeSimulator'), { ssr: false })
const ClaimTraderButton = dynamic(() => import('@/app/components/trader/ClaimTraderButton'), { ssr: false })
const VerifiedTraderEditor = dynamic(() => import('@/app/components/trader/VerifiedTraderEditor'), { ssr: false })
const AggregatedStats = dynamic(() => import('@/app/components/trader/AggregatedStats'), { ssr: false })

// Re-use the exact types from useLinkedAccounts / AggregatedStats to avoid
// conversion errors at the call-site.
import type { LinkedAccountData, AggregatedData } from '@/lib/hooks/useLinkedAccounts'

export interface OverviewTabProps {
  // From server/initial data
  data: UnregisteredTraderData

  // From SWR trader data (memoized slices)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- data blob from SWR, typed generically at shell level
  traderProfile: any
  traderPerformance: any
  traderEquityCurve: Record<string, Array<{ date: string; roi: number; pnl: number }>> | undefined
  traderSimilar: (TraderProfile & { roi_90d?: number; arena_score?: number })[]
  positionSummary: { avgLeverage: number | null; longPositions: number | null; shortPositions: number | null } | null | undefined

  // Period
  selectedPeriod: string

  // Multi-account
  hasMultipleAccounts: boolean
  activeAccount: string
  aggregatedData: AggregatedData | null
  linkedAccounts: LinkedAccountData[]

  // Auth/claim state
  currentUserId: string | null
  isOwner: boolean
  isVerifiedTrader: boolean
  claimedUser: { handle: string } | null | undefined
}

const OverviewTab = React.memo(function OverviewTab({
  data,
  traderProfile,
  traderPerformance,
  traderEquityCurve,
  traderSimilar,
  positionSummary,
  selectedPeriod,
  hasMultipleAccounts,
  activeAccount,
  aggregatedData,
  linkedAccounts,
  currentUserId,
  isOwner,
  isVerifiedTrader,
  claimedUser,
}: OverviewTabProps) {
  const { t } = useLanguage()

  return (
    <Box
      className="profile-grid"
      style={{
        display: 'grid',
        gridTemplateColumns: traderSimilar.length > 0 ? '1fr 300px' : '1fr',
        gap: tokens.spacing[6],
      }}
    >
      <Box className="stagger-enter" style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
        {/* Aggregated stats card (only when "All" tab is active and user has 2+ accounts) */}
        {hasMultipleAccounts && activeAccount === 'all' && aggregatedData && (
          <AggregatedStats
            combinedPnl={aggregatedData.combinedPnl}
            bestRoi={aggregatedData.bestRoi}
            weightedScore={aggregatedData.weightedScore}
            accounts={linkedAccounts.map(a => ({
              platform: a.platform,
              traderKey: a.traderKey,
              handle: a.handle,
              label: a.label,
              roi: a.roi,
              pnl: a.pnl,
              arenaScore: a.arenaScore,
              winRate: a.winRate,
              maxDrawdown: a.maxDrawdown,
              rank: a.rank,
              isPrimary: a.isPrimary,
            }))}
          />
        )}

        {traderPerformance ? (
          <OverviewPerformanceCard
            performance={traderPerformance as ExtendedPerformance}
            equityCurve={traderEquityCurve?.['90D']}
            allEquityCurves={traderEquityCurve as Record<string, Array<{ date: string; roi: number; pnl: number }>> | undefined}
            source={(traderProfile?.source as string) || data.source}
            positionSummary={positionSummary}
          />
        ) : (
          <Box style={{
            padding: `${tokens.spacing[6]} ${tokens.spacing[5]}`,
            background: tokens.colors.bg.secondary,
            borderRadius: tokens.radius.xl,
            border: `1px solid ${tokens.colors.border.primary}`,
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: tokens.spacing[2],
          }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: 'var(--color-text-tertiary)', opacity: 0.3 }}>
              <path d="M3 3v18h18" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M7 16l4-8 4 4 4-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <Text size="sm" color="tertiary">
              {t('traderPerformanceUnavailable')}
            </Text>
          </Box>
        )}

        {/* Equity Curve Chart */}
        {traderEquityCurve && (
          <SectionErrorBoundary>
            <EquityCurveSection
              equityCurve={traderEquityCurve as { '90D': Array<{ date: string; roi: number; pnl: number }>; '30D': Array<{ date: string; roi: number; pnl: number }>; '7D': Array<{ date: string; roi: number; pnl: number }> } | undefined}
              traderHandle={(traderProfile?.handle as string) || data.handle}
              delay={0}
            />
          </SectionErrorBoundary>
        )}

        {/* Drawdown Chart */}
        {(() => {
          const curve = traderEquityCurve?.[selectedPeriod] ?? traderEquityCurve?.['90D']
          if (!curve || curve.length <= 2) return null
          return (
            <Box
              className="glass-card"
              style={{
                padding: tokens.spacing[5],
                background: tokens.colors.bg.secondary,
                borderRadius: tokens.radius.xl,
                border: `1px solid ${tokens.colors.border.primary}60`,
              }}
            >
              <Text size="sm" weight="bold" style={{ color: 'var(--color-text-secondary)', marginBottom: tokens.spacing[3] }}>
                {t('drawdownChart') || 'Drawdown'} ({selectedPeriod})
              </Text>
              <SectionErrorBoundary><DrawdownChart equityCurve={curve} /></SectionErrorBoundary>
            </Box>
          )
        })()}

        {/* Copy-Trade Simulator */}
        {(() => {
          const simCurve = traderEquityCurve?.[selectedPeriod] ?? traderEquityCurve?.['90D']
          if (!simCurve || simCurve.length <= 2) return null
          return <SectionErrorBoundary><CopyTradeSimulator equityCurve={simCurve} /></SectionErrorBoundary>
        })()}

        {/* Daily Returns Distribution */}
        {(() => {
          const curve = traderEquityCurve?.[selectedPeriod] ?? traderEquityCurve?.['90D']
          if (!curve || curve.length <= 5) return null
          const dailyReturns = curve.slice(1).map((point: { date: string; roi: number }, i: number) => ({
            date: point.date,
            returnPct: Math.abs(curve[i].roi ?? 0) > 0.001
              ? ((point.roi - curve[i].roi) / Math.abs(curve[i].roi)) * 100
              : (point.roi - curve[i].roi),
          })).filter((d: { returnPct: number }) => Number.isFinite(d.returnPct))
          if (dailyReturns.length <= 5) return null
          return (
            <Box
              className="glass-card"
              style={{
                padding: tokens.spacing[5],
                background: tokens.colors.bg.secondary,
                borderRadius: tokens.radius.xl,
                border: `1px solid ${tokens.colors.border.primary}60`,
              }}
            >
              <Text size="sm" weight="bold" style={{ color: 'var(--color-text-secondary)', marginBottom: tokens.spacing[3] }}>
                {t('dailyReturnsDistribution') || 'Daily Returns Distribution'} ({selectedPeriod})
              </Text>
              <SectionErrorBoundary><DailyReturnsChart data={dailyReturns} /></SectionErrorBoundary>
            </Box>
          )
        })()}

        {/* Advanced Metrics */}
        {(() => {
          const perf = traderPerformance as Record<string, unknown> | null
          const sortino = (perf?.sortino_ratio as number | null) ?? data.sortino_ratio ?? null
          const calmar = (perf?.calmar_ratio as number | null) ?? data.calmar_ratio ?? null
          const profitFactor = (perf?.profit_factor as number | null) ?? data.profit_factor ?? null
          const avgHolding = (perf?.avg_holding_time_hours as number | null) ?? data.avg_holding_hours ?? null
          const avgProfitVal = (perf?.avg_profit as number | null) ?? null
          const avgLossVal = (perf?.avg_loss as number | null) ?? null
          const lWin = (perf?.largest_win as number | null) ?? null
          const lLoss = (perf?.largest_loss as number | null) ?? null
          if (sortino == null && calmar == null && profitFactor == null && avgProfitVal == null && lWin == null) return null
          return (
            <AdvancedMetricsCard
              metrics={{
                sortino_ratio: sortino,
                calmar_ratio: calmar,
                profit_factor: profitFactor,
                recovery_factor: null,
                max_consecutive_wins: null,
                max_consecutive_losses: null,
                avg_holding_hours: avgHolding,
                volatility_pct: null,
                downside_volatility_pct: null,
              }}
              avgProfit={avgProfitVal}
              avgLoss={avgLossVal}
              largestWin={lWin}
              largestLoss={lLoss}
            />
          )
        })()}

        {/* Trading Style Radar */}
        {(data.profitability_score != null || data.risk_control_score != null || data.execution_score != null) && (
          <Box
            className="glass-card"
            style={{
              padding: tokens.spacing[5],
              background: tokens.colors.bg.secondary,
              borderRadius: tokens.radius.xl,
              border: `1px solid ${tokens.colors.border.primary}60`,
            }}
          >
            <Text size="sm" weight="bold" style={{ color: 'var(--color-text-secondary)', marginBottom: tokens.spacing[3], textAlign: 'center' }}>
              {t('traderTradingStyleLabel')}
            </Text>
            <SectionErrorBoundary>
              <TradingStyleRadar
                profitability={data.profitability_score}
                riskControl={data.risk_control_score}
                execution={data.execution_score}
                winRate={data.win_rate}
                maxDrawdown={data.max_drawdown}
              />
            </SectionErrorBoundary>
          </Box>
        )}

        {/* Verified trader edit OR Claim CTA */}
        {isOwner ? (
          <VerifiedTraderEditor
            traderId={data.source_trader_id}
            source={data.source}
            currentData={{}}
            onSaved={() => window.location.reload()}
          />
        ) : !isVerifiedTrader && !claimedUser && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 16px',
            background: 'var(--color-bg-secondary)',
            borderRadius: 8,
            border: '1px solid var(--color-border-primary)',
            fontSize: 13,
          }}>
            <span style={{ color: 'var(--color-text-secondary)', flex: 1 }}>
              {t('claimYourProfileShort')}
            </span>
            {currentUserId ? (
              <ClaimTraderButton
                traderId={(traderProfile?.id as string) || data.source_trader_id}
                handle={(traderProfile?.handle as string) || data.handle}
                userId={currentUserId}
                source={(traderProfile?.source as string) || data.source}
              />
            ) : (
              <a
                href={`/login?returnUrl=${encodeURIComponent(`/trader/${encodeURIComponent(data.handle)}`)}`}
                style={{
                  padding: '6px 16px',
                  borderRadius: 6,
                  background: 'var(--color-brand)',
                  color: 'white',
                  fontWeight: 600,
                  fontSize: 12,
                  textDecoration: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                {t('loginToClaim')}
              </a>
            )}
          </div>
        )}
      </Box>

      {(traderSimilar.length > 0 || features.social) && (
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
          {traderSimilar.length > 0 && <SectionErrorBoundary><SimilarTraders traders={traderSimilar} /></SectionErrorBoundary>}
          {features.social && (
            <Link href="/groups" prefetch={false} style={{ textDecoration: 'none' }}>
              <Box
                className="glass-card"
                style={{
                  padding: tokens.spacing[5],
                  background: tokens.colors.bg.secondary,
                  borderRadius: tokens.radius.xl,
                  border: `1px solid ${tokens.colors.border.primary}60`,
                  transition: 'all 0.2s',
                  cursor: 'pointer',
                }}
                onMouseEnter={(e: React.MouseEvent<HTMLDivElement>) => {
                  e.currentTarget.style.borderColor = tokens.colors.accent.primary + '60'
                }}
                onMouseLeave={(e: React.MouseEvent<HTMLDivElement>) => {
                  e.currentTarget.style.borderColor = tokens.colors.border.primary + '60'
                }}
              >
                <Box style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: tokens.spacing[2] }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.primary} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87" /><path d="M16 3.13a4 4 0 010 7.75" />
                  </svg>
                  <Text size="sm" weight="bold" style={{ color: tokens.colors.text.primary }}>
                    {t('communityDiscoverTitle')}
                  </Text>
                </Box>
                <Text size="xs" style={{ color: tokens.colors.text.secondary, lineHeight: 1.5 }}>
                  {t('communityDiscoverDesc')}
                </Text>
              </Box>
            </Link>
          )}
        </Box>
      )}
    </Box>
  )
})

export default OverviewTab
