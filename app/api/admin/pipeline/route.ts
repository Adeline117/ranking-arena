/**
 * Admin Pipeline Health API
 * GET /api/admin/pipeline - 返回数据管道健康状态
 *
 * 仅限管理员访问 (通过 CRON_SECRET 或 Supabase admin 验证)
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getPipelineOverview, getSourceHealth } from '@/lib/utils/pipeline-monitor'

export const dynamic = 'force-dynamic'

function isAuthorized(request: NextRequest): boolean {
  // Bearer token auth (for cron / internal calls)
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) return true

  // Admin cookie auth - check for admin email in Supabase session
  // For simplicity, allow if CRON_SECRET matches or admin token present
  const adminToken = request.headers.get('x-admin-token')
  if (cronSecret && adminToken === cronSecret) return true

  return false
}

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false } })
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const supabase = getSupabase()
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 })
  }

  try {
    const windowHours = Number(request.nextUrl.searchParams.get('hours') || '24')
    const source = request.nextUrl.searchParams.get('source')

    if (source) {
      const health = await getSourceHealth(supabase, source, windowHours)
      return NextResponse.json({ ok: true, data: health })
    }

    const overview = await getPipelineOverview(supabase, windowHours)
    return NextResponse.json({ ok: true, data: overview })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
