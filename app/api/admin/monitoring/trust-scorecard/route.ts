/**
 * GET /api/admin/monitoring/trust-scorecard
 *
 * 可信度记分卡(P6 2026-07-10):把「数据可信度从底层到用户可见」的六维
 * 进度从每次人肉盘 SQL 变成打开面板 5 秒可见。
 *
 * 数据源 = service_role-only RPC public.arena_trust_scorecard()
 * (migration 20260710103004):序列覆盖(夜间快照表,重查询 14s 不进面板)、
 * 链上净覆盖(实时,轮换侵蚀可见)、认领数、bot 帖节律。
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, verifyAdmin } from '@/lib/admin/auth'
import { createLogger } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

const logger = createLogger('monitoring-trust-scorecard')

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  try {
    const rateLimitResponse = await checkRateLimit(req, RateLimitPresets.sensitive)
    if (rateLimitResponse) return rateLimitResponse

    const supabase = getSupabaseAdmin()
    const admin = await verifyAdmin(supabase, req.headers.get('authorization'))
    if (!admin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data, error } = await supabase.rpc('arena_trust_scorecard')
    if (error) {
      logger.error('arena_trust_scorecard RPC failed', { error: error.message })
      return NextResponse.json({ error: 'Failed to load trust scorecard' }, { status: 500 })
    }
    return NextResponse.json({
      ok: true,
      timestamp: new Date().toISOString(),
      scorecard: data ?? null,
    })
  } catch (error) {
    logger.error('trust scorecard error', { error })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
