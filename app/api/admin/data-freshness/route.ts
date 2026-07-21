/**
 * 管理后台 - 数据新鲜度查询
 *
 * GET /api/admin/data-freshness - 返回各平台数据新鲜度 JSON
 *
 * 与 cron 端点共享同一套检测逻辑，但不触发告警通知。
 * 适用于 dashboard / 监控面板轮询。
 */

import { NextResponse } from 'next/server'
import { buildFreshnessReport } from '@/lib/rankings/build-freshness-report'
import { createLogger } from '@/lib/utils/logger'
import { verifyAdminAuth } from '@/lib/auth/verify-service-auth'

const log = createLogger('api:data-freshness')

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  // Admin auth: CRON_SECRET, x-admin-token, or admin JWT
  if (!(await verifyAdminAuth(req))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const report = await buildFreshnessReport()
    return NextResponse.json(report)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    log.error(message)
    return NextResponse.json(
      { error: 'Internal server error', code: 'INTERNAL_ERROR' },
      { status: 500 }
    )
  }
}
