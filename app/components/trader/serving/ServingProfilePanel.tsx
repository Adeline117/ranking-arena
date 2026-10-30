'use client'

/**
 * Serving-mode profile body (ARENA_DATA_SPEC v1.2 §2.4).
 *
 * Replaces the legacy tabs+content block when the source reads from
 * arena.* — the page header/hero above it already rendered from Tier-A
 * first-screen data with zero on-demand fetching. This panel owns:
 *
 *   2. Core modules — the public /api/traders/[handle]/core route currently
 *      returns ONE static structural projection for every timeframe
 *      (lib/data/serving/core-quarantine: historical core evidence is not
 *      publicly sealed). Like useServingTabData, this panel builds that
 *      projection locally (pure, client-safe) with NO network request and
 *      renders the explicit "under verification" state instead of
 *      skeleton → empty grid. When the core publication chain is restored,
 *      switch back to useTraderCore (lib/hooks/useTraderCore, kept for that).
 *   3. Heavy record tabs — fetched ONLY when the tab is opened
 *      (capability-driven sub-tabs; copiers is aggregate-only).
 *   4. Timeframe lazy — query key includes tf; switching fetches just
 *      the newly selected timeframe.
 */

import { useMemo, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { quarantinedPublicCoreModules } from '@/lib/data/serving/core-quarantine'
import { useBotHeader } from '@/lib/hooks/useBotHeader'
import { PeriodSelector, type Period } from '@/app/components/trader/performance/PeriodSelector'
import {
  displayableMetrics,
  promoteExtrasMetrics,
  EXTRAS_PROMOTABLE_KEYS,
} from '@/lib/constants/metric-registry'
import {
  readGmxMaxCapitalRoiModuleDisclosure,
  readGmxRealizedNetModuleDisclosure,
} from '@/lib/data/serving/pnl-contract'
import MetricGrid from './MetricGrid'
import PnlContractNotice from './PnlContractNotice'
import SignalChips from './SignalChips'
import TraderMetaStrip from './TraderMetaStrip'
import CopyTradingCard from './CopyTradingCard'
import OnchainInsights from './OnchainInsights'
import CoreCharts from './CoreCharts'
import DrawdownModule from './DrawdownModule'
import AssetPreference from './AssetPreference'
import HoldingDistribution from './HoldingDistribution'
import AbilityRadar from './AbilityRadar'
import ServingRecordsSection from './ServingRecordsSection'
import HistoryVerificationNotice from '@/app/components/trader/HistoryVerificationNotice'
import BotHeaderCard from './BotHeaderCard'
import ProvenanceFooter from '@/app/components/common/ProvenanceFooter'
import AntiGamingBadge from '@/app/components/ranking/AntiGamingBadge'
import { computeAntiGamingFlags } from '@/lib/scoring/anti-gaming'
import type {
  ServingTimeframe,
  SourceCapability,
  TraderFirstScreen,
} from '@/lib/data/serving/types'

export interface ServingProfilePanelProps {
  firstScreen: TraderFirstScreen
  capability: SourceCapability | null
}

/**
 * Land on a timeframe the source actually exposes. Hardcoding 90D made
 * sources without it (bots → only 30D; bitfinex/kucoin/lbank) open on a
 * DISABLED tab — the active pill sat on a greyed period and the grid read as
 * broken. Prefer 90D → 30D → 7D, then bot inception, then 90D as a last resort.
 *
 * Capability can be null/incomplete: arena_source_capabilities is a ~10s RPC
 * the page races against a 2s timeout, so under frequent deploys it often
 * resolves to {}. When that happens we trust firstScreen.entries — the board
 * timeframes we DO have — so e.g. a [30]-only bot still lands on 30D (warm)
 * instead of defaulting to 90D (empty → perpetual "loading").
 */
function pickDefaultPeriod(
  capability: SourceCapability | null,
  entryTimeframes: number[]
): { period: Period; inception: boolean } {
  const entryTfs = new Set(entryTimeframes)
  const isAvailable = (k: '7' | '30' | '90'): boolean => {
    const a = capability?.timeframes?.[k]
    if (a === 'native' || a === 'derived') return true
    if (a === 'absent') return false
    return entryTfs.has(Number(k)) // capability missing → trust board entries
  }
  const order: Array<{ p: Period; k: '7' | '30' | '90' }> = [
    { p: '90D', k: '90' },
    { p: '30D', k: '30' },
    { p: '7D', k: '7' },
  ]
  for (const { p, k } of order) {
    if (isAvailable(k)) return { period: p, inception: false }
  }
  if (capability?.inceptionTf) return { period: '90D', inception: true }
  return { period: '90D', inception: false }
}

function periodToTimeframe(period: Period): 7 | 30 | 90 {
  return Number(period.replace('D', '')) as 7 | 30 | 90
}

function canRequestTimeframe(
  capability: SourceCapability | null,
  traderKind: TraderFirstScreen['traderKind'],
  period: Period,
  inception: boolean
): boolean {
  if (inception) return traderKind === 'bot' && capability?.inceptionTf === true
  const key = String(periodToTimeframe(period)) as '7' | '30' | '90'
  // A missing capability is unknown (the RPC may have timed out), while an
  // explicit `absent` is authoritative and must never reach the endpoint.
  return capability?.timeframes[key] !== 'absent'
}

export default function ServingProfilePanel({ firstScreen, capability }: ServingProfilePanelProps) {
  const { t } = useLanguage()
  const { source, exchangeTraderId } = firstScreen

  const entryTimeframes = useMemo(
    () => [...new Set(firstScreen.entries?.map((entry) => entry.timeframe) ?? [])].sort(),
    [firstScreen.entries]
  )

  const initialPeriod = useMemo(
    () => pickDefaultPeriod(capability, entryTimeframes),
    [capability, entryTimeframes]
  )
  const timeframeScope = JSON.stringify([
    source,
    exchangeTraderId,
    firstScreen.traderKind,
    capability?.timeframes['7'] ?? null,
    capability?.timeframes['30'] ?? null,
    capability?.timeframes['90'] ?? null,
    capability?.inceptionTf ?? null,
    entryTimeframes,
  ])
  const [timeframeSelection, setTimeframeSelection] = useState<{
    scope: string
    period: Period
    inception: boolean
  } | null>(null)
  const selectedForCurrentScope =
    timeframeSelection?.scope === timeframeScope &&
    canRequestTimeframe(
      capability,
      firstScreen.traderKind,
      timeframeSelection.period,
      timeframeSelection.inception
    )
      ? timeframeSelection
      : null
  // Scope the user's choice to the exact subject + timeframe capability. On
  // a linked-account switch, the new default is used during the first render,
  // before any query hook can observe the old subject's timeframe.
  const period = selectedForCurrentScope?.period ?? initialPeriod.period
  const inceptionSelected = selectedForCurrentScope?.inception ?? initialPeriod.inception
  const tf: ServingTimeframe = inceptionSelected ? 'inception' : periodToTimeframe(period)
  const timeframeRequestEnabled = canRequestTimeframe(
    capability,
    firstScreen.traderKind,
    period,
    inceptionSelected
  )

  // Identical to what the quarantined /core route would return, built locally
  // (no request). null when the timeframe is not provided by the source.
  const coreModules = useMemo(
    () => (timeframeRequestEnabled ? quarantinedPublicCoreModules(tf) : null),
    [timeframeRequestEnabled, tf]
  )
  const coreQuarantined = coreModules?.cacheState === 'quarantined'
  // Rendered only once a non-quarantined (published) projection exists.
  const publishedCore = coreQuarantined ? null : coreModules

  // Only sealed public-cohort values (verified rank + ROI) may accompany the
  // under-verification notice — same rule as TraderProfileClient's tabs.
  const verificationEntry =
    coreQuarantined && typeof tf === 'number'
      ? firstScreen.entries?.find((entry) => entry.timeframe === tf)
      : undefined
  const sealedCurrentRanking =
    verificationEntry?.rankingVisibility === 'verified' &&
    typeof verificationEntry.rank === 'number' &&
    typeof verificationEntry.headlineRoi === 'number'
      ? { period, rank: verificationEntry.rank, roi: verificationEntry.headlineRoi }
      : null

  // Bot profile header (spec §1.3) — only fetched for bot traders.
  const isBot = firstScreen.traderKind === 'bot'
  const { bot } = useBotHeader({ source, exchangeTraderId, enabled: isBot })

  // 独家信号 (spec §12.2/§12.3): numeric extras the registry knows (risk
  // ratios like sortino/volatility/P-L-ratio, NAV, risk rating) are promoted
  // into the stats grid via the declarative alias map — surfacing data the
  // adapters already capture; the qualitative signals (style labels, last
  // liquidation) render as SignalChips. Both NULL-collapse with no signal.
  const gridStats = useMemo<Record<string, number | string | null>>(() => {
    if (!publishedCore) return {}
    return promoteExtrasMetrics(publishedCore.stats, publishedCore.extras)
  }, [publishedCore])
  const gridCapabilityMetrics = [
    ...(capability?.metrics ?? Object.keys(publishedCore?.stats ?? {})),
    // Extras-sourced metrics aren't in the capability RPC's trader_stats
    // column scan — allow them when present.
    ...EXTRAS_PROMOTABLE_KEYS,
  ]
  const pnlActuallyVisible = displayableMetrics(gridCapabilityMetrics, gridStats).some(
    (def) => def.key === 'pnl'
  )
  const pnlDisclosure =
    typeof tf === 'number' && pnlActuallyVisible
      ? readGmxRealizedNetModuleDisclosure(source, tf, publishedCore)
      : null
  const roiActuallyVisible = displayableMetrics(gridCapabilityMetrics, gridStats).some(
    (def) => def.key === 'roi'
  )
  const roiDisclosure =
    typeof tf === 'number' && roiActuallyVisible
      ? readGmxMaxCapitalRoiModuleDisclosure(source, tf, publishedCore)
      : null

  // Dormant trader (e.g. Bitget "*不活跃"): every core metric is 0 and the
  // series is flat. Show one honest line instead of a grid of 0.00% that
  // reads like a render failure. We do NOT fabricate data.
  const isDormant = useMemo(() => {
    if (!publishedCore) return false
    const core_keys = ['roi', 'pnl', 'win_rate', 'total_positions', 'aum'] as const
    const allZero = core_keys.every((k) => {
      const v = gridStats[k]
      return v === undefined || v === null || Number(v) === 0
    })
    return allZero && core_keys.some((k) => gridStats[k] !== undefined)
  }, [publishedCore, gridStats])

  // Trust-facing anti-gaming ⚠️ flags for the CURRENTLY-VIEWED period — same
  // pure heuristic + badge as the ranking cards, kept consistent everywhere.
  // Per-period (reflects the timeframe on screen), which is more precise than
  // the single serving-row flag shown on the list.
  const antiGamingWinRate = useMemo(() => {
    const v = gridStats.win_rate
    return v == null || !Number.isFinite(Number(v)) ? null : Number(v)
  }, [gridStats])
  const antiGamingTrades = useMemo(() => {
    const v = gridStats.total_positions
    return v == null || !Number.isFinite(Number(v)) ? null : Number(v)
  }, [gridStats])
  const antiGamingFlags = useMemo(
    () => computeAntiGamingFlags({ winRate: antiGamingWinRate, tradesCount: antiGamingTrades }),
    [antiGamingWinRate, antiGamingTrades]
  )

  // Record sub-tabs now live in the shared <ServingRecordsSection>.
  const availability = capability
    ? {
        '7D': capability.timeframes['7'],
        '30D': capability.timeframes['30'],
        '90D': capability.timeframes['90'],
      }
    : undefined

  const showInception = Boolean(capability?.inceptionTf && firstScreen.traderKind === 'bot')

  return (
    <Box style={{ marginTop: tokens.spacing[4] }}>
      <style>{`@keyframes servingPulse { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }`}</style>

      {/* ── Bot header (spec §1.3): strategy/pair/runtime/profit-share/owner ── */}
      {isBot && bot && <BotHeaderCard bot={bot} style={{ marginBottom: tokens.spacing[3] }} />}

      {/* ── Core modules (spec §2.4-2): static quarantined projection, no request ── */}
      <PeriodSelector
        period={period}
        onPeriodChange={(p) => {
          if (!canRequestTimeframe(capability, firstScreen.traderKind, p, false)) return
          setTimeframeSelection({ scope: timeframeScope, period: p, inception: false })
        }}
        source={source}
        lastUpdated={publishedCore?.provenance.asOf}
        availability={availability}
        showInception={showInception}
        inceptionSelected={inceptionSelected}
        onInceptionSelect={() => {
          if (!showInception) return
          setTimeframeSelection({ scope: timeframeScope, period, inception: true })
        }}
      />

      {!timeframeRequestEnabled ? (
        <Box
          style={{
            padding: tokens.spacing[6],
            borderRadius: tokens.radius.lg,
            border: '1px dashed ' + tokens.colors.border.primary,
          }}
        >
          <Text size="sm" color="tertiary" style={{ textAlign: 'center' }}>
            {t('tfNotProvided')}
          </Text>
        </Box>
      ) : !publishedCore ? (
        <HistoryVerificationNotice currentRanking={sealedCurrentRanking} compact />
      ) : (
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
          {antiGamingFlags.length > 0 && (
            <Box style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacing[2] }}>
              <AntiGamingBadge
                flags={antiGamingFlags}
                winRate={antiGamingWinRate}
                tradesCount={antiGamingTrades}
              />
            </Box>
          )}
          <SignalChips source={source} extras={publishedCore.extras} />
          <TraderMetaStrip extras={publishedCore.extras} currency={publishedCore.currency} />
          <CopyTradingCard extras={publishedCore.extras} currency={publishedCore.currency} />
          <OnchainInsights extras={publishedCore.extras} currency={publishedCore.currency} />
          {isDormant && (
            <Text size="sm" color="tertiary">
              {t('traderDormantForPeriod')}
            </Text>
          )}
          <MetricGrid
            stats={gridStats}
            capabilityMetrics={gridCapabilityMetrics}
            currency={publishedCore.currency}
            metricLabelKeys={
              pnlDisclosure || roiDisclosure
                ? {
                    ...(pnlDisclosure ? { pnl: 'gmxRealizedNetPnlLabel' } : {}),
                    ...(roiDisclosure ? { roi: 'gmxMaxCapitalRoiLabel' } : {}),
                  }
                : undefined
            }
            metricTooltipKeys={
              pnlDisclosure || roiDisclosure
                ? {
                    ...(pnlDisclosure ? { pnl: 'gmxRealizedNetPnlTooltip' } : {}),
                    ...(roiDisclosure ? { roi: 'gmxMaxCapitalRoiTooltip' } : {}),
                  }
                : undefined
            }
          />
          {pnlDisclosure && <PnlContractNotice disclosure={pnlDisclosure} compact />}
          <CoreCharts series={publishedCore.series} timeframe={tf} />
          <DrawdownModule series={publishedCore.series} />
          <AbilityRadar extras={publishedCore.extras} />
          <AssetPreference extras={publishedCore.extras} />
          <HoldingDistribution extras={publishedCore.extras} />
          <ProvenanceFooter
            provenance={publishedCore.provenance}
            exchangeName={capability?.exchangeName}
            // Myfxbook-style data-authenticity tier. Prod currently has 0
            // API-verified traders (verified_traders/trader_authorizations both
            // empty), so every serving profile is honestly 'tracked' (scraped
            // from the exchange leaderboard). A1 phase-2 threads the authorized
            // flag through the serving data → flip verified rows to 'verified'.
            verificationTier="tracked"
          />
        </Box>
      )}

      {/* ── Record sub-tabs (spec §2.4-3) — shared with the default three-tab. ── */}
      {timeframeRequestEnabled && (
        <ServingRecordsSection
          source={source}
          exchangeTraderId={exchangeTraderId}
          capability={capability}
          tf={tf}
          exchangeName={capability?.exchangeName}
        />
      )}
    </Box>
  )
}
