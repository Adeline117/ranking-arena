/**
 * Cron: Auto-post daily top movers to Twitter/X
 * Schedule: 0 8 * * * (daily at 08:00 UTC)
 *
 * Fetches top 5 traders by Arena Score from the 7D leaderboard,
 * formats a tweet, and posts it (or logs in dry-run mode if no API keys).
 */

import { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { formatDailyTopMovers, postTweet, type TopMover } from '@/lib/services/twitter-bot'
import { logger } from '@/lib/logger'
import { withCron } from '@/lib/api/with-cron'
import { sanitizePublicRankingPayload } from '@/lib/rankings/publication-policy'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const PUBLIC_RANKED_LEADERBOARD = 'public_ranked_leaderboard' as const
const PUBLIC_TWITTER_PERIOD = '7D'
const PUBLIC_TWITTER_RANKING_COLUMNS =
  'season_id,source,source_trader_id,handle,roi,pnl,arena_score,rank,win_rate,max_drawdown,score_completeness,metrics_estimated,is_outlier,computed_at'

function unavailablePublicCohort() {
  return { count: 0, skipped: true, reason: 'public ranking cohort unavailable' }
}

export const GET = withCron(
  'auto-post-twitter',
  async (_request: NextRequest, { plog: _plog }) => {
    const supabase = getSupabaseAdmin()

    // The social post is an external ranking surface: it may only use rows from
    // the sealed public cohort, never a raw scoring page.
    const { data: topTraders, error } = await supabase
      .from(PUBLIC_RANKED_LEADERBOARD as never)
      .select(PUBLIC_TWITTER_RANKING_COLUMNS)
      .eq('season_id', PUBLIC_TWITTER_PERIOD)
      .not('rank', 'is', null)
      .order('arena_score', { ascending: false })
      .order('rank', { ascending: true, nullsFirst: false })
      .limit(5)

    if (error) {
      throw new Error(`Failed to fetch public top traders: ${error.message}`)
    }

    const sanitizedCohort = sanitizePublicRankingPayload(
      { traders: (topTraders ?? []) as unknown[], period: PUBLIC_TWITTER_PERIOD },
      { expectedPeriod: PUBLIC_TWITTER_PERIOD }
    ) as { traders?: unknown[]; ranking_visibility?: unknown }
    if (
      sanitizedCohort.ranking_visibility === 'partial' ||
      sanitizedCohort.ranking_visibility === 'unknown' ||
      !sanitizedCohort.traders?.length
    ) {
      return unavailablePublicCohort()
    }

    const movers: TopMover[] = sanitizedCohort.traders.map((row) => {
      const t = row as Record<string, unknown>
      return {
        handle: typeof t.handle === 'string' ? t.handle : null,
        source_trader_id: String(t.source_trader_id),
        source: String(t.source),
        roi: typeof t.roi === 'number' ? t.roi : null,
        pnl: typeof t.pnl === 'number' ? t.pnl : null,
        arena_score: typeof t.arena_score === 'number' ? t.arena_score : null,
      }
    })

    const content = formatDailyTopMovers(movers)

    logger.info(`[auto-post-twitter] Generated tweet (${content.text.length} chars)`)

    // Post to Twitter (dry-run if no API keys configured)
    const tweetId = await postTweet(content)

    return {
      count: 1,
      tweetId: tweetId ?? 'dry-run',
      traders: movers.map((m) => m.handle || m.source_trader_id.slice(0, 8)),
      charCount: content.text.length,
    }
  },
  { maxDurationSec: maxDuration }
)
