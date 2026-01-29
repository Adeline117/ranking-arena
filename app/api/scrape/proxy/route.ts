/**
 * 通过 Cloudflare Worker 代理抓取交易所数据
 *
 * GET /api/scrape/proxy?period=all  - 抓取所有平台所有时间段
 * GET /api/scrape/proxy?period=7D&platform=binance - 抓取特定平台
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5分钟

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const PROXY_URL = process.env.CLOUDFLARE_PROXY_URL // 例如: https://ranking-arena-proxy.your-account.workers.dev
const PROXY_SECRET = process.env.CLOUDFLARE_PROXY_SECRET

const ALL_PERIODS = ['7D', '30D', '90D']

interface TraderData {
  traderId: string
  nickname: string | null
  avatar: string | null
  roi: number
  pnl: number
  winRate: number
  maxDrawdown: number
  followers: number
}

/**
 * 通过代理获取 Binance 数据
 */
async function fetchBinanceViaProxy(period: string): Promise<TraderData[]> {
  if (!PROXY_URL) {
    console.log('[Proxy] CLOUDFLARE_PROXY_URL not configured')
    return []
  }

  const traders: TraderData[] = []

  for (let page = 1; page <= 6; page++) {
    try {
      const url = `${PROXY_URL}/binance/copy-trading?period=${period}&page=${page}`
      const response = await fetch(url, {
        headers: PROXY_SECRET ? { 'X-Proxy-Secret': PROXY_SECRET } : {},
      })

      if (!response.ok) {
        console.log(`[Binance] Page ${page} failed: ${response.status}`)
        break
      }

      const data = await response.json()

      if (data.code !== '000000') {
        console.log(`[Binance] Page ${page} API error: ${data.code}`)
        break
      }

      const list = data?.data?.list || []
      if (list.length === 0) break

      for (const item of list) {
        const traderId = String(item.leadPortfolioId || item.portfolioId || '')
        if (!traderId) continue

        traders.push({
          traderId,
          nickname: item.nickName || item.nickname || null,
          avatar: item.userPhoto || item.avatar || null,
          roi: parseFloat(String(item.roi ?? 0)),
          pnl: parseFloat(String(item.pnl ?? 0)),
          winRate: parseFloat(String(item.winRate ?? 0)),
          maxDrawdown: parseFloat(String(item.mdd ?? 0)),
          followers: parseInt(String(item.copierCount ?? 0)),
        })
      }

      if (traders.length >= 100) break
      await new Promise(r => setTimeout(r, 300))
    } catch (error: unknown) {
      console.error(`[Binance] Page ${page} error:`, error)
      break
    }
  }

  return traders.slice(0, 100)
}

/**
 * 通过代理获取 Bybit 数据
 */
async function fetchBybitViaProxy(period: string): Promise<TraderData[]> {
  if (!PROXY_URL) return []

  const traders: TraderData[] = []
  const periodDays = period === '7D' ? '7' : period === '30D' ? '30' : '90'

  for (let page = 1; page <= 6; page++) {
    try {
      const url = `${PROXY_URL}/bybit/copy-trading?period=${periodDays}&page=${page}`
      const response = await fetch(url, {
        headers: PROXY_SECRET ? { 'X-Proxy-Secret': PROXY_SECRET } : {},
      })

      if (!response.ok) break

      const data = await response.json()
      const list = data?.result?.data || data?.data?.list || []
      if (list.length === 0) break

      for (const item of list) {
        const traderId = String(item.leaderMark || item.oderId || '')
        if (!traderId) continue

        traders.push({
          traderId,
          nickname: item.nickName || item.nickname || null,
          avatar: item.avatar || null,
          roi: parseFloat(String(item.roi ?? item.roiRate ?? 0)),
          pnl: parseFloat(String(item.pnl ?? 0)),
          winRate: parseFloat(String(item.winRate ?? 0)),
          maxDrawdown: parseFloat(String(item.maxDrawdown ?? item.mdd ?? 0)),
          followers: parseInt(String(item.followerNum ?? 0)),
        })
      }

      if (traders.length >= 100) break
      await new Promise(r => setTimeout(r, 300))
    } catch (error: unknown) {
      console.error(`[Bybit] Page ${page} error:`, error)
      break
    }
  }

  return traders.slice(0, 100)
}

/**
 * 通过代理获取 Bitget 数据
 */
async function fetchBitgetViaProxy(period: string, type: 'futures' | 'spot' = 'futures'): Promise<TraderData[]> {
  if (!PROXY_URL) return []

  const traders: TraderData[] = []
  const periodDays = period === '7D' ? '7' : period === '30D' ? '30' : '90'

  for (let page = 1; page <= 6; page++) {
    try {
      const url = `${PROXY_URL}/bitget/copy-trading?period=${periodDays}&page=${page}&type=${type}`
      const response = await fetch(url, {
        headers: PROXY_SECRET ? { 'X-Proxy-Secret': PROXY_SECRET } : {},
      })

      if (!response.ok) break

      const data = await response.json()
      const list = data?.data?.list || []
      if (list.length === 0) break

      for (const item of list) {
        const traderId = String(item.traderId || '')
        if (!traderId) continue

        traders.push({
          traderId,
          nickname: item.nickName || null,
          avatar: item.headPic || item.headUrl || null,
          roi: parseFloat(String(item.roi ?? 0)),
          pnl: parseFloat(String(item.totalProfit ?? item.totalPnl ?? 0)),
          winRate: parseFloat(String(item.winRate ?? 0)),
          maxDrawdown: parseFloat(String(item.maxDrawdown ?? 0)),
          followers: parseInt(String(item.followerCount ?? item.followCount ?? 0)),
        })
      }

      if (traders.length >= 100) break
      await new Promise(r => setTimeout(r, 300))
    } catch (error: unknown) {
      console.error(`[Bitget] Page ${page} error:`, error)
      break
    }
  }

  return traders.slice(0, 100)
}

/**
 * 保存到数据库
 */
async function saveTraders(source: string, traders: TraderData[], period: string): Promise<number> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || traders.length === 0) return 0

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const capturedAt = new Date().toISOString()
  let saved = 0

  // 按 ROI 排序
  traders.sort((a, b) => b.roi - a.roi)

  for (let i = 0; i < traders.length; i++) {
    const t = traders[i]
    try {
      // Upsert trader_sources
      await supabase.from('trader_sources').upsert({
        source,
        source_type: 'leaderboard',
        source_trader_id: t.traderId,
        handle: t.nickname,
        profile_url: t.avatar,
        is_active: true,
      }, { onConflict: 'source,source_trader_id' })

      // Insert snapshot
      const { error } = await supabase.from('trader_snapshots').insert({
        source,
        source_trader_id: t.traderId,
        season_id: period,
        rank: i + 1,
        roi: t.roi,
        pnl: t.pnl,
        win_rate: t.winRate > 1 ? t.winRate / 100 : t.winRate,
        max_drawdown: t.maxDrawdown,
        followers: t.followers,
        captured_at: capturedAt,
      })

      if (!error) saved++
    } catch {
      // 忽略重复错误
    }
  }

  return saved
}

export async function GET(request: Request) {
  // 验证授权
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // 检查代理配置
  if (!PROXY_URL) {
    return NextResponse.json({
      error: 'CLOUDFLARE_PROXY_URL not configured',
      hint: 'Deploy the Cloudflare Worker and set the environment variable',
    }, { status: 503 })
  }

  const { searchParams } = new URL(request.url)
  const period = searchParams.get('period') || 'all'
  const platform = searchParams.get('platform') || 'all'

  const periods = period === 'all' ? ALL_PERIODS : [period]
  const results: Array<{
    platform: string
    period: string
    fetched: number
    saved: number
  }> = []

  const startTime = Date.now()

  for (const p of periods) {
    // Binance
    if (platform === 'all' || platform === 'binance') {
      console.log(`[Proxy] Fetching Binance ${p}...`)
      const traders = await fetchBinanceViaProxy(p)
      const saved = await saveTraders('binance_futures', traders, p)
      results.push({ platform: 'binance_futures', period: p, fetched: traders.length, saved })
    }

    // Bybit
    if (platform === 'all' || platform === 'bybit') {
      console.log(`[Proxy] Fetching Bybit ${p}...`)
      const traders = await fetchBybitViaProxy(p)
      const saved = await saveTraders('bybit', traders, p)
      results.push({ platform: 'bybit', period: p, fetched: traders.length, saved })
    }

    // Bitget Futures
    if (platform === 'all' || platform === 'bitget') {
      console.log(`[Proxy] Fetching Bitget Futures ${p}...`)
      const traders = await fetchBitgetViaProxy(p, 'futures')
      const saved = await saveTraders('bitget_futures', traders, p)
      results.push({ platform: 'bitget_futures', period: p, fetched: traders.length, saved })
    }

    // Bitget Spot
    if (platform === 'all' || platform === 'bitget_spot') {
      console.log(`[Proxy] Fetching Bitget Spot ${p}...`)
      const traders = await fetchBitgetViaProxy(p, 'spot')
      const saved = await saveTraders('bitget_spot', traders, p)
      results.push({ platform: 'bitget_spot', period: p, fetched: traders.length, saved })
    }

    // 延迟避免限流
    await new Promise(r => setTimeout(r, 500))
  }

  const duration = Date.now() - startTime
  const totalFetched = results.reduce((sum, r) => sum + r.fetched, 0)
  const totalSaved = results.reduce((sum, r) => sum + r.saved, 0)

  return NextResponse.json({
    success: totalFetched > 0,
    duration: `${duration}ms`,
    totalFetched,
    totalSaved,
    results,
    timestamp: new Date().toISOString(),
  })
}
