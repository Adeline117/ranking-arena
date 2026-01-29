/**
 * MEXC 数据抓取 API（获取交易员头像）
 * 
 * GET /api/scrape/mexc?period=90D
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const SOURCE = 'mexc'

interface MexcTrader {
  traderId?: string
  uid?: string
  id?: string
  userId?: string
  nickName?: string
  nickname?: string
  name?: string
  displayName?: string
  avatar?: string
  avatarUrl?: string
  roi?: number
  totalRoi?: number
  pnlRate?: number
  pnl?: number
  totalPnl?: number
  profit?: number
  winRate?: number
  mdd?: number
  maxDrawdown?: number
  followerCount?: number
  copierCount?: number
  followers?: number
}

async function fetchMexcData(period: string): Promise<MexcTrader[]> {
  const traders: MexcTrader[] = []
  
  // MEXC Copy Trading API
  const apiUrl = 'https://www.mexc.com/api/platform/copy/v1/recommend/traders'
  
  for (let page = 1; page <= 10; page++) {
    try {
      const params = new URLSearchParams({
        pageNum: String(page),
        pageSize: '20',
        sortType: 'ROI',
        days: period === '7D' ? '7' : period === '30D' ? '30' : '90',
      })
      
      const response = await fetch(`${apiUrl}?${params}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
      })
      
      if (!response.ok) {
        console.log(`Page ${page} failed: ${response.status}`)
        break
      }
      
      const data = await response.json()
      const list = data?.data?.list || data?.data || []
      
      if (!Array.isArray(list) || list.length === 0) break
      
      traders.push(...list)
      console.log(`Page ${page}: ${list.length} traders`)
      
      if (traders.length >= 100) break
      
      await new Promise(resolve => setTimeout(resolve, 300))
    } catch (error: unknown) {
      console.error(`Page ${page} error:`, error)
      break
    }
  }
  
  return traders.slice(0, 100)
}

async function saveTraders(traders: MexcTrader[], period: string) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing Supabase credentials')
  }
  
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const capturedAt = new Date().toISOString()
  
  let saved = 0
  let avatarCount = 0
  
  for (let i = 0; i < traders.length; i++) {
    const item = traders[i]
    const traderId = String(item.traderId || item.uid || item.id || item.userId || '')
    if (!traderId) continue
    
    const avatar = item.avatar || item.avatarUrl || null
    if (avatar && !avatar.includes('banner')) avatarCount++
    
    let roi = parseFloat(String(item.roi || item.totalRoi || item.pnlRate || 0))
    if (Math.abs(roi) < 10) roi = roi * 100
    
    try {
      await supabase.from('trader_sources').upsert({
        source: SOURCE,
        source_type: 'leaderboard',
        source_trader_id: traderId,
        handle: item.nickName || item.nickname || item.name || item.displayName || `Trader_${traderId}`,
        profile_url: (avatar && !avatar.includes('banner')) ? avatar : null,
        is_active: true,
      }, { onConflict: 'source,source_trader_id' })
      
      await supabase.from('trader_snapshots').insert({
        source: SOURCE,
        source_trader_id: traderId,
        season_id: period,
        rank: i + 1,
        roi,
        pnl: parseFloat(String(item.pnl || item.totalPnl || item.profit || 0)),
        win_rate: parseFloat(String(item.winRate || 0)) * (item.winRate && item.winRate > 1 ? 1 : 100),
        max_drawdown: parseFloat(String(item.mdd || item.maxDrawdown || 0)),
        followers: parseInt(String(item.followerCount || item.copierCount || item.followers || 0)),
        captured_at: capturedAt,
      })
      
      saved++
    } catch (_error) {
      // 忽略重复错误
    }
  }
  
  return { saved, avatarCount }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const period = searchParams.get('period') || '90D'
  
  if (!['7D', '30D', '90D'].includes(period)) {
    return NextResponse.json({ error: 'Invalid period' }, { status: 400 })
  }
  
  try {
    console.log(`[MEXC Scrape] Starting for ${period}...`)
    
    const traders = await fetchMexcData(period)
    
    if (traders.length === 0) {
      return NextResponse.json({
        success: false,
        message: 'No data fetched',
        period,
      })
    }
    
    const { saved, avatarCount } = await saveTraders(traders, period)
    
    console.log(`[MEXC Scrape] Done: ${saved} saved, ${avatarCount} with avatars`)
    
    return NextResponse.json({
      success: true,
      period,
      fetched: traders.length,
      saved,
      avatarCount,
    })
  } catch (error: unknown) {
    console.error('[MEXC Scrape] Error:', error)
    return NextResponse.json({
      success: false,
      error: String(error),
    }, { status: 500 })
  }
}
