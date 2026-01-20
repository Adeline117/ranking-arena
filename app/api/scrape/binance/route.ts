/**
 * Binance 数据抓取 API（在 Vercel 服务器运行，绕过地区限制）
 * 
 * GET /api/scrape/binance?period=90D
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const maxDuration = 60 // 最长运行 60 秒

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const SOURCE = 'binance_futures'

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
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
        body: JSON.stringify({
          pageNumber: page,
          pageSize: 20,
          timeRange: period,
          dataType: 'ROI',
          favoriteOnly: false,
        }),
      })
      
      if (!response.ok) {
        console.log(`Page ${page} failed: ${response.status}`)
        break
      }
      
      const data = await response.json()
      const list = data?.data?.list || []
      
      if (list.length === 0) break
      
      traders.push(...list)
      console.log(`Page ${page}: ${list.length} traders`)
      
      if (traders.length >= 100) break
      
      // 延迟避免限流
      await new Promise(resolve => setTimeout(resolve, 500))
    } catch (error) {
      console.error(`Page ${page} error:`, error)
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
  
  for (let i = 0; i < traders.length; i++) {
    const item = traders[i]
    const traderId = String(item.leadPortfolioId || item.portfolioId || item.encryptedUid || '')
    if (!traderId) continue
    
    const avatar = item.userPhoto || item.avatar || item.avatarUrl || null
    if (avatar) avatarCount++
    
    const roi = parseFloat(String(item.roi ?? 0))
    let winRate = parseFloat(String(item.winRate ?? 0))
    if (winRate > 1) winRate = winRate / 100
    
    try {
      // 保存 trader_sources（包含头像）
      await supabase.from('trader_sources').upsert({
        source: SOURCE,
        source_type: 'leaderboard',
        source_trader_id: traderId,
        handle: item.nickName || item.nickname || item.displayName || null,
        profile_url: avatar,
        is_active: true,
      }, { onConflict: 'source,source_trader_id' })
      
      // 保存 trader_snapshots
      await supabase.from('trader_snapshots').insert({
        source: SOURCE,
        source_trader_id: traderId,
        season_id: period,
        rank: i + 1,
        roi,
        pnl: parseFloat(String(item.pnl ?? item.profit ?? 0)),
        win_rate: winRate,
        max_drawdown: parseFloat(String(item.mdd ?? item.maxDrawdown ?? 0)),
        followers: parseInt(String(item.copierCount ?? item.followerCount ?? item.followers ?? 0)),
        captured_at: capturedAt,
      })
      
      saved++
    } catch (error) {
      // 忽略重复错误
    }
  }
  
  return { saved, avatarCount }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const period = searchParams.get('period') || '90D'
  
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
    const { saved, avatarCount } = await saveTraders(traders, period)
    
    console.log(`[Binance Scrape] Done: ${saved} saved, ${avatarCount} with avatars`)
    
    return NextResponse.json({
      success: true,
      period,
      fetched: traders.length,
      saved,
      avatarCount,
    })
  } catch (error) {
    console.error('[Binance Scrape] Error:', error)
    return NextResponse.json({
      success: false,
      error: String(error),
    }, { status: 500 })
  }
}
