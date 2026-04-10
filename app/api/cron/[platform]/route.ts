/**
 * Dynamic Cron Route for Platform Data Refresh
 * 
 * 统一的平台数据刷新 API
 * 由 QStash 或手动触发
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { z } from 'zod'
import { verifyQStashSignature } from '@/lib/cron/qstash-client'
import { createLogger } from '@/lib/utils/logger'
import { circuitBreaker as circuitBreakerManager, withCircuitBreaker } from '@/lib/middleware/circuit-breaker'
import { env } from '@/lib/env'

const logger = createLogger('CronRoute')

// Edge Runtime for better performance
export const runtime = 'edge'
export const maxDuration = 30 // 30 seconds max

// GET handler for health-check endpoint
export async function GET(
  request: NextRequest,
  { params }: { params: { platform: string } }
) {
  const pathname = request.nextUrl.pathname
  const platform = pathname.split('/').filter(Boolean).pop() || params.platform

  // Special handling for health-check endpoint  
  if (platform === 'health-check') {
    return NextResponse.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      service: 'ranking-arena',
      uptime: 'ok',
    }, { status: 200 })
  }

  // For other platforms, GET is not supported
  return NextResponse.json({
    error: `GET method not supported for platform: ${platform}`,
    message: 'Use POST method for platform data refresh',
  }, { status: 405 })
}

// 平台抓取函数映射
const PLATFORM_FETCHERS: Record<string, () => Promise<PlatformData[]>> = {
  'hyperliquid': fetchHyperliquid,
  'gmx': fetchGMX,
  'gains': fetchGains,
  'okx-futures': fetchOKXFutures,
  'htx-futures': fetchHTXFutures,
  // 更多平台...
}

interface PlatformData {
  trader_key: string
  nickname?: string
  avatar_url?: string
  roi: number
  pnl: number
  win_rate?: number
  max_drawdown?: number
  copiers_count?: number
}

const PlatformDataSchema = z.object({
  trader_key: z.string().min(1),
  nickname: z.string().optional(),
  avatar_url: z.string().optional(),
  roi: z.number().finite(),
  pnl: z.number().finite(),
  win_rate: z.number().finite().min(0).max(100).optional(),
  max_drawdown: z.number().finite().optional(),
  copiers_count: z.number().finite().nonnegative().optional(),
})

export async function POST(
  request: NextRequest,
  { params }: { params: { platform: string } }
) {
  // FIX: Edge Runtime bug - params.platform is undefined
  // Extract platform from URL pathname instead
  const pathname = request.nextUrl.pathname
  const platform = pathname.split('/').filter(Boolean).pop() || params.platform
  const startTime = Date.now()

  try {
    // 1. 验证请求来源
    const signature = request.headers.get('upstash-signature')
    const body = await request.text()
    
    if (signature) {
      const isValid = await verifyQStashSignature(signature, body)
      if (!isValid) {
        logger.warn(`Invalid QStash signature for ${platform}`)
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
    } else {
      // Require CRON_SECRET auth — no dev bypass.
      // SECURITY FIX (2026-04-09, audit P0-SEC-5): the previous dev-mode
      // fallthrough allowed unauthenticated POSTs whenever NODE_ENV
      // happened to be 'development' AND CRON_SECRET was unset, which
      // means a misconfigured preview/staging deploy could expose the
      // entire fetcher fleet (writing to trader_snapshots) without auth.
      // Also use timing-safe compare so the secret isn't leaked through
      // response-time side channels.
      const authHeader = request.headers.get('authorization')
      if (!env.CRON_SECRET) {
        return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 })
      }
      const expected = `Bearer ${env.CRON_SECRET}`
      const actual = authHeader ?? ''
      if (actual.length !== expected.length) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
      const { timingSafeEqual } = await import('node:crypto')
      if (!timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
    }

    // 2. 检查熔断器
    if (circuitBreakerManager.getState(platform) === 'OPEN') {
      logger.warn(`Circuit breaker OPEN for ${platform}, skipping`)
      return NextResponse.json({
        success: false,
        platform,
        message: 'Circuit breaker open',
        retryAfter: 60,
      }, { status: 503 })
    }

    // 3. 获取抓取函数
    const fetcher = PLATFORM_FETCHERS[platform]
    if (!fetcher) {
      return NextResponse.json({
        error: `Unknown platform: ${platform}`,
        availablePlatforms: Object.keys(PLATFORM_FETCHERS),
      }, { status: 400 })
    }

    // 4. 执行抓取
    const wrappedFetcher = withCircuitBreaker(platform, fetcher, () => Promise.resolve([]))
    const data = await wrappedFetcher()
    
    if (!data || data.length === 0) {
      logger.warn(`No data returned for ${platform}`)
      return NextResponse.json({
        success: true,
        platform,
        count: 0,
        message: 'No data available',
        durationMs: Date.now() - startTime,
      })
    }

    // 5. Validate with Zod before DB writes
    const validTraders: PlatformData[] = []
    let rejected = 0
    for (const trader of data) {
      const result = PlatformDataSchema.safeParse(trader)
      if (result.success) {
        validTraders.push(trader)
      } else {
        rejected++
        if (rejected <= 3) {
          const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')
          logger.warn(`[${platform}] Rejected trader ${trader.trader_key}: ${issues}`)
        }
      }
    }
    if (rejected > 0) {
      logger.warn(`[${platform}] ${rejected}/${data.length} traders failed validation`)
    }

    // 6. 写入数据库
    const supabase = getSupabaseAdmin()

    const { error: upsertError } = await supabase
      .from('trader_snapshots')
      .upsert(
        validTraders.map((trader: PlatformData) => ({
          platform,
          trader_key: trader.trader_key,
          nickname: trader.nickname,
          avatar_url: trader.avatar_url,
          season_id: '90D',
          roi: trader.roi,
          pnl: trader.pnl,
          win_rate: trader.win_rate,
          max_drawdown: trader.max_drawdown,
          copiers_count: trader.copiers_count,
          updated_at: new Date().toISOString(),
        })),
        { onConflict: 'platform,trader_key,season_id' }
      )

    if (upsertError) {
      throw upsertError
    }

    const durationMs = Date.now() - startTime
    logger.info(`[OK] ${platform} refresh complete: ${validTraders.length} traders in ${durationMs}ms${rejected > 0 ? ` (${rejected} rejected)` : ''}`)

    return NextResponse.json({
      success: true,
      platform,
      count: validTraders.length,
      rejected,
      durationMs,
    })

  } catch (error) {
    const durationMs = Date.now() - startTime
    logger.error(`[ERROR] ${platform} refresh failed after ${durationMs}ms:`, error)

    return NextResponse.json({
      success: false,
      platform,
      error: error instanceof Error ? error.message : 'Unknown error',
      durationMs,
    }, { status: 500 })
  }
}

// ===== 平台抓取函数 =====

async function fetchHyperliquid(): Promise<PlatformData[]> {
  const response = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'leaderboard' }),
  })

  if (!response.ok) {
    throw new Error(`Hyperliquid API error: ${response.status}`)
  }

  const data = await response.json()
  
  return data.leaderboardRows?.slice(0, 500).map((row: {
    ethAddress: string
    displayName?: string
    accountValue: number
    pnl: number
    roi: number
  }) => ({
    trader_key: row.ethAddress,
    nickname: row.displayName || row.ethAddress.slice(0, 8),
    roi: row.roi * 100,
    pnl: row.pnl,
  })) || []
}

async function fetchGMX(): Promise<PlatformData[]> {
  // GMX GraphQL endpoint
  const query = `
    query {
      tradingStats(first: 500, orderBy: volume, orderDirection: desc) {
        account
        volume
        realisedPnl
        wins
        losses
      }
    }
  `

  const response = await fetch('https://api.thegraph.com/subgraphs/name/gmx-io/gmx-stats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })

  if (!response.ok) {
    throw new Error(`GMX API error: ${response.status}`)
  }

  const data = await response.json()
  
  return data.data?.tradingStats?.map((stat: {
    account: string
    realisedPnl: string
    wins: number
    losses: number
  }) => {
    const pnl = parseFloat(stat.realisedPnl) / 1e30
    const winRate = stat.wins + stat.losses > 0 
      ? (stat.wins / (stat.wins + stat.losses)) * 100 
      : null

    return {
      trader_key: stat.account,
      nickname: stat.account.slice(0, 8),
      pnl,
      roi: 0, // GMX 没有直接的 ROI
      win_rate: winRate,
    }
  }) || []
}

async function fetchGains(): Promise<PlatformData[]> {
  const response = await fetch('https://backend-arbitrum.gains.trade/api/leaderboard', {
    headers: { 'Accept': 'application/json' },
  })

  if (!response.ok) {
    throw new Error(`Gains API error: ${response.status}`)
  }

  const data = await response.json()
  
  return data.slice(0, 500).map((trader: {
    address: string
    pnl: number
    roi: number
    winRate: number
  }) => ({
    trader_key: trader.address,
    nickname: trader.address.slice(0, 8),
    pnl: trader.pnl,
    roi: trader.roi * 100,
    win_rate: trader.winRate * 100,
  }))
}

async function fetchOKXFutures(): Promise<PlatformData[]> {
  const response = await fetch('https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SWAP', {
    headers: { 'Accept': 'application/json' },
  })

  if (!response.ok) {
    throw new Error(`OKX API error: ${response.status}`)
  }

  const data = await response.json()
  
  return data.data?.slice(0, 500).map((trader: {
    uniqueName: string
    nickName: string
    portrait: string
    pnlRatio: string
    pnl: string
    winRatio: string
    copyTraderNum: string
  }) => ({
    trader_key: trader.uniqueName,
    nickname: trader.nickName,
    avatar_url: trader.portrait,
    roi: parseFloat(trader.pnlRatio) * 100,
    pnl: parseFloat(trader.pnl),
    win_rate: parseFloat(trader.winRatio) * 100,
    copiers_count: parseInt(trader.copyTraderNum),
  })) || []
}

async function fetchHTXFutures(): Promise<PlatformData[]> {
  const response = await fetch('https://api.huobi.pro/v2/copy-trading/leaders?limit=500', {
    headers: { 'Accept': 'application/json' },
  })

  if (!response.ok) {
    throw new Error(`HTX API error: ${response.status}`)
  }

  const data = await response.json()
  
  return data.data?.list?.map((trader: {
    leaderId: string
    nickname: string
    avatar: string
    totalRoi: number
    totalPnl: number
    winRate: number
    followerCount: number
  }) => ({
    trader_key: trader.leaderId,
    nickname: trader.nickname,
    avatar_url: trader.avatar,
    roi: trader.totalRoi,
    pnl: trader.totalPnl,
    win_rate: trader.winRate,
    copiers_count: trader.followerCount,
  })) || []
}
