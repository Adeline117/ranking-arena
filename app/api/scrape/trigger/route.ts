/**
 * 触发所有来源的数据抓取
 * GET /api/scrape/trigger?secret=xxx
 * 
 * 在 Vercel 上运行，绕过地区限制
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 分钟

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const CRON_SECRET = process.env.CRON_SECRET

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

// Binance Futures API
async function fetchBinance(period: string): Promise<{ source: string; traders: TraderData[]; avatarCount: number }> {
  const traders: TraderData[] = []
  const apiUrl = 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list'
  
  for (let page = 1; page <= 6; page++) {
    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: JSON.stringify({ pageNumber: page, pageSize: 20, timeRange: period, dataType: 'ROI', favoriteOnly: false }),
      })
      const data = await res.json()
      const list = data?.data?.list || []
      if (list.length === 0) break
      
      list.forEach((item: Record<string, unknown>) => {
        const traderId = String(item.leadPortfolioId || item.portfolioId || '')
        if (!traderId) return
        traders.push({
          traderId,
          nickname: (item.nickName || item.nickname || null) as string | null,
          avatar: (item.userPhoto || item.avatar || null) as string | null,
          roi: parseFloat(String(item.roi ?? 0)),
          pnl: parseFloat(String(item.pnl ?? 0)),
          winRate: parseFloat(String(item.winRate ?? 0)),
          maxDrawdown: parseFloat(String(item.mdd ?? 0)),
          followers: parseInt(String(item.copierCount ?? 0)),
        })
      })
      if (traders.length >= 100) break
      await new Promise(r => setTimeout(r, 300))
    } catch { break }
  }
  
  const avatarCount = traders.filter(t => t.avatar).length
  return { source: 'binance_futures', traders: traders.slice(0, 100), avatarCount }
}

// Bitget Spot API  
async function fetchBitgetSpot(period: string): Promise<{ source: string; traders: TraderData[]; avatarCount: number }> {
  const traders: TraderData[] = []
  const days = period === '7D' ? 7 : period === '30D' ? 30 : 90
  
  try {
    const res = await fetch(`https://www.bitget.com/v1/copy/spot/trader/list?pageNo=1&pageSize=100&orderBy=ROI&sortBy=DESC&timeRange=${days}D`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
    const data = await res.json()
    const list = data?.data?.list || []
    
    list.forEach((item: Record<string, unknown>) => {
      const traderId = String(item.traderId || '')
      if (!traderId) return
      traders.push({
        traderId,
        nickname: (item.nickName || null) as string | null,
        avatar: (item.headPic || null) as string | null,
        roi: parseFloat(String(item.roi ?? 0)),
        pnl: parseFloat(String(item.totalPnl ?? 0)),
        winRate: 0,
        maxDrawdown: 0,
        followers: parseInt(String(item.followCount ?? 0)),
      })
    })
  } catch { /* intentionally empty */ }
  
  const avatarCount = traders.filter(t => t.avatar).length
  return { source: 'bitget_spot', traders: traders.slice(0, 100), avatarCount }
}

// Bitget Futures API
async function fetchBitgetFutures(period: string): Promise<{ source: string; traders: TraderData[]; avatarCount: number }> {
  const traders: TraderData[] = []
  const days = period === '7D' ? 7 : period === '30D' ? 30 : 90
  
  try {
    const res = await fetch(`https://www.bitget.com/v1/copy/mix/trader/list?pageNo=1&pageSize=100&orderBy=ROI&sortBy=DESC&timeRange=${days}D`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
    const data = await res.json()
    const list = data?.data?.list || []
    
    list.forEach((item: Record<string, unknown>) => {
      const traderId = String(item.traderId || '')
      if (!traderId) return
      traders.push({
        traderId,
        nickname: (item.nickName || null) as string | null,
        avatar: (item.headPic || item.headUrl || null) as string | null,
        roi: parseFloat(String(item.roi ?? 0)),
        pnl: parseFloat(String(item.totalProfit ?? 0)),
        winRate: parseFloat(String(item.winRate ?? 0)),
        maxDrawdown: parseFloat(String(item.maxDrawdown ?? 0)),
        followers: parseInt(String(item.followerCount ?? 0)),
      })
    })
  } catch { /* intentionally empty */ }
  
  const avatarCount = traders.filter(t => t.avatar).length
  return { source: 'bitget_futures', traders: traders.slice(0, 100), avatarCount }
}

// MEXC API
async function fetchMexc(period: string): Promise<{ source: string; traders: TraderData[]; avatarCount: number }> {
  const traders: TraderData[] = []
  const days = period === '7D' ? '7' : period === '30D' ? '30' : '90'
  
  try {
    const res = await fetch(`https://www.mexc.com/api/platform/copy/v1/recommend/traders?pageNum=1&pageSize=100&sortType=ROI&days=${days}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
    const data = await res.json()
    const list = data?.data?.list || data?.data || []
    
    if (Array.isArray(list)) {
      list.forEach((item: Record<string, unknown>) => {
        const traderId = String(item.traderId || item.uid || '')
        if (!traderId) return
        const avatar = (item.avatar || item.avatarUrl || null) as string | null
        traders.push({
          traderId,
          nickname: (item.nickName || item.nickname || null) as string | null,
          avatar: avatar && !avatar.includes('banner') ? avatar : null,
          roi: parseFloat(String(item.roi ?? 0)) * (Math.abs(parseFloat(String(item.roi ?? 0))) < 10 ? 100 : 1),
          pnl: parseFloat(String(item.pnl ?? 0)),
          winRate: parseFloat(String(item.winRate ?? 0)),
          maxDrawdown: parseFloat(String(item.mdd ?? 0)),
          followers: parseInt(String(item.followerCount ?? 0)),
        })
      })
    }
  } catch { /* intentionally empty */ }
  
  const avatarCount = traders.filter(t => t.avatar).length
  return { source: 'mexc', traders: traders.slice(0, 100), avatarCount }
}

// 保存数据到数据库
async function saveTraders(source: string, traders: TraderData[], period: string) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return 0
  
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const capturedAt = new Date().toISOString()
  let saved = 0
  
  for (let i = 0; i < traders.length; i++) {
    const t = traders[i]
    try {
      await supabase.from('trader_sources').upsert({
        source,
        source_type: 'leaderboard',
        source_trader_id: t.traderId,
        handle: t.nickname,
        profile_url: t.avatar,
        is_active: true,
      }, { onConflict: 'source,source_trader_id' })
      
      await supabase.from('trader_snapshots').insert({
        source,
        source_trader_id: t.traderId,
        season_id: period,
        rank: i + 1,
        roi: t.roi,
        pnl: t.pnl,
        win_rate: t.winRate,
        max_drawdown: t.maxDrawdown,
        followers: t.followers,
        captured_at: capturedAt,
      })
      saved++
    } catch { /* intentionally empty */ }
  }
  
  return saved
}

export async function GET(request: Request) {
  // Security: Verify CRON_SECRET
  const authHeader = request.headers.get('authorization')
  const { searchParams } = new URL(request.url)
  if (!CRON_SECRET) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 })
  }
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const period = searchParams.get('period') || '90D'
  const results: Array<{ source: string; fetched: number; avatars: number; saved: number }> = []
  
  
  // 并行获取所有来源
  const [binance, bitgetSpot, bitgetFutures, mexc] = await Promise.all([
    fetchBinance(period),
    fetchBitgetSpot(period),
    fetchBitgetFutures(period),
    fetchMexc(period),
  ])
  
  // 保存数据
  for (const data of [binance, bitgetSpot, bitgetFutures, mexc]) {
    const saved = await saveTraders(data.source, data.traders, period)
    results.push({
      source: data.source,
      fetched: data.traders.length,
      avatars: data.avatarCount,
      saved,
    })
  }
  
  const totalAvatars = results.reduce((sum, r) => sum + r.avatars, 0)
  const totalFetched = results.reduce((sum, r) => sum + r.fetched, 0)
  
  return NextResponse.json({
    success: true,
    period,
    totalFetched,
    totalAvatars,
    results,
  })
}
