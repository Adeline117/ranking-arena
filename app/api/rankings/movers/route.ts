/**
 * Top Movers API
 *
 * GET /api/rankings/movers
 *
 * Returns traders with the biggest ROI changes compared to the previous day.
 * Strategy: Start from trader_daily_snapshots (yesterday) -> join leaderboard_ranks (current).
 * Compares leaderboard_ranks.roi (current 90D ROI) vs trader_daily_snapshots.roi (previous).
 *
 * Response: { risers: Mover[], fallers: Mover[], period: '90D' }
 * Cache: Redis 10min + HTTP 1 hour (s-maxage=3600)
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, checkRateLimit, RateLimitPresets } from '@/lib/api'
import { getOrSetWithLock } from '@/lib/cache'
import { createLogger } from '@/lib/utils/logger'
import {
  filterPublicRankingRows,
  filterPublicRankingSources,
  isPublicRankingSourceAllowed,
  publicRankingCacheKey,
} from '@/lib/rankings/publication-policy'
import { readSealedRankingGeneration } from '@/lib/rankings/read-sealed-ranking-generation'
import {
  createSealedRankingCacheEntry,
  parseSealedRankingCacheEntry,
  type SealedRankingCacheEntry,
} from '@/lib/rankings/sealed-ranking-cache'

const log = createLogger('api:movers')

export const runtime = 'nodejs'

interface Mover {
  platform: string
  trader_key: string
  rank: number
  arena_score: number | null
  roiDelta: number
  handle: string | null
  avatar_url: string | null
}

interface MoversResponse {
  risers: Mover[]
  fallers: Mover[]
  period: '90D'
  snapshotDate: string
  compareDate: string
}

function isMoversResponse(
  value: unknown,
  proofSources: readonly string[]
): value is MoversResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const risers = Reflect.get(value, 'risers')
  const fallers = Reflect.get(value, 'fallers')
  if (
    Reflect.get(value, 'period') !== '90D' ||
    typeof Reflect.get(value, 'snapshotDate') !== 'string' ||
    typeof Reflect.get(value, 'compareDate') !== 'string' ||
    !Array.isArray(risers) ||
    !Array.isArray(fallers) ||
    risers.length > 5 ||
    fallers.length > 5
  ) {
    return false
  }
  const allowed = new Set(proofSources)
  const validMover = (mover: unknown) =>
    mover !== null &&
    typeof mover === 'object' &&
    !Array.isArray(mover) &&
    allowed.has(Reflect.get(mover, 'platform')) &&
    typeof Reflect.get(mover, 'trader_key') === 'string' &&
    Number.isFinite(Reflect.get(mover, 'rank')) &&
    (Reflect.get(mover, 'arena_score') === null ||
      Number.isFinite(Reflect.get(mover, 'arena_score'))) &&
    Number.isFinite(Reflect.get(mover, 'roiDelta'))

  return (
    risers.every(
      (mover) =>
        validMover(mover) && typeof mover === 'object' && Number(Reflect.get(mover, 'roiDelta')) > 0
    ) &&
    fallers.every(
      (mover) =>
        validMover(mover) &&
        mover !== null &&
        typeof mover === 'object' &&
        Number(Reflect.get(mover, 'roiDelta')) < 0
    )
  )
}

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const cached = await getOrSetWithLock<SealedRankingCacheEntry<MoversResponse>>(
      publicRankingCacheKey('api:rankings:movers:sealed-v2'),
      async () => computeMovers(),
      // Short TTL keeps one sealed comparison generation visible briefly while
      // avoiding a proof/database read on every request.
      { ttl: 120, lockTtl: 15 }
    )
    const cachedEntry = parseSealedRankingCacheEntry<MoversResponse>(cached, '90D')
    const proofSources = cachedEntry?.publication.proofs.map((proof) => proof.source) ?? []
    if (!cachedEntry || !isMoversResponse(cachedEntry.value, proofSources)) {
      throw new Error('movers cache did not contain a sealed scoped response')
    }
    const result = cachedEntry.value

    // Don't CDN-cache empty results for long — they recover within minutes
    const hasData = result.risers?.length > 0 || result.fallers?.length > 0
    const cacheHeader = hasData
      ? 'public, s-maxage=3600, stale-while-revalidate=1800'
      : 'public, s-maxage=60, stale-while-revalidate=30'

    return NextResponse.json(result, {
      headers: { 'Cache-Control': cacheHeader },
    })
  } catch (err) {
    log.error('Error computing movers', { error: err instanceof Error ? err.message : String(err) })
    return NextResponse.json(
      { risers: [], fallers: [], period: '90D' },
      { status: 200, headers: { 'Cache-Control': 'public, s-maxage=300' } }
    )
  }
}

async function computeMovers() {
  const signal = AbortSignal.timeout(10_000)
  const sealedRead = await computeMoversInner(signal)
  return createSealedRankingCacheEntry(sealedRead)
}

async function computeMoversInner(signal: AbortSignal) {
  const supabase = getSupabaseAdmin()

  // Find the two most recent distinct snapshot dates.
  // trader_daily_snapshots has many rows per date (one per trader), so we fetch
  // a small batch and deduplicate in code to find 2 distinct dates.
  // idx_daily_snapshots_date (btree date DESC) keeps this fast.
  const today = new Date().toISOString().slice(0, 10)
  const { data: dateRows, error: dateError } = await supabase
    .from('trader_daily_snapshots')
    .select('date')
    .lte('date', today)
    .order('date', { ascending: false })
    .limit(50)
    .abortSignal(signal)

  if (dateError) throw new Error(`movers date lookup failed: ${dateError.message}`)
  if (!dateRows || dateRows.length === 0) throw new Error('movers has no snapshot dates')

  const uniqueDates: string[] = []
  const seen = new Set<string>()
  for (const row of dateRows) {
    if (!seen.has(row.date)) {
      seen.add(row.date)
      uniqueDates.push(row.date)
      if (uniqueDates.length >= 2) break
    }
  }

  if (uniqueDates.length < 2) throw new Error('movers requires two snapshot dates')
  const todayDate = uniqueDates[0]
  const yesterdayDate = uniqueDates[1]

  // Get PREVIOUS day's daily snapshots (to compare against current leaderboard)
  const { data: yesterdaySnaps, error: snapshotError } = await supabase
    .from('trader_daily_snapshots')
    .select('platform, trader_key, roi')
    .eq('date', yesterdayDate)
    .not('roi', 'is', null)
    .order('platform', { ascending: true })
    .order('trader_key', { ascending: true })
    .limit(2000)
    .abortSignal(signal)

  if (snapshotError) throw new Error(`movers snapshot lookup failed: ${snapshotError.message}`)
  if (!yesterdaySnaps?.length) throw new Error('movers has no prior snapshot rows')

  // Group snapshot trader_keys by platform for efficient batch lookup
  const snapsByPlatform = new Map<string, string[]>()
  const yesterdayRoiMap = new Map<string, number>()
  for (const s of yesterdaySnaps) {
    if (s.roi == null || !isPublicRankingSourceAllowed(s.platform)) continue
    const key = `${s.platform}:${s.trader_key}`
    yesterdayRoiMap.set(key, parseFloat(String(s.roi)))
    if (!snapsByPlatform.has(s.platform)) snapsByPlatform.set(s.platform, [])
    snapsByPlatform.get(s.platform)!.push(s.trader_key)
  }

  const proofSources = filterPublicRankingSources([...snapsByPlatform.keys()])
  if (proofSources.length === 0) throw new Error('movers has no public snapshot sources')

  return readSealedRankingGeneration(
    supabase,
    { season: '90D', sources: proofSources },
    async (publication) => {
      const requests: Array<
        Promise<{ data: unknown[] | null; error: { message: string } | null }>
      > = []
      for (const source of proofSources) {
        const traderKeys = [...new Set(snapsByPlatform.get(source) ?? [])]
        for (let index = 0; index < traderKeys.length; index += 500) {
          const chunk = traderKeys.slice(index, index + 500)
          requests.push(
            Promise.resolve(
              supabase
                .from('leaderboard_ranks')
                .select('source, source_trader_id, rank, arena_score, roi, handle, avatar_url')
                .eq('source', source)
                .eq('season_id', '90D')
                .filter('rank_publication_id', 'eq', publication.scoreCohortId)
                .in('source_trader_id', chunk)
                .not('arena_score', 'is', null)
                .limit(chunk.length)
                .abortSignal(signal)
            ).then(({ data, error }) => ({ data, error }))
          )
        }
      }

      const currentResults = await Promise.all(requests)
      const currentError = currentResults.find((result) => result.error)?.error
      if (currentError) throw new Error(`movers rank lookup failed: ${currentError.message}`)
      const rawCurrentRanks = currentResults.flatMap((result) => result.data ?? []) as Array<
        Record<string, unknown>
      >
      const allCurrentRanks = filterPublicRankingRows(rawCurrentRanks, (row) => row.source).filter(
        (row) => {
          const source = String(row.source)
          const traderKey = String(row.source_trader_id)
          return snapsByPlatform.get(source)?.includes(traderKey) === true
        }
      )

      const movers: Mover[] = []
      for (const row of allCurrentRanks) {
        const source = String(row.source)
        const traderKey = String(row.source_trader_id)
        const yesterdayRoi = yesterdayRoiMap.get(`${source}:${traderKey}`)
        if (yesterdayRoi == null || row.roi == null || row.arena_score == null) continue

        const roiDelta = Number(row.roi) - yesterdayRoi
        if (!Number.isFinite(roiDelta) || Math.abs(roiDelta) < 0.5) continue

        movers.push({
          platform: source,
          trader_key: traderKey,
          rank: row.rank != null ? Number(row.rank) : 0,
          arena_score: Number(row.arena_score),
          roiDelta: Math.round(roiDelta * 100) / 100,
          handle: (row.handle as string) || null,
          avatar_url: (row.avatar_url as string) || null,
        })
      }

      movers.sort(
        (left, right) =>
          right.roiDelta - left.roiDelta ||
          left.platform.localeCompare(right.platform) ||
          left.trader_key.localeCompare(right.trader_key)
      )
      const risers = movers.filter((mover) => mover.roiDelta > 0).slice(0, 5)
      const fallers = movers
        .filter((mover) => mover.roiDelta < 0)
        .sort(
          (left, right) =>
            left.roiDelta - right.roiDelta ||
            left.platform.localeCompare(right.platform) ||
            left.trader_key.localeCompare(right.trader_key)
        )
        .slice(0, 5)

      return {
        risers,
        fallers,
        period: '90D' as const,
        snapshotDate: yesterdayDate,
        compareDate: todayDate,
      }
    },
    { timeoutMs: 8_000, signal }
  )
}
