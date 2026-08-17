/**
 * 获取交易员详情 API
 *
 * 公开排名安全：
 * - 并行查询所有数据
 * - 每个响应重读当前 sealed public cohort
 * - 不复用可能跨越 serving-head 变更的排名 payload 缓存
 *
 * 数据包括：
 * - 基本信息、绩效数据
 * - 资产偏好（7D/30D/90D）
 * - 收益率曲线（7D/30D/90D）
 * - 仓位历史记录
 * - 项目表现详细数据（夏普比率、跟单者盈亏等）
 * - tracked_since（Arena 首次追踪时间）
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withPublic } from '@/lib/api/middleware'
import { createLogger } from '@/lib/utils/logger'
import { resolveTrader, getTraderDetail, toTraderPageData } from '@/lib/data/unified'
import { ApiError } from '@/lib/api/errors'
import { success as apiSuccess, unauthorized as apiUnauthorized } from '@/lib/api/response'
import { getAggregatedStats, findUserByTrader } from '@/lib/data/linked-traders'
import { serializePublicLinkedAggregate } from '@/lib/data/linked-trader-public'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import { quarantineLegacyPositionHistory } from '@/lib/data/trader/history-quarantine'

// 输入验证 schema（支持字母、数字、下划线、连字符、点、中文、0x 地址）
const handleSchema = z.string().min(1).max(255)

const logger = createLogger('trader-api')

// A rank-bearing public response needs a current sealed-cohort read. Neither
// the route cache nor a shared response cache can establish that proof.
export const dynamic = 'force-dynamic'
export const revalidate = 0

const PUBLIC_PROFILE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  Pragma: 'no-cache',
} as const

function noStorePublicProfile<T extends Response>(response: T): T {
  for (const [name, value] of Object.entries(PUBLIC_PROFILE_NO_STORE_HEADERS)) {
    response.headers.set(name, value)
  }
  return response
}

const noStoreLinkedMembership = noStorePublicProfile

function requestCarriesLinkedMembership(request: NextRequest): boolean {
  const includes = (request.nextUrl.searchParams.get('include') || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
  return (
    includes.includes('aggregate') ||
    request.nextUrl.searchParams.get('e2e_fixture') === 'linked_accounts'
  )
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
    aggregate: serializePublicLinkedAggregate(
      {
        accounts: [
          {
            id: 'e2e-internal-1',
            userId: 'e2e-private-owner',
            platform: 'binance_futures',
            traderKey: 'e2e-primary-key',
            handle: 'e2e_primary',
            label: 'Private primary label',
            isPrimary: true,
            roi: 180.5,
            pnl: 250000,
            arenaScore: 85,
            winRate: 65,
            maxDrawdown: 22,
            rank: 42,
          },
          {
            id: 'e2e-internal-2',
            userId: 'e2e-private-owner',
            platform: 'bybit',
            traderKey: 'e2e-linked-key',
            handle: 'e2e_secondary',
            label: 'Private secondary label',
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
      { platform: 'binance_futures', traderKey: 'e2e-primary-key' }
    ),
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
        return noStorePublicProfile(apiSuccess(E2E_FIXTURES[fixtureName]()))
      }

      // Accept optional ?source= param to disambiguate traders with same handle across exchanges
      const sourceParam = req.nextUrl.searchParams.get('source') || ''
      const consistencyProbeRequested = req.nextUrl.searchParams.get('consistency_probe') === '1'
      const consistencyProbe = consistencyProbeRequested && verifyCronSecret(req)
      if (consistencyProbeRequested && !consistencyProbe) {
        const response = apiUnauthorized('Unauthorized')
        response.headers.set('Cache-Control', 'private, no-store, max-age=0')
        response.headers.set('Pragma', 'no-cache')
        response.headers.set('Vary', 'Authorization')
        return response
      }

      const fetchTraderData = async () => {
        // 3s timeout for the entire resolve+detail chain.
        // Non-existent traders were taking 31s as resolveTrader searches multiple sources.
        const result = await Promise.race([
          (async () => {
            const resolved = await resolveTrader(supabase, {
              handle: decodedHandle,
              platform: sourceParam || undefined,
            })

            if (!resolved) {
              throw ApiError.notFound('Trader not found')
            }

            const detail = await getTraderDetail(supabase, {
              platform: resolved.platform,
              traderKey: resolved.traderKey,
            })

            if (!detail) {
              throw ApiError.notFound('No data for trader')
            }

            return {
              pageData: toTraderPageData(detail),
              resolved: { platform: resolved.platform, traderKey: resolved.traderKey },
            }
          })(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(ApiError.notFound('Trader lookup timed out')), 3_000)
          ),
        ])
        return result
      }

      // Every public response recomputes the profile projection. A warm payload
      // could outlive a withdrawn serving head and would then leak its old
      // rank-derived fields without a current public-cohort proof.
      const data = await fetchTraderData()

      const { resolved } = data
      const pageData = quarantineLegacyPositionHistory(data.pageData)

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
                    'id, user_id, display_name, bio, avatar_url, twitter_url, telegram_url, discord_url, website_url'
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
                  extras.aggregate = serializePublicLinkedAggregate(null, {
                    platform: resolved.platform,
                    traderKey: resolved.traderKey,
                  })
                } else {
                  const stats = await getAggregatedStats(supabase, userId)
                  extras.aggregate = serializePublicLinkedAggregate(stats, {
                    platform: resolved.platform,
                    traderKey: resolved.traderKey,
                  })
                }
              } catch (e) {
                logger.warn('include=aggregate failed', {
                  error: e instanceof Error ? e.message : String(e),
                })
                extras.aggregate = {
                  subject: {
                    platform: resolved.platform,
                    traderKey: resolved.traderKey,
                  },
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
        response.headers.set('X-Arena-Consistency-Proof', 'live-loader-v1')
      }
      return noStorePublicProfile(response)
    },
    { name: 'trader-detail', rateLimit: 'public' }
  )

  const response = await handler(request)
  return requestCarriesLinkedMembership(request) ? noStoreLinkedMembership(response) : response
}
