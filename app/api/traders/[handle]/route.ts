/**
 * 获取交易员详情 API
 *
 * 性能优化：
 * - 并行查询所有数据
 * - 内存缓存（5分钟TTL）
 * - 减少数据库往返
 *
 * 数据包括：
 * - 基本信息、绩效数据
 * - 资产偏好（7D/30D/90D）
 * - 收益率曲线（7D/30D/90D）
 * - 仓位历史记录
 * - 项目表现详细数据（夏普比率、跟单者盈亏等）
 * - tracked_since（Arena 首次追踪时间）
 */

import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { withPublic } from '@/lib/api/middleware'
import { createLogger } from '@/lib/utils/logger'
import {
  resolveTrader,
  getTraderDetail,
  toTraderPageData,
  type TraderDetailRankingPublicationRead,
} from '@/lib/data/unified'
import { ApiError } from '@/lib/api/errors'
import { success as apiSuccess, unauthorized as apiUnauthorized } from '@/lib/api/response'
import { getAggregatedStats, findUserByTrader } from '@/lib/data/linked-traders'
import { tieredDel, tieredGetOrSet } from '@/lib/cache/redis-layer'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import { publicRankingCacheKey } from '@/lib/rankings/publication-policy'
import { readSealedRankingGeneration } from '@/lib/rankings/read-sealed-ranking-generation'
import {
  createSealedRankingCacheEntry,
  parseSealedRankingCacheEntry,
  type SealedRankingCacheEntry,
} from '@/lib/rankings/sealed-ranking-cache'

// 输入验证 schema（支持字母、数字、下划线、连字符、点、中文、0x 地址）
const handleSchema = z.string().min(1).max(255)

const logger = createLogger('trader-api')

// Ranking authority is revalidated inside the handler on every request. A
// route/CDN cache would bypass that proof check entirely.
export const dynamic = 'force-dynamic'
export const revalidate = 0

// 缓存键前缀
const CACHE_PREFIX = publicRankingCacheKey('trader:sealed-v2:')
const TRADER_PAGE_SEASONS = ['7D', '30D', '90D'] as const
const SEALED_TRADER_PAGE_CACHE_CONTRACT = 'sealed-trader-page-cache@1'
const SEALED_TRADER_PAGE_BINDING_CONTRACT = 'sealed-trader-page-binding@1'
const RANKING_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

type TraderPageSeason = (typeof TRADER_PAGE_SEASONS)[number]

interface TraderPageValue {
  readonly pageData: unknown
  readonly resolved: {
    readonly platform: string
    readonly traderKey: string
  }
}

interface SealedTraderPageBinding {
  readonly contract: typeof SEALED_TRADER_PAGE_BINDING_CONTRACT
  readonly platform: string
  readonly traderKey: string
  readonly valueSha256: string
}

interface SealedTraderPageCache {
  readonly contract: typeof SEALED_TRADER_PAGE_CACHE_CONTRACT
  readonly value: TraderPageValue
  readonly windows: Record<TraderPageSeason, SealedRankingCacheEntry<SealedTraderPageBinding>>
}

interface ParsedSealedTraderPageCache {
  readonly value: TraderPageValue
  readonly publicationIdentities: Readonly<Record<TraderPageSeason, string>>
}

function withRankingNoStore(response: NextResponse): NextResponse {
  for (const [header, value] of Object.entries(RANKING_NO_STORE_HEADERS)) {
    response.headers.set(header, value)
  }
  return response
}

/**
 * E2E test fixture mode — returns deterministic mock data when the
 * `?e2e_fixture=` query param is set. Used by Playwright tests to make
 * the linked-account-tabs flow deterministic without depending on prod
 * data shape. Production traffic never sets this param, so this branch
 * is dead code from a user perspective.
 *
 * Available fixtures:
 *   - `linked_accounts`  → totalAccounts: 2, two synthetic accounts
 *   - `single_account`   → totalAccounts: 1
 *   - `not_found`        → 404 response
 */
const E2E_FIXTURES: Record<string, () => unknown> = {
  linked_accounts: () => ({
    profile: {
      id: 'e2e-fixture',
      handle: 'e2e_trader_fixture',
      avatar_url: null,
      bio: null,
      platform: 'binance_futures',
      trader_key: 'e2e-primary-key',
    },
    performance: {
      arena_score: 85,
      roi_90d: 180.5,
      pnl: 250000,
      win_rate: 65,
      max_drawdown: 22,
      rank: 42,
      sharpe_ratio: 2.1,
    },
    stats: null,
    portfolio: [],
    positionHistory: [],
    equityCurve: { '90D': [], '30D': [], '7D': [] },
    assetBreakdown: { '90D': [], '30D': [], '7D': [] },
    similarTraders: [],
    aggregate: {
      aggregated: {
        combinedPnl: 370000,
        bestRoi: { value: 180.5, platform: 'binance_futures', traderKey: 'e2e-primary-key' },
        weightedScore: 81,
      },
      totalAccounts: 2,
      accounts: [
        {
          id: 'e2e-1',
          platform: 'binance_futures',
          traderKey: 'e2e-primary-key',
          handle: 'e2e_primary',
          label: 'Primary',
          isPrimary: true,
          roi: 180.5,
          pnl: 250000,
          arenaScore: 85,
          winRate: 65,
          maxDrawdown: 22,
          rank: 42,
        },
        {
          id: 'e2e-2',
          platform: 'bybit',
          traderKey: 'e2e-linked-key',
          handle: 'e2e_secondary',
          label: 'Secondary',
          isPrimary: false,
          roi: 95.2,
          pnl: 120000,
          arenaScore: 72,
          winRate: 61,
          maxDrawdown: 18,
          rank: 87,
        },
      ],
    },
    claim_status: {
      trader_id: 'e2e-primary-key',
      source: 'binance_futures',
      is_verified: false,
      owner_id: null,
    },
    rank_history: { history: [] },
  }),
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  const { handle: rawHandle } = await params

  const handler = withPublic(
    async ({ supabase, request: req }) => {
      const startTime = Date.now()

      const parsed = handleSchema.safeParse(rawHandle)
      if (!parsed.success) {
        throw ApiError.validation('Invalid handle parameter')
      }
      const handle = parsed.data

      const decodedHandle = decodeURIComponent(handle)

      // E2E test fixture short-circuit (only when explicitly requested via
      // query param). Returns deterministic mock data so Playwright tests
      // don't depend on prod data shape.
      const fixtureName = req.nextUrl.searchParams.get('e2e_fixture')
      if (process.env.NODE_ENV !== 'production' && fixtureName && E2E_FIXTURES[fixtureName]) {
        return apiSuccess(E2E_FIXTURES[fixtureName]())
      }

      // Accept optional ?source= param to disambiguate traders with same handle across exchanges
      const sourceParam = req.nextUrl.searchParams.get('source') || ''
      const consistencyProbeRequested = req.nextUrl.searchParams.get('consistency_probe') === '1'
      const consistencyProbe = consistencyProbeRequested && verifyCronSecret(req)
      if (consistencyProbeRequested && !consistencyProbe) {
        const response = apiUnauthorized('Unauthorized')
        response.headers.set('Pragma', 'no-cache')
        response.headers.set('Vary', 'Authorization')
        return withRankingNoStore(response)
      }

      // Resolve on every request before consulting the detail cache. A handle can
      // be reassigned or its source can leave dynamic publication authority; a
      // handle-keyed cache must not keep routing traffic to the former identity.
      const resolvedTrader = await Promise.race([
        resolveTrader(supabase, {
          handle: decodedHandle,
          platform: sourceParam || undefined,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(ApiError.notFound('Trader lookup timed out')), 3_000)
        ),
      ])
      if (!resolvedTrader) {
        throw ApiError.notFound('Trader not found')
      }
      const resolvedIdentity = {
        platform: resolvedTrader.platform,
        traderKey: resolvedTrader.traderKey,
      }
      const cacheKey = `${CACHE_PREFIX}${resolvedTrader.platform}:${encodeURIComponent(resolvedTrader.traderKey)}`

      const fetchTraderData = async (requirePublicationProofs: boolean) => {
        let rankingPublications: readonly TraderDetailRankingPublicationRead[] | null = null
        const detail = await Promise.race([
          getTraderDetail(supabase, {
            platform: resolvedTrader.platform,
            traderKey: resolvedTrader.traderKey,
            onRankingPublications: (reads) => {
              rankingPublications = reads
            },
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(ApiError.notFound('Trader lookup timed out')), 3_000)
          ),
        ])

        if (!detail) {
          throw ApiError.notFound('No data for trader')
        }
        const capturedPublications = rankingPublications as
          | readonly TraderDetailRankingPublicationRead[]
          | null
        if (
          requirePublicationProofs &&
          capturedPublications?.length !== TRADER_PAGE_SEASONS.length
        ) {
          throw new Error('trader detail did not expose all sealed ranking publications')
        }

        return {
          value: {
            pageData: toTraderPageData(detail),
            resolved: resolvedIdentity,
          },
          rankingPublications: capturedPublications ?? [],
        }
      }

      // The CI consistency probe compares the API with a just-read authoritative
      // leaderboard row. Its CRON_SECRET-authenticated path must bypass the warm
      // 2m memory / 15m Redis tier; otherwise expected cache age looks like drift.
      let data: TraderPageValue
      if (consistencyProbe) {
        data = (await fetchTraderData(false)).value
      } else {
        const fetchSealedTraderData = async () => {
          const fresh = await fetchTraderData(true)
          return createSealedTraderPageCache(fresh.value, fresh.rankingPublications)
        }
        const readAuthorizedCache = async () => {
          const cached = await tieredGetOrSet(
            cacheKey,
            fetchSealedTraderData,
            'warm', // warm tier: 2 min memory, 15m Redis
            ['trader']
          )
          const sealedCache = parseSealedTraderPageCache(cached)
          if (
            !sealedCache ||
            sealedCache.value.resolved.platform !== resolvedTrader.platform ||
            sealedCache.value.resolved.traderKey !== resolvedTrader.traderKey
          ) {
            return null
          }

          const currentReads = await Promise.all(
            TRADER_PAGE_SEASONS.map((season) =>
              readSealedRankingGeneration(
                supabase,
                { season, sources: [resolvedTrader.platform] },
                async () => null,
                { timeoutMs: 10_000 }
              )
            )
          )
          return currentReads.every(
            (read) =>
              sealedCache.publicationIdentities[read.publication.season] ===
              read.publicationIdentity
          )
            ? sealedCache.value
            : null
        }

        let cachedData = await readAuthorizedCache()
        if (!cachedData) {
          await tieredDel(cacheKey)
          cachedData = await readAuthorizedCache()
        }
        if (!cachedData) {
          throw new Error('trader detail cache did not satisfy the sealed publication contract')
        }
        data = cachedData
      }

      const { pageData, resolved } = data

      // ── include: bundle additional data into the response ──
      const includeParam = req.nextUrl.searchParams.get('include') || ''
      const includes = includeParam
        ? includeParam.split(',').map((s) => s.trim().toLowerCase())
        : []
      const extras: Record<string, unknown> = {}

      if (includes.length > 0) {
        const promises: Promise<void>[] = []

        // claim status
        if (includes.includes('claim')) {
          promises.push(
            (async () => {
              try {
                const traderId = resolved.traderKey
                const source = resolved.platform
                const { data: verified } = await supabase
                  .from('verified_traders')
                  .select(
                    'id, user_id, display_name, bio, avatar_url, twitter_url, telegram_url, discord_url, website_url, profile_version'
                  )
                  .eq('trader_id', traderId)
                  .eq('source', source)
                  .maybeSingle()

                if (!verified) {
                  extras.claim_status = { trader_id: traderId, source, is_verified: false }
                } else {
                  extras.claim_status = {
                    trader_id: traderId,
                    source,
                    is_verified: true,
                    owner_id: verified.user_id,
                    profile: {
                      display_name: verified.display_name,
                      bio: verified.bio,
                      avatar_url: verified.avatar_url,
                      twitter_url: verified.twitter_url,
                      telegram_url: verified.telegram_url,
                      discord_url: verified.discord_url,
                      website_url: verified.website_url,
                      profile_version: verified.profile_version,
                    },
                  }
                }
              } catch (e) {
                logger.warn('include=claim failed', {
                  error: e instanceof Error ? e.message : String(e),
                })
                extras.claim_status = {
                  trader_id: resolved.traderKey,
                  source: resolved.platform,
                  is_verified: false,
                  _error: 'fetch_failed',
                }
              }
            })()
          )
        }

        // aggregate (multi-account)
        if (includes.includes('aggregate')) {
          promises.push(
            (async () => {
              try {
                const userId = await findUserByTrader(
                  supabase,
                  resolved.platform,
                  resolved.traderKey
                )
                if (!userId) {
                  extras.aggregate = { aggregated: null, accounts: [], totalAccounts: 0 }
                } else {
                  const stats = await getAggregatedStats(supabase, userId)
                  if (!stats) {
                    extras.aggregate = { aggregated: null, accounts: [], totalAccounts: 0 }
                  } else {
                    extras.aggregate = {
                      aggregated: {
                        combinedPnl: stats.combinedPnl,
                        bestRoi: stats.bestRoi,
                        weightedScore: stats.weightedScore,
                      },
                      accounts: stats.accounts.map((a) => ({
                        id: a.id,
                        platform: a.platform,
                        traderKey: a.traderKey,
                        handle: a.handle,
                        label: a.label,
                        isPrimary: a.isPrimary,
                        roi: a.roi,
                        pnl: a.pnl,
                        arenaScore: a.arenaScore,
                        winRate: a.winRate,
                        maxDrawdown: a.maxDrawdown,
                        rank: a.rank,
                      })),
                      totalAccounts: stats.totalAccounts,
                    }
                  }
                }
              } catch (e) {
                logger.warn('include=aggregate failed', {
                  error: e instanceof Error ? e.message : String(e),
                })
                extras.aggregate = {
                  aggregated: null,
                  accounts: [],
                  totalAccounts: 0,
                  _error: 'fetch_failed',
                }
              }
            })()
          )
        }

        // rank history (sparkline)
        if (includes.includes('rank_history')) {
          promises.push(
            (async () => {
              try {
                const period = req.nextUrl.searchParams.get('rh_period') || '90D'
                const days = Math.min(Number(req.nextUrl.searchParams.get('rh_days') || '7'), 30)
                const cutoffDate = new Date()
                cutoffDate.setDate(cutoffDate.getDate() - days)
                const cutoffISO = cutoffDate.toISOString().split('T')[0]

                const { data: rhData, error: rhError } = await supabase
                  .from('rank_history')
                  .select('snapshot_date, rank, arena_score')
                  .eq('platform', resolved.platform)
                  .eq('trader_key', resolved.traderKey)
                  .eq('period', period)
                  .gte('snapshot_date', cutoffISO)
                  .order('snapshot_date', { ascending: true })
                  .limit(days)

                if (rhError) {
                  logger.warn('include=rank_history query error', { error: rhError.message })
                  extras.rank_history = {
                    history: [],
                    platform: resolved.platform,
                    trader_key: resolved.traderKey,
                    period,
                    _error: 'query_failed',
                  }
                } else {
                  extras.rank_history = {
                    history: (rhData || []).map((row) => ({
                      date: row.snapshot_date,
                      rank: row.rank,
                      arena_score: row.arena_score,
                    })),
                    platform: resolved.platform,
                    trader_key: resolved.traderKey,
                    period,
                  }
                }
              } catch (e) {
                logger.warn('include=rank_history failed', {
                  error: e instanceof Error ? e.message : String(e),
                })
                extras.rank_history = { history: [], _error: 'fetch_failed' }
              }
            })()
          )
        }

        await Promise.all(promises)
      }

      const responseData = {
        ...(pageData as Record<string, unknown>),
        ...extras,
        ...(consistencyProbe
          ? { consistency_probe: { cache_bypassed: true, loader: 'unified-live' } }
          : {}),
      }

      const duration = Date.now() - startTime
      const response = apiSuccess({ ...responseData, cached: false, fetchTime: duration })
      if (consistencyProbe) {
        response.headers.set('Pragma', 'no-cache')
        response.headers.set('X-Arena-Consistency-Proof', 'live-loader-v1')
        return withRankingNoStore(response)
      }
      return withRankingNoStore(response)
    },
    { name: 'trader-detail', rateLimit: 'public' }
  )

  return handler(request)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  const expectedKeys = [...expected].sort()
  return (
    keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index])
  )
}

function traderPageValueSha256(value: TraderPageValue): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function createSealedTraderPageCache(
  value: TraderPageValue,
  rankingPublications: readonly TraderDetailRankingPublicationRead[]
): SealedTraderPageCache {
  const publications = new Map(
    rankingPublications.map((read) => [read.publication.season, read] as const)
  )
  if (
    publications.size !== TRADER_PAGE_SEASONS.length ||
    TRADER_PAGE_SEASONS.some((season) => !publications.has(season))
  ) {
    throw new Error('trader detail publication set is incomplete')
  }

  const binding: SealedTraderPageBinding = {
    contract: SEALED_TRADER_PAGE_BINDING_CONTRACT,
    platform: value.resolved.platform,
    traderKey: value.resolved.traderKey,
    valueSha256: traderPageValueSha256(value),
  }
  const windows = {} as SealedTraderPageCache['windows']
  for (const season of TRADER_PAGE_SEASONS) {
    const read = publications.get(season)!
    const proofSources = read.publication.proofs.map((proof) => proof.source)
    if (proofSources.length !== 1 || proofSources[0] !== value.resolved.platform) {
      throw new Error(`trader detail ${season} publication escaped its source scope`)
    }
    windows[season] = createSealedRankingCacheEntry({ ...read, value: binding })
  }

  return {
    contract: SEALED_TRADER_PAGE_CACHE_CONTRACT,
    value,
    windows,
  }
}

function parseSealedTraderPageCache(input: unknown): ParsedSealedTraderPageCache | null {
  try {
    if (
      !isRecord(input) ||
      !hasExactKeys(input, ['contract', 'value', 'windows']) ||
      input.contract !== SEALED_TRADER_PAGE_CACHE_CONTRACT ||
      !isRecord(input.value) ||
      !hasExactKeys(input.value, ['pageData', 'resolved']) ||
      !isRecord(input.value.resolved) ||
      !hasExactKeys(input.value.resolved, ['platform', 'traderKey']) ||
      typeof input.value.resolved.platform !== 'string' ||
      typeof input.value.resolved.traderKey !== 'string' ||
      !Object.prototype.hasOwnProperty.call(input.value, 'pageData') ||
      input.value.pageData === undefined ||
      !isRecord(input.windows) ||
      !hasExactKeys(input.windows, TRADER_PAGE_SEASONS)
    ) {
      return null
    }

    const value: TraderPageValue = {
      pageData: input.value.pageData,
      resolved: {
        platform: input.value.resolved.platform,
        traderKey: input.value.resolved.traderKey,
      },
    }
    const valueSha256 = traderPageValueSha256(value)
    const publicationIdentities = {} as Record<TraderPageSeason, string>
    for (const season of TRADER_PAGE_SEASONS) {
      const entry = parseSealedRankingCacheEntry<SealedTraderPageBinding>(
        input.windows[season],
        season,
        [value.resolved.platform]
      )
      if (
        !entry ||
        !isRecord(entry.value) ||
        !hasExactKeys(entry.value, ['contract', 'platform', 'traderKey', 'valueSha256']) ||
        entry.value.contract !== SEALED_TRADER_PAGE_BINDING_CONTRACT ||
        entry.value.platform !== value.resolved.platform ||
        entry.value.traderKey !== value.resolved.traderKey ||
        entry.value.valueSha256 !== valueSha256
      ) {
        return null
      }
      publicationIdentities[season] = entry.publicationIdentity
    }

    return { value, publicationIdentities }
  } catch {
    return null
  }
}
