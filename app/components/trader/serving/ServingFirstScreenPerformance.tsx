'use client'

/**
 * Truthful server-rendered bridge for a serving trader's first paint.
 *
 * `/core` modules deliberately begin only in the browser, while the page's
 * Tier-A first-screen payload already contains a public leaderboard snapshot.
 * This component renders only that snapshot (never manufactured zeroes) until
 * the authoritative core modules arrive and take over the full Overview card.
 */

import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'
import type { TraderFirstScreen } from '@/lib/data/serving/types'
import { formatCompact, formatROI } from '@/lib/utils/format'
import {
  isPeriodAvailable,
  type Period,
  type PeriodAvailability,
} from '../performance/period-availability'

type FirstScreenEntry = TraderFirstScreen['entries'][number]

const EMPTY_VALUE = '—'
const rankFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

function selectSnapshot(
  entries: TraderFirstScreen['entries'],
  preferredTimeframe?: 7 | 30 | 90,
  periodAvailability?: PeriodAvailability
): FirstScreenEntry | null {
  const eligibleEntries = entries.filter((entry) =>
    isPeriodAvailable(`${entry.timeframe}D` as Period, periodAvailability)
  )

  return (
    (preferredTimeframe
      ? eligibleEntries.find((entry) => entry.timeframe === preferredTimeframe)
      : undefined) ??
    eligibleEntries.find((entry) => entry.timeframe === 90) ??
    eligibleEntries.find((entry) => entry.timeframe === 30) ??
    eligibleEntries[0] ??
    null
  )
}

function formatWinRate(value: number | null): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)}%` : EMPTY_VALUE
}

function formatRank(value: number): string {
  return Number.isInteger(value) && value > 0 ? `#${rankFormatter.format(value)}` : EMPTY_VALUE
}

function formatSnapshotMoney(value: FirstScreenEntry['headlinePnl']): string {
  if (!value || !Number.isFinite(value.value)) return EMPTY_VALUE
  const sign = value.value > 0 ? '+' : ''
  return `${sign}$${formatCompact(value.value)} ${value.currency}`
}

interface MetricProps {
  label: string
  value: string
  emphasized?: boolean
}

function SnapshotMetric({ label, value, emphasized = false }: MetricProps) {
  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1], minWidth: 0 }}>
      <Text as="span" size="xs" color="tertiary">
        {label}
      </Text>
      <Text
        as="span"
        size={emphasized ? '2xl' : 'lg'}
        weight="bold"
        style={{
          overflowWrap: 'anywhere',
          color: emphasized ? tokens.colors.accent.primary : undefined,
        }}
      >
        {value}
      </Text>
    </Box>
  )
}

export default function ServingFirstScreenPerformance({
  firstScreen,
  preferredTimeframe,
  periodAvailability,
}: {
  firstScreen: TraderFirstScreen
  /** Mirrors the user's selected period until that exact core module arrives. */
  preferredTimeframe?: 7 | 30 | 90
  /** Capability-level disclosure is resolved against the snapshot entry that
   *  actually rendered, not merely the requested period. */
  periodAvailability?: PeriodAvailability
}) {
  const { t } = useLanguage()
  const entry = selectSnapshot(firstScreen.entries, preferredTimeframe, periodAvailability)

  if (!entry) return null

  const entryPeriod = `${entry.timeframe}D` as keyof PeriodAvailability
  const isDerivedSnapshot =
    entry.provenance.derived === true || periodAvailability?.[entryPeriod] === 'derived'

  return (
    <Box
      as="section"
      className="glass-card"
      data-testid="serving-first-screen-performance"
      aria-label={`${t('leaderboardSnapshot')} · ${entry.timeframe}D`}
      style={{
        padding: tokens.spacing[5],
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}`,
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacing[5],
      }}
    >
      <Box
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: tokens.spacing[2],
        }}
      >
        <Text as="h2" size="lg" weight="bold">
          {t('performance')}
        </Text>
        <Text as="span" size="xs" color="secondary">
          {t('leaderboardSnapshot')} · {t('provenanceTracked')} · {entry.timeframe}D
        </Text>
      </Box>

      {isDerivedSnapshot && (
        <Text as="span" size="xs" color="tertiary" title={t('derivedBoardTooltip')}>
          {t('derivedBoardBadge')}
        </Text>
      )}

      <Box
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: tokens.spacing[5],
        }}
      >
        <SnapshotMetric label={t('roi')} value={formatROI(entry.headlineRoi)} emphasized />
        <SnapshotMetric
          label={t('pnl')}
          value={formatSnapshotMoney(entry.headlinePnl)}
          emphasized
        />
        <SnapshotMetric label={t('winRate')} value={formatWinRate(entry.headlineWinRate)} />
        <SnapshotMetric label={t('rank')} value={formatRank(entry.rank)} />
      </Box>

      <Text as="p" size="xs" color="tertiary" title={entry.provenance.asOf}>
        {t('provenanceAsOf')} {entry.provenance.asOf}
      </Text>
    </Box>
  )
}
