/**
 * 获取交易员详情 API
 *
 * 性能优化：
 * - 并行查询所有数据
 * - 内存缓存（5分钟TTL）
 * - 减少数据库往返
 *
 * 数据包括：
 * - 基本信息、绩效数据
 * - 资产偏好（7D/30D/90D）
 * - 收益率曲线（7D/30D/90D）
 * - 仓位历史记录
 * - 项目表现详细数据（夏普比率、跟单者盈亏等）
 * - tracked_since（Arena 首次追踪时间）
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { getServerCache, setServerCache, CacheTTL } from '@/lib/utils/server-cache'
import { createLogger } from '@/lib/utils/logger'
import { TRADER_SOURCES, type SourceType, findTraderSource, findTraderFromSnapshots } from './trader-queries'
import type { TraderSource } from './trader-types'
import { getTraderDetails, getTraderDetailsFromSnapshots } from './trader-transforms'

// 输入验证 schema（支持字母、数字、下划线、连字符、点、中文、0x 地址）
const handleSchema = z.string().min(1).max(255)

const logger = createLogger('trader-api')

// Next.js 缓存配置
export const revalidate = 60 // 1分钟，与 Cache-Control s-maxage 一致

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

// 缓存键前缀
const CACHE_PREFIX = 'trader:'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  const startTime = Date.now()

  try {
    const { handle: rawHandle } = await params

    const parsed = handleSchema.safeParse(rawHandle)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid handle parameter' }, { status: 400 })
    }
    const handle = parsed.data

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 })
    }

    const decodedHandle = decodeURIComponent(handle)

    // Accept optional ?source= param to disambiguate traders with same handle across exchanges
    const sourceParam = request.nextUrl.searchParams.get('source') || ''
    const cacheKey = `${CACHE_PREFIX}${decodedHandle.toLowerCase()}${sourceParam ? `:${sourceParam}` : ''}`

    // 检查缓存
    const cached = getServerCache<ReturnType<typeof getTraderDetails>>(cacheKey)
    if (cached) {
      return NextResponse.json({ ...await cached, cached: true })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

    // 查找交易员 — if source is specified, try that source first
    let found: Awaited<ReturnType<typeof findTraderSource>> = null
    if (sourceParam && TRADER_SOURCES.includes(sourceParam as SourceType)) {
      // Direct lookup by source + source_trader_id or handle
      const { data: byId } = await supabase
        .from('trader_sources')
        .select('source_trader_id, handle, profile_url, avatar_url, market_type')
        .eq('source', sourceParam)
        .eq('source_trader_id', decodedHandle)
        .limit(1)
        .maybeSingle()
      if (byId) {
        found = { source: byId as TraderSource, sourceType: sourceParam as SourceType }
      } else {
        const { data: byHandle } = await supabase
          .from('trader_sources')
          .select('source_trader_id, handle, profile_url, avatar_url, market_type')
          .eq('source', sourceParam)
          .eq('handle', decodedHandle)
          .limit(1)
          .maybeSingle()
        if (byHandle) {
          found = { source: byHandle as TraderSource, sourceType: sourceParam as SourceType }
        }
      }
    }
    if (!found) {
      found = await findTraderSource(supabase, handle)
    }

    if (found) {
      // 从 trader_sources 找到了，获取详细数据
      let data: Record<string, unknown>
      try {
        data = await getTraderDetails(supabase, found.source, found.sourceType) as unknown as Record<string, unknown>
      } catch (detailError) {
        logger.error('getTraderDetails failed, falling back to snapshots', { error: detailError instanceof Error ? detailError.message : String(detailError) })
        // Fallback to basic snapshot data if full detail fetch fails
        data = await getTraderDetailsFromSnapshots(supabase, found.source.source_trader_id, found.sourceType) as unknown as Record<string, unknown>
      }

      // 缓存结果
      setServerCache(cacheKey, data, CacheTTL.MEDIUM)

      const duration = Date.now() - startTime
      const response = NextResponse.json({ ...data, cached: false, fetchTime: duration })
      // Allow CDN/browser to cache for 60s, serve stale for 5min while revalidating
      response.headers.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
      return response
    }

    // trader_sources 没找到，尝试从 trader_snapshots 获取基本数据
    const snapshotFound = await findTraderFromSnapshots(supabase, handle)

    if (!snapshotFound) {
      logger.warn(`No trader found for handle: ${decodedHandle}`)
      const notFoundResponse = NextResponse.json({
        error: 'Trader not found',
        handle: decodedHandle,
      }, { status: 404 })
      // Cache 404s for 5 minutes to avoid hammering DB
      notFoundResponse.headers.set('Cache-Control', 'public, s-maxage=300')
      return notFoundResponse
    }

    // 从快照获取基本数据
    const data = await getTraderDetailsFromSnapshots(supabase, snapshotFound.traderId, snapshotFound.sourceType)

    // 缓存结果
    setServerCache(cacheKey, data, CacheTTL.MEDIUM)

    const duration = Date.now() - startTime
    const response = NextResponse.json({ ...data, cached: false, fetchTime: duration })
    response.headers.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
    return response

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    logger.error('Trader API error', { error: errorMessage })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
