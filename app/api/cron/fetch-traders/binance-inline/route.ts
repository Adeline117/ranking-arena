/**
 * Binance Futures 内联抓取（Vercel Serverless 兼容）
 * 
 * 不依赖 exec/Puppeteer，直接调用 Binance API + 写 Supabase
 * 部署到 Vercel 后，美国 IP 不会被 451 封锁
 * 
 * POST /api/cron/fetch-traders/binance-inline
 * Query: ?period=90D&type=futures|spot
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import logger from '@/lib/logger'

export const runtime = 'nodejs'
export const preferredRegion = 'hnd1' // Tokyo — avoids Binance US geo-blocking
export const dynamic = 'force-dynamic'
export const maxDuration = 60 // Vercel Pro: 60s

// ============================================
// 认证
// ============================================
function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && auth === `Bearer ${cronSecret}`) return true
  // Vercel Cron 自动认证
  if (req.headers.get('x-vercel-cron') === '1') return true
  return false
}

// ============================================
// Arena Score 计算
// ============================================
const clip = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))
const safeLog1p = (x: number) => x <= -1 ? 0 : Math.log(1 + x)

const ARENA_PARAMS: Record<string, { tanhCoeff: number; roiExponent: number; mddThreshold: number; winRateCap: number }> = {
  '7D': { tanhCoeff: 0.08, roiExponent: 1.8, mddThreshold: 15, winRateCap: 62 },
  '30D': { tanhCoeff: 0.15, roiExponent: 1.6, mddThreshold: 30, winRateCap: 68 },
  '90D': { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 },
}

function calculateArenaScore(roi: number, pnl: number, maxDrawdown: number | null, winRate: number | null, period: string): number {
  const params = ARENA_PARAMS[period] || ARENA_PARAMS['90D']
  const days = period === '7D' ? 7 : period === '30D' ? 30 : 90
  const wr = winRate != null ? (winRate <= 1 ? winRate * 100 : winRate) : null
  const intensity = (365 / days) * safeLog1p(roi / 100)
  const r0 = Math.tanh(params.tanhCoeff * intensity)
  const returnScore = r0 > 0 ? clip(85 * Math.pow(r0, params.roiExponent), 0, 85) : 0
  const drawdownScore = maxDrawdown != null ? clip(8 * clip(1 - Math.abs(maxDrawdown) / params.mddThreshold, 0, 1), 0, 8) : 4
  const stabilityScore = wr != null ? clip(7 * clip((wr - 45) / (params.winRateCap - 45), 0, 1), 0, 7) : 3.5
  return Math.round((returnScore + drawdownScore + stabilityScore) * 100) / 100
}

// ============================================
// Binance API
// ============================================
const BINANCE_API = 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list'
const BINANCE_DETAIL = 'https://www.binance.com/bapi/futures/v2/friendly/future/copy-trade/lead-portfolio/query-portfolio'

const PERIOD_MAP: Record<string, number> = { '7D': 7, '30D': 30, '90D': 90 }
const WINDOW_MAP: Record<string, string> = { '7D': 'WEEKLY', '30D': 'MONTHLY', '90D': 'QUARTERLY' }

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'Origin': 'https://www.binance.com',
  'Referer': 'https://www.binance.com/zh-CN/copy-trading',
}

interface BinanceTrader {
  portfolioId?: string
  leadPortfolioId?: string
  nickName?: string
  roi?: string | number
  pnl?: string | number
  winRate?: string | number
  maxDrawdown?: string | number
  mdd?: string | number
  followerCount?: number
  currentCopyCount?: number
  userPhotoUrl?: string
  tradeCount?: number
}

async function fetchBinanceList(period: string, page: number): Promise<BinanceTrader[]> {
  const body = {
    pageNumber: page,
    pageSize: 20,
    timeRange: PERIOD_MAP[period] || 90,
    dataType: 'ROI',
    favoriteOnly: false,
    hideFull: false,
    nickname: '',
    order: 'DESC',
  }

  const res = await fetch(BINANCE_API, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })

  if (!res.ok) {
    logger.warn(`Binance API ${res.status} for page ${page}`)
    return []
  }

  const data = await res.json()
  return data?.data?.list || []
}

async function _fetchBinanceDetail(portfolioId: string, period: string): Promise<BinanceTrader | null> {
  try {
    const res = await fetch(BINANCE_DETAIL, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ portfolioId, timeRange: WINDOW_MAP[period] || 'QUARTERLY' }),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    const data = await res.json()
    return data?.data || null
  } catch {
    return null
  }
}

function parseNum(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'string' ? parseFloat(v) : Number(v)
  return isNaN(n) ? null : n
}

// ============================================
// 主逻辑
// ============================================
export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const url = new URL(req.url)
  const period = url.searchParams.get('period') || '90D'
  const targetCount = parseInt(url.searchParams.get('count') || '500')

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 })
  }

  const supabase = createClient(supabaseUrl, supabaseKey)
  const startTime = Date.now()
  const SOURCE = 'binance_futures'
  const allTraders: BinanceTrader[] = []

  // 1. 获取排行榜
  const maxPages = Math.ceil(targetCount / 20) + 1
  for (let page = 1; page <= maxPages; page++) {
    const traders = await fetchBinanceList(period, page)
    if (traders.length === 0) break
    allTraders.push(...traders)
    if (allTraders.length >= targetCount) break
    // 间隔避免限流
    await new Promise(r => setTimeout(r, 500))
  }

  if (allTraders.length === 0) {
    return NextResponse.json({
      ok: false,
      error: 'Binance API returned no data (possibly geo-blocked)',
      period,
      duration: Date.now() - startTime,
    })
  }

  // 2. 去重
  const seen = new Set<string>()
  const unique = allTraders.filter(t => {
    const id = t.portfolioId || t.leadPortfolioId || ''
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  }).slice(0, targetCount)

  // 3. 保存到 Supabase
  let saved = 0
  let failed = 0
  const batchSize = 50

  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize)
    
    // trader_sources
    const sources = batch.map(t => ({
      source: SOURCE,
      source_trader_id: t.portfolioId || t.leadPortfolioId || '',
      handle: t.nickName || t.portfolioId || t.leadPortfolioId || '',
      profile_url: t.userPhotoUrl || null,
      updated_at: new Date().toISOString(),
    }))

    const { error: srcErr } = await supabase
      .from('trader_sources')
      .upsert(sources, { onConflict: 'source,source_trader_id' })

    if (srcErr) logger.warn('trader_sources upsert error:', srcErr.message)

    // trader_snapshots
    const snapshots = batch.map(t => {
      const roi = parseNum(t.roi)
      const pnl = parseNum(t.pnl)
      const winRate = parseNum(t.winRate)
      const mdd = parseNum(t.maxDrawdown ?? t.mdd)
      const arenaScore = roi != null ? calculateArenaScore(
        roi * 100, pnl || 0, mdd, winRate, period
      ) : null

      return {
        source: SOURCE,
        source_trader_id: t.portfolioId || t.leadPortfolioId || '',
        season_id: period,
        roi: roi,
        pnl: pnl,
        win_rate: winRate != null ? (winRate <= 1 ? winRate * 100 : winRate) : null,
        max_drawdown: mdd != null ? Math.abs(mdd) : null,
        trades_count: t.tradeCount || null,
        followers: t.followerCount || null,
        arena_score: arenaScore,
        captured_at: new Date().toISOString(),
      }
    })

    const { error: snapErr } = await supabase
      .from('trader_snapshots')
      .upsert(snapshots, { onConflict: 'source,source_trader_id,season_id' })

    if (snapErr) {
      logger.warn('trader_snapshots upsert error:', snapErr.message)
      failed += batch.length
    } else {
      saved += batch.length
    }
  }

  const duration = Date.now() - startTime
  return NextResponse.json({
    ok: true,
    period,
    source: SOURCE,
    total: unique.length,
    saved,
    failed,
    duration,
    topRoi: unique[0] ? parseNum(unique[0].roi) : null,
  })
}
