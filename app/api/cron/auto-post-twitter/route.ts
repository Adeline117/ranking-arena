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
import { isPublicRankingSourceAllowed } from '@/lib/rankings/publication-policy'
import { readSealedRankingAuthorityGeneration } from '@/lib/rankings/read-sealed-ranking-generation'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export const GET = withCron('auto-post-twitter', async (_request: NextRequest, { plog: _plog }) => {
  const supabase = getSupabaseAdmin()

  // Fetch top 5 traders by arena_score in 7D window (recent top performers)
  const sealedRead = await readSealedRankingAuthorityGeneration(
    supabase,
    '7D',
    async (publication) => {
      const authoritySources = publication.proofs.map((proof) => proof.source)
      const { data, error } = await supabase
        .from('leaderboard_ranks')
        .select('source_trader_id, handle, source, roi, pnl, arena_score')
        .in('source', authoritySources)
        .eq('season_id', '7D')
        .filter('rank_publication_id', 'eq', publication.scoreCohortId)
        .gt('arena_score', 0)
        .or('is_outlier.is.null,is_outlier.eq.false')
        .order('arena_score', { ascending: false })
        .order('source', { ascending: true })
        .order('source_trader_id', { ascending: true })
        .limit(5)

      if (error || data === null) {
        throw new Error(`Failed to fetch sealed top traders: ${error?.message ?? 'null payload'}`)
      }
      if (data.some((row) => !isPublicRankingSourceAllowed(row.source))) {
        throw new Error('Twitter ranking query crossed the public source boundary')
      }
      return data
    },
    { timeoutMs: 10_000 }
  )
  const topTraders = sealedRead.value

  if (topTraders.length === 0) {
    return { count: 0, skipped: true, reason: 'no traders found' }
  }

  const movers: TopMover[] = topTraders.map((t) => ({
    handle: t.handle as string | null,
    source_trader_id: String(t.source_trader_id),
    source: String(t.source),
    roi: t.roi != null ? Number(t.roi) : null,
    pnl: t.pnl != null ? Number(t.pnl) : null,
    arena_score: t.arena_score != null ? Number(t.arena_score) : null,
  }))

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
})
