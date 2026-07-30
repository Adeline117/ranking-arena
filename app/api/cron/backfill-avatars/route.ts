/**
 * Backfill missing trader avatars by fetching from exchange APIs
 *
 * GET /api/cron/backfill-avatars?platform=binance_futures&limit=100
 *
 * Runs on Vercel (Japan region) to bypass geo-blocks
 */

import { NextResponse } from 'next/server'
import { PipelineLogger, type PipelineLogHandle } from '@/lib/services/pipeline-logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/utils/logger'
import { parseLimit } from '@/lib/utils/safe-parse'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

const log = createLogger('cron:backfill-avatars')

export const runtime = 'nodejs'
export const preferredRegion = 'sfo1'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function isAuthorized(request: Request): boolean {
  return verifyCronSecret(request)
}

interface AvatarResult {
  platform: string
  total: number
  updated: number
  errors: number
  success?: boolean
  status?: 'success' | 'partial' | 'failed' | 'skipped'
  message?: string
  deferred?: number
}

async function fetchJSON(url: string, options: RequestInit = {}): Promise<unknown> {
  const timeoutSignal = AbortSignal.timeout(15_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
  const resp = await fetch(url, {
    ...options,
    cache: 'no-store',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      Accept: 'application/json',
      ...((options.headers as Record<string, string>) || {}),
    },
    signal,
  })
  if (!resp.ok) {
    throw new Error(`Avatar upstream returned HTTP ${resp.status}`)
  }
  return resp.json()
}

// ── Platform-specific avatar fetchers ──

async function fetchBinanceFuturesAvatar(
  traderId: string,
  signal?: AbortSignal
): Promise<string | null> {
  const data = (await fetchJSON(
    'https://www.binance.com/bapi/futures/v1/public/future/copy-trade/lead-portfolio/detail',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://www.binance.com' },
      body: JSON.stringify({ portfolioId: traderId }),
      signal,
    }
  )) as { data?: { userPhotoUrl?: string } } | null
  return data?.data?.userPhotoUrl || null
}

async function _fetchBinanceSpotAvatar(
  traderId: string,
  signal?: AbortSignal
): Promise<string | null> {
  // Binance spot uses same portfolio API
  const data = (await fetchJSON(
    'https://www.binance.com/bapi/futures/v1/public/future/copy-trade/lead-portfolio/detail',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://www.binance.com' },
      body: JSON.stringify({ portfolioId: traderId }),
      signal,
    }
  )) as { data?: { userPhotoUrl?: string } } | null
  return data?.data?.userPhotoUrl || null
}

async function fetchBybitAvatar(traderId: string, signal?: AbortSignal): Promise<string | null> {
  const data = (await fetchJSON(
    `https://api2.bybit.com/fapi/beehive/public/v1/common/leader/detail?leaderMark=${encodeURIComponent(traderId)}`,
    { headers: { Origin: 'https://www.bybit.com', Referer: 'https://www.bybit.com/' }, signal }
  )) as { result?: { avatar?: string } } | null
  return data?.result?.avatar || null
}

async function fetchBitgetAvatar(traderId: string, signal?: AbortSignal): Promise<string | null> {
  const data = (await fetchJSON(
    `https://www.bitget.com/v1/copy/mix/trader/detail?traderId=${traderId}`,
    { headers: { Origin: 'https://www.bitget.com' }, signal }
  )) as { data?: { traderImg?: string; avatar?: string; headUrl?: string } } | null
  return data?.data?.traderImg || data?.data?.avatar || data?.data?.headUrl || null
}

async function fetchOKXAvatar(traderId: string, signal?: AbortSignal): Promise<string | null> {
  const data = (await fetchJSON(
    `https://www.okx.com/api/v5/copytrading/public-lead-traders/detail?uniqueCode=${encodeURIComponent(traderId)}`,
    { headers: { Origin: 'https://www.okx.com' }, signal }
  )) as { data?: Array<{ portLink?: string }> } | null
  return data?.data?.[0]?.portLink || null
}

async function fetchKuCoinAvatar(traderId: string, signal?: AbortSignal): Promise<string | null> {
  const data = (await fetchJSON(
    `https://www.kucoin.com/_api/copy-trade/leader/detail?leaderId=${traderId}`,
    { headers: { Origin: 'https://www.kucoin.com' }, signal }
  )) as { data?: { avatar?: string; avatarUrl?: string } } | null
  return data?.data?.avatar || data?.data?.avatarUrl || null
}

async function fetchCoinExAvatar(traderId: string, signal?: AbortSignal): Promise<string | null> {
  const data = (await fetchJSON(`https://www.coinex.com/res/copy-trading/trader/${traderId}`, {
    headers: { Origin: 'https://www.coinex.com' },
    signal,
  })) as { data?: { avatar?: string } } | null
  return data?.data?.avatar || null
}

async function fetchHTXAvatar(traderId: string, signal?: AbortSignal): Promise<string | null> {
  const data = (await fetchJSON(
    `https://futures.htx.com/-/x/hbg/v1/futures/copytrading/leaderInfo?userSign=${encodeURIComponent(traderId)}`,
    { signal }
  )) as { data?: { imgUrl?: string; avatar?: string } } | null
  return data?.data?.imgUrl || data?.data?.avatar || null
}

async function fetchWeexAvatar(traderId: string, signal?: AbortSignal): Promise<string | null> {
  const data = (await fetchJSON(
    `https://www.weex.com/gateway/v1/futures/copy-trade/trader/detail?traderId=${traderId}`,
    { headers: { Origin: 'https://www.weex.com' }, signal }
  )) as { data?: { headPic?: string; avatar?: string } } | null
  return data?.data?.headPic || data?.data?.avatar || null
}

async function fetchMEXCAvatar(traderId: string, signal?: AbortSignal): Promise<string | null> {
  const data = (await fetchJSON(
    `https://futures.mexc.com/api/platform/copy-trade/trader/detail?traderId=${traderId}`,
    { headers: { Origin: 'https://futures.mexc.com' }, signal }
  )) as { data?: { avatar?: string } } | null
  return data?.data?.avatar || null
}

async function fetchBingXAvatar(traderId: string, signal?: AbortSignal): Promise<string | null> {
  const data = (await fetchJSON(
    `https://bingx.com/api/copy/public/v1/trader/detail?uniqueId=${traderId}`,
    { headers: { Origin: 'https://bingx.com' }, signal }
  )) as { data?: { headUrl?: string; avatar?: string } } | null
  return data?.data?.headUrl || data?.data?.avatar || null
}

async function fetchPhemexAvatar(traderId: string, signal?: AbortSignal): Promise<string | null> {
  const data = (await fetchJSON(
    `https://api.phemex.com/api/copy/v1/leader/detail?traderId=${traderId}`,
    { headers: { Origin: 'https://phemex.com' }, signal }
  )) as { data?: { avatar?: string } } | null
  return data?.data?.avatar || null
}

// fetchLBankAvatar: REMOVED — lbank permanently dead (API 404 since 2026-04)

async function fetchBlofinAvatar(traderId: string, signal?: AbortSignal): Promise<string | null> {
  const data = (await fetchJSON(
    `https://openapi.blofin.com/api/v1/copytrading/public-lead-traders/detail?uniqueCode=${traderId}`,
    { signal }
  )) as { data?: Array<{ avatar?: string; portraitLink?: string }> } | null
  return data?.data?.[0]?.avatar || data?.data?.[0]?.portraitLink || null
}

async function fetchXTAvatar(traderId: string, signal?: AbortSignal): Promise<string | null> {
  const data = (await fetchJSON(
    `https://www.xt.com/fapi/user/v1/public/copy-trade/leader-detail?accountId=${traderId}`,
    {
      headers: {
        Origin: 'https://www.xt.com',
        Referer: 'https://www.xt.com/en/copy-trading/futures',
      },
      signal,
    }
  )) as { result?: { avatar?: string } } | null
  return data?.result?.avatar || null
}

// Bulk leaderboard fetchers for platforms that support it
// Max 120s per bulk fetch to stay within serverless budget
const BULK_DEADLINE_MS = 120_000

async function fetchXTBulk(signal?: AbortSignal): Promise<Map<string, string>> {
  const avatarMap = new Map<string, string>()

  for (const sortType of ['INCOME_RATE', 'TOTAL_INCOME', 'WIN_RATE', 'FOLLOWERS']) {
    for (const days of [7, 30, 90]) {
      for (let pageNo = 1; pageNo <= 100; pageNo++) {
        const data = (await fetchJSON(
          `https://www.xt.com/fapi/user/v1/public/copy-trade/elite-leader-list-v2?size=50&days=${days}&sotType=${sortType}&pageNo=${pageNo}`,
          {
            headers: {
              Origin: 'https://www.xt.com',
              Referer: 'https://www.xt.com/en/copy-trading/futures',
            },
            signal,
          }
        )) as {
          returnCode?: number
          result?: Array<{ items?: Array<{ accountId?: string | number; avatar?: string }> }>
        } | null

        if (!data || data.returnCode !== 0) break

        const items: Array<{ accountId?: string | number; avatar?: string }> = []
        if (Array.isArray(data.result)) {
          for (const group of data.result) {
            if (group.items) items.push(...group.items)
          }
        }

        for (const item of items) {
          const id = String(item.accountId || '')
          if (id && item.avatar && !item.avatar.includes('default')) {
            avatarMap.set(id, item.avatar)
          }
        }

        if (items.length < 50) break
        await sleep(200)
      }
    }
  }

  return avatarMap
}

async function fetchHTXBulk(signal?: AbortSignal): Promise<Map<string, string>> {
  const avatarMap = new Map<string, string>()

  for (let page = 1; page <= 30; page++) {
    const data = (await fetchJSON(
      `https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank?rankType=1&pageNo=${page}&pageSize=50`,
      { signal }
    )) as {
      code?: number
      data?: {
        itemList?: Array<{ userSign?: string; uid?: number; nickName?: string; imgUrl?: string }>
      }
    } | null

    const items = data?.data?.itemList || []
    if (!items.length) break

    for (const t of items) {
      if (t.imgUrl) {
        if (t.userSign) avatarMap.set(t.userSign, t.imgUrl)
        if (t.uid) avatarMap.set(String(t.uid), t.imgUrl)
        if (t.nickName) avatarMap.set(t.nickName, t.imgUrl)
      }
    }
    if (items.length < 50) break
    await sleep(300)
  }

  return avatarMap
}

async function fetchOKXBulk(signal?: AbortSignal): Promise<Map<string, string>> {
  const avatarMap = new Map<string, string>()

  for (let page = 1; page <= 50; page++) {
    const data = (await fetchJSON(
      `https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SWAP&page=${page}`,
      { signal }
    )) as { data?: Array<{ ranks?: Array<{ uniqueCode?: string; portLink?: string }> }> } | null

    const ranks = data?.data?.[0]?.ranks || []
    if (!ranks.length) break

    for (const t of ranks) {
      if (t.uniqueCode && t.portLink) avatarMap.set(t.uniqueCode, t.portLink)
    }
    if (ranks.length < 10) break
    await sleep(300)
  }

  return avatarMap
}

async function fetchBinanceBulk(signal?: AbortSignal): Promise<Map<string, string>> {
  const avatarMap = new Map<string, string>()

  // Try multiple ranking endpoints
  for (const timeRange of ['WEEKLY', 'MONTHLY', 'ALL']) {
    for (let page = 1; page <= 20; page++) {
      const data = (await fetchJSON(
        'https://www.binance.com/bapi/futures/v1/public/future/copy-trade/lead-portfolio/list',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'https://www.binance.com' },
          body: JSON.stringify({ pageNumber: page, pageSize: 50, timeRange }),
          signal,
        }
      )) as { data?: { list?: Array<{ portfolioId?: string; userPhotoUrl?: string }> } } | null

      const list = data?.data?.list || []
      if (!list.length) break

      for (const t of list) {
        if (t.portfolioId && t.userPhotoUrl && !t.userPhotoUrl.includes('default')) {
          avatarMap.set(t.portfolioId, t.userPhotoUrl)
        }
      }
      if (list.length < 50) break
      await sleep(300)
    }
  }

  return avatarMap
}

async function fetchBybitBulk(signal?: AbortSignal): Promise<Map<string, string>> {
  const avatarMap = new Map<string, string>()

  for (const timeRange of ['SEVEN_DAY', 'THIRTY_DAY', 'NINETY_DAY']) {
    for (let page = 1; page <= 20; page++) {
      const data = (await fetchJSON(
        `https://api2.bybit.com/fapi/beehive/public/v1/common/leader/list?pageNo=${page}&pageSize=50&timeRange=${timeRange}&dataSortType=FOLLOWER_PNL_SORT&isRookie=0`,
        {
          headers: { Origin: 'https://www.bybit.com', Referer: 'https://www.bybit.com/' },
          signal,
        }
      )) as { result?: Array<{ leaderMark?: string; avatar?: string }> } | null

      const list = data?.result || []
      if (!list.length) break

      for (const t of list) {
        if (t.leaderMark && t.avatar && !t.avatar.includes('default')) {
          avatarMap.set(t.leaderMark, t.avatar)
        }
      }
      if (list.length < 50) break
      await sleep(300)
    }
  }

  return avatarMap
}

async function fetchBitgetBulk(signal?: AbortSignal): Promise<Map<string, string>> {
  const avatarMap = new Map<string, string>()

  for (const periodType of [1, 2, 3]) {
    // 7d, 30d, 90d
    for (let page = 1; page <= 20; page++) {
      const data = (await fetchJSON(
        `https://www.bitget.com/v1/copy/mix/trader/list?pageNo=${page}&pageSize=50&periodType=${periodType}`,
        { headers: { Origin: 'https://www.bitget.com' }, signal }
      )) as {
        data?: {
          list?: Array<{ traderId?: string; headUrl?: string; avatar?: string; traderImg?: string }>
        }
      } | null

      const list = data?.data?.list || []
      if (!list.length) break

      for (const t of list) {
        const avatar = t.headUrl || t.avatar || t.traderImg
        if (t.traderId && avatar && !avatar.includes('default')) {
          avatarMap.set(t.traderId, avatar)
        }
      }
      if (list.length < 50) break
      await sleep(300)
    }
  }

  return avatarMap
}

// Map platform to fetcher
const INDIVIDUAL_FETCHERS: Record<
  string,
  (id: string, signal?: AbortSignal) => Promise<string | null>
> = {
  binance_futures: fetchBinanceFuturesAvatar,
  // binance_spot: REMOVED 2026-03-14
  bybit: fetchBybitAvatar,
  bitget_futures: fetchBitgetAvatar,
  okx_futures: fetchOKXAvatar,
  kucoin: fetchKuCoinAvatar,
  coinex: fetchCoinExAvatar,
  htx_futures: fetchHTXAvatar,
  htx: fetchHTXAvatar,
  weex: fetchWeexAvatar,
  mexc: fetchMEXCAvatar,
  bingx: fetchBingXAvatar,
  phemex: fetchPhemexAvatar,
  blofin: fetchBlofinAvatar,
  xt: fetchXTAvatar,
}

const BULK_FETCHERS: Record<string, (signal?: AbortSignal) => Promise<Map<string, string>>> = {
  xt: fetchXTBulk,
  htx_futures: fetchHTXBulk,
  htx: fetchHTXBulk,
  okx_futures: fetchOKXBulk,
  binance_futures: fetchBinanceBulk,
  // binance_spot: REMOVED 2026-03-14
  bybit: fetchBybitBulk,
  bitget_futures: fetchBitgetBulk,
}

const SINGLE_WORK_BUDGET_MS = 250_000
const DATABASE_TIMEOUT_MS = 15_000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function databaseSignal(workSignal: AbortSignal): AbortSignal {
  return AbortSignal.any([workSignal, AbortSignal.timeout(DATABASE_TIMEOUT_MS)])
}

async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function parseAvatarResult(payload: unknown, platform: string, responseOk: boolean): AvatarResult {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      platform,
      total: 0,
      updated: 0,
      errors: 1,
      success: false,
      status: 'failed',
      message: 'Invalid avatar subtask acknowledgement',
    }
  }

  const candidate = payload as Partial<AvatarResult>
  if (
    candidate.platform !== platform ||
    !validCount(candidate.total) ||
    !validCount(candidate.updated) ||
    !validCount(candidate.errors) ||
    candidate.updated > candidate.total ||
    typeof candidate.success !== 'boolean' ||
    !['success', 'partial', 'failed', 'skipped'].includes(String(candidate.status))
  ) {
    return {
      platform,
      total: 0,
      updated: 0,
      errors: 1,
      success: false,
      status: 'failed',
      message: 'Malformed avatar subtask acknowledgement',
    }
  }

  const acknowledged = candidate as AvatarResult
  if (!responseOk || acknowledged.success !== true) {
    return {
      ...acknowledged,
      success: false,
      status: acknowledged.status === 'partial' ? 'partial' : 'failed',
      errors: Math.max(acknowledged.errors, 1),
    }
  }
  return acknowledged
}

async function confirmAvatarUpdate(
  query: {
    select(columns: string): {
      abortSignal(signal: AbortSignal): PromiseLike<{
        data: Array<{ id: string | number }> | null
        error: { message?: string } | null
      }>
    }
  },
  expectedId: string | number,
  workSignal: AbortSignal
): Promise<void> {
  const { data, error } = await query.select('id').abortSignal(databaseSignal(workSignal))
  if (error || !Array.isArray(data) || data.length !== 1 || data[0]?.id !== expectedId) {
    throw new Error(error?.message || 'Avatar update was not durably acknowledged')
  }
}

async function finalizeAvatarResult(
  plog: PipelineLogHandle,
  result: AvatarResult
): Promise<NextResponse> {
  const deferred = result.deferred ?? 0
  const hasIncompleteWork = result.errors > 0 || deferred > 0
  const noProgressFailure = result.total > 0 && result.updated === 0 && hasIncompleteWork
  const status = noProgressFailure ? 'failed' : hasIncompleteWork ? 'partial' : 'success'
  const success = status === 'success'
  const body = { ...result, success, status }

  if (success) {
    await plog.success(result.updated, body)
  } else if (status === 'partial') {
    await plog.partialSuccess(
      result.updated,
      [`${result.platform}:${result.errors + deferred}`],
      body
    )
  } else {
    await plog.error(new Error(`Avatar backfill failed for ${result.platform}`), body)
  }

  return NextResponse.json(body, {
    status: status === 'failed' ? 503 : status === 'partial' ? 207 : 200,
  })
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const platform = url.searchParams.get('platform')
  const limit = parseLimit(url.searchParams.get('limit'), 200, 500)
  const mode = url.searchParams.get('mode') || 'auto' // 'bulk', 'individual', 'auto'
  const plog = await PipelineLogger.start(`backfill-avatars-${platform || 'unknown'}`)

  if (!['bulk', 'individual', 'auto'].includes(mode)) {
    await plog.error(new Error('invalid avatar backfill mode'))
    return NextResponse.json({ error: 'invalid mode' }, { status: 400 })
  }

  // Skip dead platforms — import from canonical source
  const { DEAD_BLOCKED_PLATFORMS } = await import('@/lib/constants/exchanges')
  const DEAD_PLATFORMS = new Set(DEAD_BLOCKED_PLATFORMS as string[])

  // Support comma-separated platforms for consolidated cron jobs
  if (platform && platform.includes(',')) {
    const requestedPlatforms = platform
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
    const activePlatforms = requestedPlatforms.filter((p) => !DEAD_PLATFORMS.has(p))
    const results: AvatarResult[] = requestedPlatforms
      .filter((p) => DEAD_PLATFORMS.has(p))
      .map((p) => ({
        platform: p,
        total: 0,
        updated: 0,
        errors: 0,
        success: true,
        status: 'skipped',
        message: 'Platform skipped (dead/blocked)',
      }))
    const perPlatformLimit = Math.floor(limit / Math.max(activePlatforms.length, 1)) || 50
    const PER_PLATFORM_TIMEOUT = 18_000 // 18s per platform (14 platforms × 18s = 252s < 300s limit)
    const PER_PLATFORM_WORK_BUDGET_MS = 15_000

    for (const p of activePlatforms) {
      try {
        const subUrl = new URL(request.url)
        subUrl.searchParams.set('platform', p)
        subUrl.searchParams.set('limit', String(perPlatformLimit))
        const subHeaders = new Headers(request.headers)
        subHeaders.set('x-avatar-work-budget-ms', String(PER_PLATFORM_WORK_BUDGET_MS))
        const subReq = new Request(subUrl.toString(), { headers: subHeaders })
        const subRes = await withDeadline(
          GET(subReq),
          PER_PLATFORM_TIMEOUT,
          `Avatar backfill ${p} timed out`
        )
        results.push(parseAvatarResult(await subRes.json(), p, subRes.ok))
      } catch (error) {
        results.push({
          platform: p,
          total: 0,
          updated: 0,
          errors: 1,
          success: false,
          status: 'failed',
          message: errorMessage(error),
        })
      }
    }

    const updated = results.reduce((sum, result) => sum + result.updated, 0)
    const incomplete = results.filter(
      (result) => result.status === 'failed' || result.status === 'partial'
    )
    const successful = results.filter((result) => result.status === 'success')
    const status =
      incomplete.length === 0
        ? 'success'
        : successful.length > 0 || updated > 0
          ? 'partial'
          : 'failed'
    const success = status === 'success'
    const metadata = { status, requested: requestedPlatforms.length, results }

    if (success) {
      await plog.success(updated, metadata)
    } else if (status === 'partial') {
      await plog.partialSuccess(
        updated,
        incomplete.map((result) => result.platform),
        metadata
      )
    } else {
      await plog.error(new Error('All avatar backfill subtasks failed'), metadata)
    }

    return NextResponse.json(
      { success, status, updated, platforms: results },
      { status: status === 'failed' ? 503 : status === 'partial' ? 207 : 200 }
    )
  }

  // Skip single dead platform
  if (platform && DEAD_PLATFORMS.has(platform)) {
    await plog.success(0)
    return NextResponse.json({
      success: true,
      status: 'skipped',
      platform,
      total: 0,
      updated: 0,
      errors: 0,
      message: 'Platform skipped (dead/blocked)',
    })
  }

  if (!platform) {
    await plog.error(new Error('platform parameter required'))
    return NextResponse.json(
      {
        error: 'platform parameter required',
        available: Object.keys(INDIVIDUAL_FETCHERS),
      },
      { status: 400 }
    )
  }

  const supportsRequestedMode =
    mode === 'bulk'
      ? Boolean(BULK_FETCHERS[platform])
      : mode === 'individual'
        ? Boolean(INDIVIDUAL_FETCHERS[platform])
        : Boolean(BULK_FETCHERS[platform] || INDIVIDUAL_FETCHERS[platform])
  if (!supportsRequestedMode) {
    const result: AvatarResult = {
      platform,
      total: 0,
      updated: 0,
      errors: 1,
      success: false,
      status: 'failed',
      message: `No ${mode} avatar fetcher configured for ${platform}`,
    }
    await plog.error(new Error(result.message), { ...result })
    return NextResponse.json(result, { status: 400 })
  }

  const supabase = getSupabaseAdmin() as SupabaseClient
  const startedAt = Date.now()
  const requestedWorkBudget = Number.parseInt(
    request.headers.get('x-avatar-work-budget-ms') || '',
    10
  )
  const workBudgetMs = Number.isFinite(requestedWorkBudget)
    ? Math.min(Math.max(requestedWorkBudget, 5_000), SINGLE_WORK_BUDGET_MS)
    : SINGLE_WORK_BUDGET_MS
  const workSignal = AbortSignal.timeout(workBudgetMs)
  const functionDeadline = startedAt + workBudgetMs
  const result: AvatarResult = { platform, total: 0, updated: 0, errors: 0 }

  try {
    // Get traders with missing avatars
    const traders: Array<{
      id: string | number
      source_trader_id: string
      handle: string | null
    }> = []
    let from = 0
    const MAX_PAGES = 100
    let pageCount = 0
    while (traders.length < limit) {
      workSignal.throwIfAborted()
      if (++pageCount > MAX_PAGES) {
        throw new Error(`Reached MAX_PAGES (${MAX_PAGES}) for ${platform}`)
      }
      const { data, error } = await supabase
        .from('trader_sources')
        .select('id, source_trader_id, handle')
        .eq('source', platform)
        .is('avatar_url', null)
        .order('id', { ascending: true })
        .range(from, from + Math.min(999, limit - traders.length - 1))
        .abortSignal(databaseSignal(workSignal))
      if (error || !Array.isArray(data)) {
        throw new Error(`Avatar source query failed: ${error?.message || 'invalid payload'}`)
      }
      if (data.length === 0) break
      traders.push(...data)
      from += data.length
      if (data.length < 1000) break
    }

    result.total = traders.length
    if (!traders.length) {
      return finalizeAvatarResult(plog, { ...result, message: 'No missing avatars' })
    }

    const updatedIds = new Set<string | number>()

    // Try bulk fetch first. Its signal cancels the fetch loops instead of merely
    // resolving a race while the abandoned work keeps running in the background.
    if (mode !== 'individual' && BULK_FETCHERS[platform]) {
      let bulkMap = new Map<string, string>()
      try {
        const bulkSignal = AbortSignal.any([
          workSignal,
          AbortSignal.timeout(Math.min(BULK_DEADLINE_MS, workBudgetMs)),
        ])
        bulkMap = await BULK_FETCHERS[platform](bulkSignal)
      } catch (error) {
        result.errors++
        log.warn(`Bulk avatar fetch failed for ${platform}`, { error: errorMessage(error) })
      }

      for (const t of traders) {
        if (workSignal.aborted) break
        const avatar = bulkMap.get(t.source_trader_id) || (t.handle ? bulkMap.get(t.handle) : null)
        if (avatar && !avatar.includes('default') && !avatar.includes('blockie')) {
          try {
            const query = supabase
              .from('trader_sources')
              .update({ avatar_url: avatar })
              .eq('id', t.id)
            await confirmAvatarUpdate(query as any, t.id, workSignal)
            result.updated++
            updatedIds.add(t.id)
          } catch (error) {
            result.errors++
            log.warn(`Bulk avatar update failed for ${platform}/${t.source_trader_id}`, {
              error: errorMessage(error),
            })
          }
        }
      }

      if (mode === 'bulk' && result.updated === 0 && result.total > 0 && result.errors === 0) {
        result.errors++
      }
      if (workSignal.aborted) result.deferred = result.total - updatedIds.size

      if (workSignal.aborted) {
        return finalizeAvatarResult(plog, result)
      }

      // If bulk got most of them, return. Rows without a published avatar are
      // legitimate no-ops; only failed stages/deadlines make the result partial.
      if (result.updated > traders.length * 0.5 || mode === 'bulk') {
        return finalizeAvatarResult(plog, result)
      }
    }

    // Fall back to individual fetching for rows not already updated by bulk.
    if (mode !== 'bulk' && INDIVIDUAL_FETCHERS[platform]) {
      const remaining = traders.filter((trader) => !updatedIds.has(trader.id)).slice(0, limit)
      const delayMs = platform.includes('binance') ? 3000 : 1500
      let processed = 0

      for (const trader of remaining) {
        if (Date.now() >= functionDeadline || workSignal.aborted) break
        processed++

        try {
          const avatar = await INDIVIDUAL_FETCHERS[platform](trader.source_trader_id, workSignal)
          if (avatar && !avatar.includes('default') && !avatar.includes('blockie')) {
            const query = supabase
              .from('trader_sources')
              .update({ avatar_url: avatar })
              .eq('id', trader.id)
            await confirmAvatarUpdate(query as any, trader.id, workSignal)
            result.updated++
            updatedIds.add(trader.id)
          }
        } catch (error) {
          log.warn(`Individual fetch failed for ${platform}/${trader.source_trader_id}`, {
            error: errorMessage(error),
          })
          result.errors++
        }

        if (!workSignal.aborted) await sleep(delayMs)
      }

      const deferred = remaining.length - processed
      if (deferred > 0) result.deferred = (result.deferred ?? 0) + deferred
    }

    return finalizeAvatarResult(plog, result)
  } catch (error) {
    const message = errorMessage(error)
    result.errors = Math.max(result.errors, 1)
    result.success = false
    result.status = 'failed'
    result.message = message
    await plog.error(error instanceof Error ? error : new Error(message), { ...result })
    return NextResponse.json(result, { status: workSignal.aborted ? 504 : 500 })
  }
}
// Avatar backfill trigger - Sat Feb  7 18:04:52 PST 2026
