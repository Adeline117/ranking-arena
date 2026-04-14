/**
 * Admin Metrics Trends API
 * GET /api/admin/metrics/trends - Pipeline success rate, error rate, active users over time
 */

import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { env } from '@/lib/env'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/utils/logger'

export const dynamic = 'force-dynamic'

const logger = createLogger('admin-metrics-trends')

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function isAuthorized(request: NextRequest): boolean {
  const cronSecret = env.CRON_SECRET
  if (!cronSecret) return false
  const authHeader = request.headers.get('authorization')
  if (authHeader && safeCompare(authHeader, `Bearer ${cronSecret}`)) return true
  const adminToken = request.headers.get('x-admin-token')
  if (adminToken && safeCompare(adminToken, cronSecret)) return true
  return false
}

interface TrendPoint {
  date: string
  value: number
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseAdmin() as SupabaseClient

  try {
    const days = Number(request.nextUrl.searchParams.get('days') || '7')
    const since = new Date(Date.now() - days * 86400000).toISOString()

    // Pipeline success rate trend (from pipeline_job_logs)
    const pipelinePromise = supabase
      .from('pipeline_job_logs')
      .select('status, started_at')
      .gte('started_at', since)
      .order('started_at', { ascending: true })
      .then(({ data, error }) => {
        if (error || !data) return [] as TrendPoint[]
        // Group by day
        const byDay = new Map<string, { success: number; total: number }>()
        for (const row of data) {
          const day = row.started_at?.slice(0, 10) || 'unknown'
          const entry = byDay.get(day) || { success: 0, total: 0 }
          entry.total++
          if (row.status === 'success') entry.success++
          byDay.set(day, entry)
        }
        return Array.from(byDay.entries()).map(([date, { success, total }]) => ({
          date,
          value: total > 0 ? Math.round((success / total) * 100) : 0,
        }))
      })

    // Error rate trend (from pipeline_job_logs)
    const errorRatePromise = supabase
      .from('pipeline_job_logs')
      .select('status, started_at')
      .gte('started_at', since)
      .order('started_at', { ascending: true })
      .then(({ data, error }) => {
        if (error || !data) return [] as TrendPoint[]
        const byDay = new Map<string, { errors: number; total: number }>()
        for (const row of data) {
          const day = row.started_at?.slice(0, 10) || 'unknown'
          const entry = byDay.get(day) || { errors: 0, total: 0 }
          entry.total++
          if (row.status === 'error') entry.errors++
          byDay.set(day, entry)
        }
        return Array.from(byDay.entries()).map(([date, { errors, total }]) => ({
          date,
          value: total > 0 ? Math.round((errors / total) * 100) : 0,
        }))
      })

    // Active users trend (from user_profiles)
    const activeUsersPromise = supabase
      .rpc('get_daily_active_users', { since_date: since })
      .then(({ data, error }) => {
        if (error || !data) {
          // Fallback: count new users by day
          return supabase
            .from('user_profiles')
            .select('created_at')
            .gte('created_at', since)
            .order('created_at', { ascending: true })
            .then(({ data: users }) => {
              if (!users) return [] as TrendPoint[]
              const byDay = new Map<string, number>()
              for (const u of users) {
                const day = u.created_at?.slice(0, 10) || 'unknown'
                byDay.set(day, (byDay.get(day) || 0) + 1)
              }
              return Array.from(byDay.entries()).map(([date, value]) => ({ date, value }))
            })
        }
        return (data as Array<{ date: string; count: number }>).map(d => ({
          date: d.date,
          value: d.count,
        }))
      })

    const [pipelineSuccessRate, errorRate, activeUsers] = await Promise.all([
      pipelinePromise,
      errorRatePromise,
      activeUsersPromise,
    ])

    return NextResponse.json({
      ok: true,
      data: {
        pipelineSuccessRate,
        errorRate,
        activeUsers,
      },
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error('Failed to fetch metrics trends', { error: msg })
    return NextResponse.json({ ok: false, error: 'Internal server error' }, { status: 500 })
  }
}
