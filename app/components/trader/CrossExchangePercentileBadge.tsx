'use client'

/**
 * CrossExchangePercentileBadge
 *
 * The flagship "you beat X% of traders" moat framing — but ACCURATE, not
 * score-approximated. The v4 display score is a blend (70% percentile + 30%
 * relative composite), so "Arena Score 87 = you beat 87%" is NOT precisely
 * true. Instead we derive the percentile straight from the trader's overall
 * cross-exchange rank and the total tracked count:
 *
 *   beatPct = round((1 - rank/total) * 100)   // percent of traders you beat
 *   topPct  = max(1, round((rank/total) * 100)) // "Top X%"
 *
 * WHY THIS IS ACCURATE (cross-exchange, not per-platform):
 *   `leaderboard_ranks.rank` is assigned by rerank_leaderboard() via
 *   ROW_NUMBER() OVER (ORDER BY arena_score DESC) *within a season with NO
 *   PARTITION BY source* — i.e. it is a global rank across EVERY tracked
 *   exchange, not a per-platform position. The `rank` prop here is the 90D
 *   entry's rank (TraderProfileClient prefers timeframe===90). The denominator
 *   `total` = getHeroStats().traderCount, which counts the 90D leaderboard_ranks
 *   rows (arena_score > 0) — the same population `rank` is drawn from. So
 *   rank/total is a true cross-exchange percentile on the 90D board.
 *
 * Sibling to RankPercentileBadge (per-platform "Top X% on Binance"); this one
 * is the cross-exchange variant. Reuses its medal tiering via getBadgeStyle.
 */

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import { useQuery } from '@tanstack/react-query'
import { STALE_STATIC } from '@/lib/hooks/cache-presets'
import { Box, Text } from '../base'
import { getBadgeStyle } from './RankPercentileBadge'

interface HeroStatsResponse {
  sourceBoardCount?: number
  /** Deprecated compatibility field; not used by this component. */
  exchangeCount: number
  traderCount: number
  isDefault?: boolean
}

interface CrossExchangePercentileBadgeProps {
  /** Overall cross-exchange rank (90D global rank from leaderboard_ranks). */
  rank: number | null | undefined
}

const fetcher = (url: string): Promise<HeroStatsResponse> =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${r.status}`)
    return r.json()
  })

export default function CrossExchangePercentileBadge({ rank }: CrossExchangePercentileBadgeProps) {
  const { t } = useLanguage()

  // Total tracked traders — reuse the hero's count source (getHeroStats →
  // traderCount), never a hardcoded number.
  const { data: heroStats } = useQuery<HeroStatsResponse>({
    queryKey: ['hero-stats'],
    queryFn: () => fetcher('/api/hero-stats'),
    refetchOnWindowFocus: false,
    staleTime: STALE_STATIC,
    retry: 1,
  })

  if (!rank || rank <= 0) return null

  const total = heroStats?.traderCount
  // Guard: need a valid denominator, and rank must sit inside the population
  // (rank is drawn from all leaderboard_ranks rows; total excludes outliers, so
  // a handful of ranks can exceed total — skip those rather than show garbage).
  if (!total || total <= 0 || rank >= total) return null

  const percentile = (1 - rank / total) * 100
  if (percentile <= 0) return null

  // Cap at 99: you can never beat 100% of a population that includes yourself
  // (rank 1 of 9,678 → round(99.99) = 100 → "beats 100%" is a lie).
  const beatPct = Math.min(99, Math.round(percentile)) // percent of traders beaten
  const topPct = Math.max(1, Math.round((rank / total) * 100)) // "Top X%"

  // Only surface as a positive signal (top half). Beyond that it stops being a
  // brag and the per-platform badge already covers finer placement.
  if (topPct > 50) return null

  const style = getBadgeStyle(percentile)

  const tooltip = t('beatsTradersAcrossExchanges')
    .replace('{pct}', String(beatPct))
    .replace('{total}', total.toLocaleString('en-US'))

  return (
    <Box
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: tokens.radius.full,
        background: style.bg,
        border: `1px solid ${style.border}`,
        flexShrink: 0,
      }}
      role="img"
      aria-label={tooltip}
      title={tooltip}
    >
      {/* Globe icon — signals cross-exchange (all tracked venues) */}
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke={style.color}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M2 12h20" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
      <Text
        size="xs"
        weight="bold"
        style={{
          color: style.color,
          // eslint-disable-next-line no-restricted-syntax -- off-scale micro label by design (matches RankPercentileBadge)
          fontSize: 11,
          letterSpacing: '0.3px',
          whiteSpace: 'nowrap',
        }}
      >
        {t('topPercentOverall').replace('{pct}', String(topPct))}
      </Text>
    </Box>
  )
}
