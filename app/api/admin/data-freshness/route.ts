/**
 * 管理后台 - 数据新鲜度查询
 *
 * GET /api/admin/data-freshness - 返回各平台数据新鲜度 JSON
 *
 * 与 cron 端点共享同一套检测逻辑，但不触发告警通知。
 * 适用于 dashboard / 监控面板轮询。
 */

import { NextResponse } from 'next/server'
import { buildFreshnessReport } from '@/app/api/cron/check-data-freshness/route'
import { env } from '@/lib/env'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  // 简单鉴权：需要 CRON_SECRET 或 ADMIN_SECRET
  const authHeader = req.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')
  const validSecret =
    env.ADMIN_SECRET || env.CRON_SECRET

  if (!validSecret || token !== validSecret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const report = await buildFreshnessReport()
    return NextResponse.json(report)
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Unknown error'
    console.error('[data-freshness]', message)
    return NextResponse.json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }, { status: 500 })
  }
}
