/**
 * Binance 数据手动导入 API
 * 
 * 由于 Binance 有严格的反爬保护，此 API 允许管理员手动上传数据
 * 
 * 使用方法:
 * POST /api/admin/import-binance
 * Body: { period: "7D" | "30D" | "90D", data: [...] }
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function getSupabaseEnv() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  return { url, serviceKey }
}

function isAuthorized(req: Request) {
  const secret = process.env.ADMIN_SECRET || process.env.CRON_SECRET || ''
  if (!secret) return false

  // 支持多种认证方式
  const authHeader = req.headers.get('authorization')
  const adminSecret = req.headers.get('x-admin-secret') || ''

  return authHeader === `Bearer ${secret}` || adminSecret === secret
}

interface TraderData {
  portfolioId?: string
  encryptedUid?: string
  leadPortfolioId?: string
  nickName?: string
  nickname?: string
  displayName?: string
  userPhoto?: string
  avatar?: string
  avatarUrl?: string
  roi?: number
  roiPct?: number
  roiRate?: number
  pnl?: number
  profit?: number
  totalProfit?: number
  winRate?: number
  winRatio?: number
  mdd?: number
  maxDrawdown?: number
  copierCount?: number
  followerCount?: number
  followers?: number
  aum?: number
  totalAsset?: number
}

function parseTrader(item: TraderData, rank: number) {
  const traderId = String(item.portfolioId || item.encryptedUid || item.leadPortfolioId || '')
  if (!traderId) return null

  return {
    traderId,
    nickname: item.nickName || item.nickname || item.displayName || null,
    avatar: item.userPhoto || item.avatar || item.avatarUrl || null,
    roi: parseFloat(String(item.roi ?? item.roiPct ?? item.roiRate ?? 0)),
    pnl: parseFloat(String(item.pnl ?? item.profit ?? item.totalProfit ?? 0)),
    winRate: parseFloat(String(item.winRate ?? item.winRatio ?? 0)),
    maxDrawdown: parseFloat(String(item.mdd ?? item.maxDrawdown ?? 0)),
    followers: parseInt(String(item.copierCount ?? item.followerCount ?? item.followers ?? 0)),
    aum: parseFloat(String(item.aum ?? item.totalAsset ?? 0)),
    rank,
  }
}

export async function POST(req: Request) {
  try {
    // 验证权限
    if (!isAuthorized(req)) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }

    // 获取 Supabase 配置
    const { url, serviceKey } = getSupabaseEnv()
    if (!url || !serviceKey) {
      return NextResponse.json({ error: 'Supabase env missing' }, { status: 500 })
    }

    const supabase = createClient(url, serviceKey, {
      auth: { persistSession: false },
    })

    // 解析请求体
    const body = await req.json()
    const { period, data } = body

    // 验证参数
    if (!period || !['7D', '30D', '90D'].includes(period)) {
      return NextResponse.json({ 
        error: 'Invalid period. Must be 7D, 30D, or 90D' 
      }, { status: 400 })
    }

    if (!data) {
      return NextResponse.json({ 
        error: 'Invalid data. Must be an array of traders or API response object' 
      }, { status: 400 })
    }

    // 解析数据
    // 支持多种格式：直接数组或 Binance API 响应格式
    let list: unknown[]
    if (Array.isArray(data)) {
      list = data
    } else if (typeof data === 'object') {
      const obj = data as Record<string, unknown>
      const nestedData = obj.data as Record<string, unknown> | undefined
      list = (nestedData?.list as unknown[]) || 
             (nestedData?.data as unknown[]) || 
             (obj.list as unknown[]) || 
             []
    } else {
      list = []
    }
    
    if (!Array.isArray(list) || list.length === 0) {
      return NextResponse.json({ 
        error: 'No valid trader data found' 
      }, { status: 400 })
    }

    // 解析交易员数据
    const traders = (list as TraderData[])
      .map((item, idx) => parseTrader(item, idx + 1))
      .filter((t): t is NonNullable<typeof t> => t !== null)

    // 按 ROI 排序
    traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
    traders.forEach((t, idx) => t.rank = idx + 1)

    // 保存到数据库
    const capturedAt = new Date().toISOString()
    let saved = 0
    let errors = 0
    const errorMessages: string[] = []

    for (const trader of traders) {
      try {
        // 保存 trader_sources
        await supabase.from('trader_sources').upsert({
          source: 'binance_futures',
          source_type: 'leaderboard',
          source_trader_id: trader.traderId,
          handle: trader.nickname,
          profile_url: trader.avatar,
          is_active: true,
        }, { onConflict: 'source,source_trader_id' })

        // 保存 trader_snapshots
        const { error } = await supabase.from('trader_snapshots').upsert({
          source: 'binance_futures',
          source_trader_id: trader.traderId,
          season_id: period,
          rank: trader.rank,
          roi: trader.roi,
          pnl: trader.pnl,
          win_rate: trader.winRate,
          max_drawdown: trader.maxDrawdown,
          followers: trader.followers || 0,
          captured_at: capturedAt,
        }, { onConflict: 'source,source_trader_id,season_id,captured_at' })

        if (error) {
          errors++
          errorMessages.push(`${trader.traderId}: ${error.message}`)
        } else {
          saved++
        }
      } catch (error: unknown) {
        errors++
        const message = error instanceof Error ? error.message : String(error)
        errorMessages.push(`${trader.traderId}: ${message}`)
      }
    }

    // 返回结果
    return NextResponse.json({
      ok: true,
      period,
      total: traders.length,
      saved,
      errors,
      errorMessages: errorMessages.slice(0, 10), // 只返回前10个错误
      capturedAt,
      sample: traders.slice(0, 5).map(t => ({
        name: t.nickname || t.traderId,
        roi: t.roi,
        rank: t.rank,
      })),
    })

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

// GET 请求返回使用说明
export async function GET() {
  return NextResponse.json({
    endpoint: '/api/admin/import-binance',
    method: 'POST',
    description: 'Import Binance Copy Trading leaderboard data manually',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer <ADMIN_SECRET or CRON_SECRET>',
    },
    body: {
      period: '7D | 30D | 90D',
      data: 'Array of trader objects from Binance API response',
    },
    example: {
      period: '30D',
      data: [
        {
          portfolioId: '123456789',
          nickName: 'TraderName',
          roi: 150.5,
          pnl: 5000,
          winRate: 65,
          mdd: 10.5,
          copierCount: 100,
        },
      ],
    },
    howToGetData: [
      '1. Open https://www.binance.com/en/copy-trading/leaderboard in browser',
      '2. Open DevTools (F12) > Network tab',
      '3. Switch to the desired time period (7D, 30D, 90D)',
      '4. Find the API request containing trader data (usually query-list)',
      '5. Copy the response JSON',
      '6. Send it to this endpoint with the correct period',
    ],
  })
}
