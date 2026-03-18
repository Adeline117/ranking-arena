/**
 * Admin Pipeline Health API
 * GET /api/admin/pipeline - 返回数据管道健康状态
 *
 * 仅限管理员访问 (通过 CRON_SECRET 或 Supabase admin 验证)
 */

import { NextRequest } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { env } from '@/lib/env'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { getPipelineOverview, getSourceHealth } from '@/lib/utils/pipeline-monitor'
import { success as apiSuccess, handleError } from '@/lib/api/response'
import { ApiError } from '@/lib/api/errors'

export const dynamic = 'force-dynamic'

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function isAuthorized(request: NextRequest): boolean {
  const cronSecret = env.CRON_SECRET
  if (!cronSecret) return false

  // Bearer token auth (for cron / internal calls)
  const authHeader = request.headers.get('authorization')
  if (authHeader && safeCompare(authHeader, `Bearer ${cronSecret}`)) return true

  // Admin token auth
  const adminToken = request.headers.get('x-admin-token')
  if (adminToken && safeCompare(adminToken, cronSecret)) return true

  return false
}

export async function GET(request: NextRequest) {
  try {
    if (!isAuthorized(request)) {
      throw ApiError.unauthorized()
    }

    const supabase = getSupabaseAdmin()

    const windowHours = Number(request.nextUrl.searchParams.get('hours') || '24')
    const source = request.nextUrl.searchParams.get('source')

    if (source) {
      const health = await getSourceHealth(supabase, source, windowHours)
      return apiSuccess(health)
    }

    const overview = await getPipelineOverview(supabase, windowHours)
    return apiSuccess(overview)
  } catch (error) {
    return handleError(error, 'admin-pipeline')
  }
}
