/**
 * Backfill missing trader avatars by fetching from exchange APIs
 * 
 * GET /api/cron/backfill-avatars?platform=binance_futures&limit=100
 * 
 * Runs on Vercel (Japan region) to bypass geo-blocks
 */

import { NextResponse } from 'next/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { env } from '@/lib/env'
import { createLogger } from '@/lib/utils/logger'
import { parseLimit } from '@/lib/utils/safe-parse'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

const log = createLogger('cron:backfill-avatars')

export const runtime = 'nodejs'
export const preferredRegion = 'sfo1'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function isAuthorized(request: Request): boolean {
  return verifyCronSecret(request)
}

interface AvatarResult {
  platform: string
  total: number
  updated: number
  errors: number
}

async function fetchJSON(url: string, options: RequestInit = {}): Promise<unknown> {
  try {
    const resp = await fetch(url, {
      ...options,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        ...(options.headers as Record<string, string> || {}),
      },
      signal: AbortSignal.timeout(15000),
    })
    if (!resp.ok) return null
    return await resp.json()
  } catch (err) {
    log.warn(`fetchJSON failed for ${url}`, { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

// ── Platform-specific avatar fetchers ──

async function fetchBinanceFuturesAvatar(traderId: string): Promise<string | null> {
  const data = await fetchJSON('https://www.binance.com/bapi/futures/v1/public/future/copy-trade/lead-portfolio/detail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': 'https://www.binance.com' },
    body: JSON.stringify({ portfolioId: traderId }),
  }) as { data?: { userPhotoUrl?: string } } | null
  return data?.data?.userPhotoUrl || null
}

async function _fetchBinanceSpotAvatar(traderId: string): Promise<string | null> {
  // Binance spot uses same portfolio API
  const data = await fetchJSON('https://www.binance.com/bapi/futures/v1/public/future/copy-trade/lead-portfolio/detail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': 'https://www.binance.com' },
    body: JSON.stringify({ portfolioId: traderId }),
  }) as { data?: { userPhotoUrl?: string } } | null
  return data?.data?.userPhotoUrl || null
}

async function fetchBybitAvatar(traderId: string): Promise<string | null> {
  const data = await fetchJSON(
    `https://api2.bybit.com/fapi/beehive/public/v1/common/leader/detail?leaderMark=${encodeURIComponent(traderId)}`,
    { headers: { 'Origin': 'https://www.bybit.com', 'Referer': 'https://www.bybit.com/' } },
  ) as { result?: { avatar?: string } } | null
  return data?.result?.avatar || null
}

async function fetchBitgetAvatar(traderId: string): Promise<string | null> {
  const data = await fetchJSON(
    `https://www.bitget.com/v1/copy/mix/trader/detail?traderId=${traderId}`,
    { headers: { 'Origin': 'https://www.bitget.com' } },
  ) as { data?: { traderImg?: string; avatar?: string; headUrl?: string } } | null
  return data?.data?.traderImg || data?.data?.avatar || data?.data?.headUrl || null
}

async function fetchOKXAvatar(traderId: string): Promise<string | null> {
  const data = await fetchJSON(
    `https://www.okx.com/api/v5/copytrading/public-lead-traders/detail?uniqueCode=${encodeURIComponent(traderId)}`,
    { headers: { 'Origin': 'https://www.okx.com' } },
  ) as { data?: Array<{ portLink?: string }> } | null
  return data?.data?.[0]?.portLink || null
}

async function fetchKuCoinAvatar(traderId: string): Promise<string | null> {
  const data = await fetchJSON(
    `https://www.kucoin.com/_api/copy-trade/leader/detail?leaderId=${traderId}`,
    { headers: { 'Origin': 'https://www.kucoin.com' } },
  ) as { data?: { avatar?: string; avatarUrl?: string } } | null
  return data?.data?.avatar || data?.data?.avatarUrl || null
}

async function fetchCoinExAvatar(traderId: string): Promise<string | null> {
  const data = await fetchJSON(
    `https://www.coinex.com/res/copy-trading/trader/${traderId}`,
    { headers: { 'Origin': 'https://www.coinex.com' } },
  ) as { data?: { avatar?: string } } | null
  return data?.data?.avatar || null
}

async function fetchHTXAvatar(traderId: string): Promise<string | null> {
  const data = await fetchJSON(
    `https://futures.htx.com/-/x/hbg/v1/futures/copytrading/leaderInfo?userSign=${encodeURIComponent(traderId)}`,
  ) as { data?: { imgUrl?: string; avatar?: string } } | null
  return data?.data?.imgUrl || data?.data?.avatar || null
}

async function fetchWeexAvatar(traderId: string): Promise<string | null> {
  const data = await fetchJSON(
    `https://www.weex.com/gateway/v1/futures/copy-trade/trader/detail?traderId=${traderId}`,
    { headers: { 'Origin': 'https://www.weex.com' } },
  ) as { data?: { headPic?: string; avatar?: string } } | null
  return data?.data?.headPic || data?.data?.avatar || null
}

async function fetchMEXCAvatar(traderId: string): Promise<string | null> {
  const data = await fetchJSON(
    `https://futures.mexc.com/api/platform/copy-trade/trader/detail?traderId=${traderId}`,
    { headers: { 'Origin': 'https://futures.mexc.com' } },
  ) as { data?: { avatar?: string } } | null
  return data?.data?.avatar || null
}

async function fetchBingXAvatar(traderId: string): Promise<string | null> {
  const data = await fetchJSON(
    `https://bingx.com/api/copy/public/v1/trader/detail?uniqueId=${traderId}`,
    { headers: { 'Origin': 'https://bingx.com' } },
  ) as { data?: { headUrl?: string; avatar?: string } } | null
  return data?.data?.headUrl || data?.data?.avatar || null
}

async function fetchPhemexAvatar(traderId: string): Promise<string | null> {
  const data = await fetchJSON(
    `https://api.phemex.com/api/copy/v1/leader/detail?traderId=${traderId}`,
    { headers: { 'Origin': 'https://phemex.com' } },
  ) as { data?: { avatar?: string } } | null
  return data?.data?.avatar || null
}

async function fetchLBankAvatar(traderId: string): Promise<string | null> {
  const data = await fetchJSON(
    `https://www.lbank.com/api/v2/copy-trade/trader-detail?traderId=${traderId}`,
    { headers: { 'Origin': 'https://www.lbank.com' } },
  ) as { data?: { avatar?: string; headUrl?: string } } | null
  return data?.data?.avatar || data?.data?.headUrl || null
}

async function fetchBlofinAvatar(traderId: string): Promise<string | null> {
  const data = await fetchJSON(
    `https://openapi.blofin.com/api/v1/copytrading/public-lead-traders/detail?uniqueCode=${traderId}`,
  ) as { data?: Array<{ avatar?: string; portraitLink?: string }> } | null
  return data?.data?.[0]?.avatar || data?.data?.[0]?.portraitLink || null
}

async function fetchXTAvatar(traderId: string): Promise<string | null> {
  const data = await fetchJSON(
    `https://www.xt.com/fapi/user/v1/public/copy-trade/leader-detail?accountId=${traderId}`,
    { headers: { 'Origin': 'https://www.xt.com', 'Referer': 'https://www.xt.com/en/copy-trading/futures' } },
  ) as { result?: { avatar?: string } } | null
  return data?.result?.avatar || null
}

// Bulk leaderboard fetchers for platforms that support it
// Max 120s per bulk fetch to stay within serverless budget
const BULK_DEADLINE_MS = 120_000

async function fetchXTBulk(): Promise<Map<string, string>> {
  const avatarMap = new Map<string, string>()

  for (const sortType of ['INCOME_RATE', 'TOTAL_INCOME', 'WIN_RATE', 'FOLLOWERS']) {
    for (const days of [7, 30, 90]) {
      for (let pageNo = 1; pageNo <= 100; pageNo++) {
        const data = await fetchJSON(
          `https://www.xt.com/fapi/user/v1/public/copy-trade/elite-leader-list-v2?size=50&days=${days}&sotType=${sortType}&pageNo=${pageNo}`,
          { headers: { 'Origin': 'https://www.xt.com', 'Referer': 'https://www.xt.com/en/copy-trading/futures' } },
        ) as { returnCode?: number; result?: Array<{ items?: Array<{ accountId?: string | number; avatar?: string }> }> } | null
        
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

async function fetchHTXBulk(): Promise<Map<string, string>> {
  const avatarMap = new Map<string, string>()
  
  for (let page = 1; page <= 30; page++) {
    const data = await fetchJSON(
      `https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank?rankType=1&pageNo=${page}&pageSize=50`,
    ) as { code?: number; data?: { itemList?: Array<{ userSign?: string; uid?: number; nickName?: string; imgUrl?: string }> } } | null
    
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

async function fetchOKXBulk(): Promise<Map<string, string>> {
  const avatarMap = new Map<string, string>()
  
  for (let page = 1; page <= 50; page++) {
    const data = await fetchJSON(
      `https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SWAP&page=${page}`,
    ) as { data?: Array<{ ranks?: Array<{ uniqueCode?: string; portLink?: string }> }> } | null
    
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

async function fetchBinanceBulk(): Promise<Map<string, string>> {
  const avatarMap = new Map<string, string>()
  
  // Try multiple ranking endpoints
  for (const timeRange of ['WEEKLY', 'MONTHLY', 'ALL']) {
    for (let page = 1; page <= 20; page++) {
      const data = await fetchJSON(
        'https://www.binance.com/bapi/futures/v1/public/future/copy-trade/lead-portfolio/list',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Origin': 'https://www.binance.com' },
          body: JSON.stringify({ pageNumber: page, pageSize: 50, timeRange }),
        },
      ) as { data?: { list?: Array<{ portfolioId?: string; userPhotoUrl?: string }> } } | null
      
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

async function fetchBybitBulk(): Promise<Map<string, string>> {
  const avatarMap = new Map<string, string>()
  
  for (const timeRange of ['SEVEN_DAY', 'THIRTY_DAY', 'NINETY_DAY']) {
    for (let page = 1; page <= 20; page++) {
      const data = await fetchJSON(
        `https://api2.bybit.com/fapi/beehive/public/v1/common/leader/list?pageNo=${page}&pageSize=50&timeRange=${timeRange}&dataSortType=FOLLOWER_PNL_SORT&isRookie=0`,
        { headers: { 'Origin': 'https://www.bybit.com', 'Referer': 'https://www.bybit.com/' } },
      ) as { result?: Array<{ leaderMark?: string; avatar?: string }> } | null
      
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

async function fetchBitgetBulk(): Promise<Map<string, string>> {
  const avatarMap = new Map<string, string>()
  
  for (const periodType of [1, 2, 3]) { // 7d, 30d, 90d
    for (let page = 1; page <= 20; page++) {
      const data = await fetchJSON(
        `https://www.bitget.com/v1/copy/mix/trader/list?pageNo=${page}&pageSize=50&periodType=${periodType}`,
        { headers: { 'Origin': 'https://www.bitget.com' } },
      ) as { data?: { list?: Array<{ traderId?: string; headUrl?: string; avatar?: string; traderImg?: string }> } } | null
      
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
const INDIVIDUAL_FETCHERS: Record<string, (id: string) => Promise<string | null>> = {
  binance_futures: fetchBinanceFuturesAvatar,
  // binance_spot: REMOVED 2026-03-14
  bybit: fetchBybitAvatar,
  bitget_futures: fetchBitgetAvatar,
  bitget_spot: fetchBitgetAvatar,
  okx_futures: fetchOKXAvatar,
  kucoin: fetchKuCoinAvatar,
  coinex: fetchCoinExAvatar,
  htx_futures: fetchHTXAvatar,
  htx: fetchHTXAvatar,
  weex: fetchWeexAvatar,
  mexc: fetchMEXCAvatar,
  bingx: fetchBingXAvatar,
  phemex: fetchPhemexAvatar,
  lbank: fetchLBankAvatar,
  blofin: fetchBlofinAvatar,
  xt: fetchXTAvatar,
}

const BULK_FETCHERS: Record<string, () => Promise<Map<string, string>>> = {
  xt: fetchXTBulk,
  htx_futures: fetchHTXBulk,
  htx: fetchHTXBulk,
  okx_futures: fetchOKXBulk,
  binance_futures: fetchBinanceBulk,
  // binance_spot: REMOVED 2026-03-14
  bybit: fetchBybitBulk,
  bitget_futures: fetchBitgetBulk,
  bitget_spot: fetchBitgetBulk,
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

  // Skip dead platforms — import from canonical source
  const { DEAD_BLOCKED_PLATFORMS } = await import('@/lib/constants/exchanges')
  const DEAD_PLATFORMS = new Set(DEAD_BLOCKED_PLATFORMS as string[])

  // Support comma-separated platforms for consolidated cron jobs
  if (platform && platform.includes(',')) {
    const platforms = platform.split(',').map(p => p.trim()).filter(p => p && !DEAD_PLATFORMS.has(p))
    const results: AvatarResult[] = []
    const perPlatformLimit = Math.floor(limit / platforms.length) || 50
    const PER_PLATFORM_TIMEOUT = 18_000 // 18s per platform (14 platforms × 18s = 252s < 300s limit)

    for (const p of platforms) {
      try {
        const subUrl = new URL(request.url)
        subUrl.searchParams.set('platform', p)
        subUrl.searchParams.set('limit', String(perPlatformLimit))
        const subReq = new Request(subUrl.toString(), { headers: request.headers })
        const subRes = await Promise.race([
          GET(subReq),
          new Promise<Response>((_, reject) =>
            setTimeout(() => reject(new Error(`Avatar backfill ${p} timed out`)), PER_PLATFORM_TIMEOUT)
          ),
        ])
        const subData = await subRes.json() as AvatarResult
        results.push(subData)
      } catch (_err) {
        results.push({ platform: p, total: 0, updated: 0, errors: 1 })
      }
    }
    await plog.success(results.reduce((s, r) => s + r.updated, 0))
    return NextResponse.json({ platforms: results })
  }

  // Skip single dead platform
  if (platform && DEAD_PLATFORMS.has(platform)) {
    await plog.success(0)
    return NextResponse.json({ platform, total: 0, updated: 0, errors: 0, message: 'Platform skipped (dead/blocked)' })
  }

  if (!platform) {
    await plog.error(new Error('platform parameter required'))
    return NextResponse.json({
      error: 'platform parameter required',
      available: Object.keys(INDIVIDUAL_FETCHERS),
    }, { status: 400 })
  }

  const supabase = getSupabaseAdmin() as SupabaseClient

  const result: AvatarResult = { platform, total: 0, updated: 0, errors: 0 }

  // Get traders with missing avatars
  const traders: Array<{ id: string; source_trader_id: string; handle: string }> = []
  let from = 0
  const MAX_PAGES = 100
  let pageCount = 0
  while (traders.length < limit) {
    if (++pageCount > MAX_PAGES) {
      log.warn(`Reached MAX_PAGES (${MAX_PAGES}) for ${platform}, breaking`)
      break
    }
    const { data } = await supabase
      .from('trader_sources')
      .select('id, source_trader_id, handle')
      .eq('source', platform)
      .is('avatar_url', null)
      .range(from, from + Math.min(999, limit - traders.length - 1))
    if (!data?.length) break
    traders.push(...data)
    from += 1000
    if (data.length < 1000) break
  }
  
  result.total = traders.length
  if (!traders.length) {
    await plog.success(0)
    return NextResponse.json({ ...result, message: 'No missing avatars' })
  }

  // Try bulk fetch first (timeout 120s to stay within serverless budget)
  if (mode !== 'individual' && BULK_FETCHERS[platform]) {
    const bulkMap = await Promise.race([
      BULK_FETCHERS[platform](),
      new Promise<Map<string, string>>((resolve) =>
        setTimeout(() => resolve(new Map()), BULK_DEADLINE_MS)
      ),
    ])
    
    for (const t of traders) {
      const avatar = bulkMap.get(t.source_trader_id) || bulkMap.get(t.handle)
      if (avatar && !avatar.includes('default') && !avatar.includes('blockie')) {
        const { error } = await supabase
          .from('trader_sources')
          .update({ avatar_url: avatar })
          .eq('id', t.id)
        if (!error) result.updated++
        else result.errors++
      }
    }
    
    // If bulk got most of them, return
    if (result.updated > traders.length * 0.5 || mode === 'bulk') {
      await plog.success(result.updated, { total: result.total, errors: result.errors })
      return NextResponse.json(result)
    }
  }

  // Fall back to individual fetching for remaining
  // Safety: stop 30s before maxDuration to ensure plog.success() runs
  const functionDeadline = Date.now() + 250_000 // ~4m10s of 5m budget
  if (mode !== 'bulk' && INDIVIDUAL_FETCHERS[platform]) {
    const remaining = traders.filter(_t => {
      // Skip already updated
      return true // We'll check via a simpler approach
    })

    const delayMs = platform.includes('binance') ? 3000 : 1500
    let individualUpdated = 0

    for (const t of remaining.slice(0, limit)) {
      if (individualUpdated + result.updated >= limit) break
      if (Date.now() > functionDeadline) break // safety timeout

      try {
        const avatar = await INDIVIDUAL_FETCHERS[platform](t.source_trader_id)
        if (avatar && !avatar.includes('default') && !avatar.includes('blockie')) {
          const { error } = await supabase
            .from('trader_sources')
            .update({ avatar_url: avatar })
            .eq('id', t.id)
          if (!error) { result.updated++; individualUpdated++ }
          else result.errors++
        }
      } catch (err) {
        log.warn(`Individual fetch failed for ${platform}/${t.source_trader_id}`, { error: err instanceof Error ? err.message : String(err) })
        result.errors++
      }

      await sleep(delayMs)
    }
  }

  await plog.success(result.updated, { total: result.total, errors: result.errors })
  return NextResponse.json(result)
}
// Avatar backfill trigger - Sat Feb  7 18:04:52 PST 2026
