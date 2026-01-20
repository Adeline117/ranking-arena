/**
 * Binance 数据抓取 API（在 Vercel 服务器运行，绕过地区限制）
 * 
 * GET /api/scrape/binance?period=90D        - 抓取单个时间段
 * GET /api/scrape/binance?period=all        - 抓取所有时间段 (7D, 30D, 90D)
 * POST /api/scrape/binance                  - Cron 调用，抓取所有时间段
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const maxDuration = 120 // 最长运行 120 秒（抓取 3 个时间段需要更多时间）

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const SOURCE = 'binance_futures'
const ALL_PERIODS = ['7D', '30D', '90D']

interface BinanceTrader {
  leadPortfolioId: string
  portfolioId?: string
  encryptedUid?: string
  nickName?: string
  nickname?: string
  displayName?: string
  userPhoto?: string
  avatar?: string
  avatarUrl?: string
  roi?: number
  pnl?: number
  profit?: number
  winRate?: number
  mdd?: number
  maxDrawdown?: number
  copierCount?: number
  followerCount?: number
  followers?: number
  aum?: number
  totalAsset?: number
}

async function fetchBinanceData(period: string): Promise<BinanceTrader[]> {
  const traders: BinanceTrader[] = []
  
  // Binance Copy Trading API
  const apiUrl = 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list'
  
  for (let page = 1; page <= 6; page++) {
    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Origin': 'https://www.binance.com',
          'Referer': 'https://www.binance.com/zh-CN/copy-trading',
        },
        body: JSON.stringify({
          pageNumber: page,
          pageSize: 20,
          timeRange: period,
          dataType: 'ROI',
          order: 'DESC',
          favoriteOnly: false,
        }),
      })
      
      if (!response.ok) {
        console.log(`[${period}] Page ${page} failed: ${response.status}`)
        break
      }
      
      const data = await response.json()
      
      if (data.code !== '000000') {
        console.log(`[${period}] Page ${page} API error: ${data.code}`)
        break
      }
      
      const list = data?.data?.list || []
      
      if (list.length === 0) {
        console.log(`[${period}] Page ${page}: empty`)
        break
      }
      
      traders.push(...list)
      console.log(`[${period}] Page ${page}: ${list.length} traders, total: ${traders.length}`)
      
      if (traders.length >= 100) break
      
      // 延迟避免限流
      await new Promise(resolve => setTimeout(resolve, 300))
    } catch (error) {
      console.error(`[${period}] Page ${page} error:`, error)
      break
    }
  }
  
  return traders.slice(0, 100)
}

async function saveTraders(traders: BinanceTrader[], period: string) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing Supabase credentials')
  }
  
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const capturedAt = new Date().toISOString()
  
  let saved = 0
  let avatarCount = 0
  const topTraders: Array<{ nickname: string; roi: number; pnl: number }> = []
  
  // 先按 ROI 排序
  const sortedTraders = [...traders].sort((a, b) => {
    const roiA = parseFloat(String(a.roi ?? 0))
    const roiB = parseFloat(String(b.roi ?? 0))
    return roiB - roiA
  })
  
  // 批量准备数据
  const sourcesData: Array<{
    source: string
    source_type: string
    source_trader_id: string
    handle: string | null
    profile_url: string | null
    is_active: boolean
  }> = []
  
  const snapshotsData: Array<{
    source: string
    source_trader_id: string
    season_id: string
    rank: number
    roi: number
    pnl: number
    win_rate: number
    max_drawdown: number
    followers: number
    captured_at: string
  }> = []
  
  for (let i = 0; i < sortedTraders.length; i++) {
    const item = sortedTraders[i]
    const traderId = String(item.leadPortfolioId || item.portfolioId || item.encryptedUid || '')
    if (!traderId) continue
    
    const avatar = item.userPhoto || item.avatar || item.avatarUrl || null
    if (avatar) avatarCount++
    
    const roi = parseFloat(String(item.roi ?? 0))
    const pnl = parseFloat(String(item.pnl ?? item.profit ?? 0))
    let winRate = parseFloat(String(item.winRate ?? 0))
    if (winRate > 1) winRate = winRate / 100
    
    const nickname = item.nickName || item.nickname || item.displayName || traderId
    
    // 记录 TOP 5
    if (topTraders.length < 5) {
      topTraders.push({ nickname, roi, pnl })
    }
    
    sourcesData.push({
      source: SOURCE,
      source_type: 'leaderboard',
      source_trader_id: traderId,
      handle: nickname,
      profile_url: avatar,
      is_active: true,
    })
    
    snapshotsData.push({
      source: SOURCE,
      source_trader_id: traderId,
      season_id: period,
      rank: i + 1,
      roi,
      pnl,
      win_rate: winRate,
      max_drawdown: parseFloat(String(item.mdd ?? item.maxDrawdown ?? 0)),
      followers: parseInt(String(item.copierCount ?? item.followerCount ?? item.followers ?? 0)),
      captured_at: capturedAt,
    })
  }
  
  // 批量保存 trader_sources
  if (sourcesData.length > 0) {
    const { error: sourcesError } = await supabase
      .from('trader_sources')
      .upsert(sourcesData, { onConflict: 'source,source_trader_id' })
    
    if (sourcesError) {
      console.log(`[${period}] trader_sources error:`, sourcesError.message)
    }
  }
  
  // 批量保存 trader_snapshots
  if (snapshotsData.length > 0) {
    const { error: snapshotsError } = await supabase
      .from('trader_snapshots')
      .insert(snapshotsData)
    
    if (snapshotsError) {
      console.log(`[${period}] trader_snapshots batch error:`, snapshotsError.message)
      // 如果批量失败，尝试逐条插入
      for (const snapshot of snapshotsData) {
        const { error } = await supabase.from('trader_snapshots').insert(snapshot)
        if (!error) saved++
      }
    } else {
      saved = snapshotsData.length
    }
  }
  
  // 打印 TOP 5 用于验证
  console.log(`[${period}] TOP 5:`)
  topTraders.forEach((t, i) => {
    console.log(`  ${i + 1}. ${t.nickname}: ROI ${t.roi.toFixed(2)}%, PnL $${t.pnl.toFixed(2)}`)
  })
  
  return { saved, avatarCount, topTraders }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const period = searchParams.get('period') || '90D'
  
  // 支持抓取所有时间段
  if (period === 'all') {
    return scrapeAllPeriods()
  }
  
  // 验证 period
  if (!['7D', '30D', '90D'].includes(period)) {
    return NextResponse.json({ error: 'Invalid period' }, { status: 400 })
  }
  
  try {
    console.log(`[Binance Scrape] Starting for ${period}...`)
    
    // 获取数据
    const traders = await fetchBinanceData(period)
    
    if (traders.length === 0) {
      return NextResponse.json({
        success: false,
        message: 'No data fetched (possible region restriction)',
        period,
      })
    }
    
    // 保存数据
    const { saved, avatarCount, topTraders } = await saveTraders(traders, period)
    
    console.log(`[Binance Scrape] Done: ${saved} saved, ${avatarCount} with avatars`)
    
    return NextResponse.json({
      success: true,
      period,
      fetched: traders.length,
      saved,
      avatarCount,
      top5: topTraders,
    })
  } catch (error) {
    console.error('[Binance Scrape] Error:', error)
    return NextResponse.json({
      success: false,
      error: String(error),
    }, { status: 500 })
  }
}

/**
 * POST - Cron 调用，自动抓取所有时间段
 */
export async function POST(request: Request) {
  // 可选：验证 cron secret
  const cronSecret = request.headers.get('x-cron-secret')
  const expectedSecret = process.env.CRON_SECRET
  
  if (expectedSecret && cronSecret !== expectedSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  return scrapeAllPeriods()
}

/**
 * 抓取所有时间段的数据
 */
async function scrapeAllPeriods() {
  const startTime = Date.now()
  const results: Array<{
    period: string
    success: boolean
    fetched?: number
    saved?: number
    top5?: Array<{ nickname: string; roi: number }>
    error?: string
  }> = []
  
  console.log(`[Binance Scrape] Starting ALL periods: ${ALL_PERIODS.join(', ')}`)
  
  for (const period of ALL_PERIODS) {
    try {
      console.log(`\n[Binance Scrape] === ${period} ===`)
      const traders = await fetchBinanceData(period)
      
      if (traders.length === 0) {
        results.push({ period, success: false, error: 'No data fetched' })
        continue
      }
      
      const { saved, topTraders } = await saveTraders(traders, period)
      
      results.push({
        period,
        success: true,
        fetched: traders.length,
        saved,
        top5: topTraders,
      })
      
      console.log(`[Binance Scrape] ${period} done: ${saved} saved`)
      
      // 时间段之间延迟，避免限流
      await new Promise(resolve => setTimeout(resolve, 1000))
    } catch (error) {
      console.error(`[Binance Scrape] ${period} error:`, error)
      results.push({ period, success: false, error: String(error) })
    }
  }
  
  const duration = Date.now() - startTime
  const successCount = results.filter(r => r.success).length
  
  console.log(`\n[Binance Scrape] ALL DONE in ${(duration/1000).toFixed(1)}s: ${successCount}/${ALL_PERIODS.length} successful`)
  
  return NextResponse.json({
    success: successCount === ALL_PERIODS.length,
    source: SOURCE,
    duration,
    results,
  })
}
