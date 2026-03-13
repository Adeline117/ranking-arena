/**
 * Connector Health Status API
 *
 * Returns real-time status of all 24 active platform connectors.
 * Data sourced from pipeline_logs table.
 *
 * GET /api/health/connectors
 * Requires: Authorization: Bearer CRON_SECRET
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 })
  }
  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } })

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  // Get recent pipeline logs for batch-fetch-traders jobs
  const { data: logs } = await supabase
    .from('pipeline_logs')
    .select('job_name, status, started_at, ended_at, duration_ms, records_processed, error_message')
    .like('job_name', 'batch-fetch-traders%')
    .gte('started_at', oneDayAgo)
    .order('started_at', { ascending: false })

  // Get data freshness per platform
  const { data: freshness } = await supabase
    .from('trader_snapshots')
    .select('source, captured_at')
    .order('captured_at', { ascending: false })
    .limit(5000)

  // Build per-platform freshness
  const latestByPlatform = new Map<string, string>()
  for (const row of freshness || []) {
    if (!latestByPlatform.has(row.source)) {
      latestByPlatform.set(row.source, row.captured_at)
    }
  }

  // Aggregate log stats per group
  const groupStats = new Map<string, { total: number; success: number; errors: string[] }>()
  for (const log of logs || []) {
    const group = log.job_name
    const stats = groupStats.get(group) || { total: 0, success: 0, errors: [] }
    stats.total++
    if (log.status === 'success') stats.success++
    if (log.error_message) stats.errors.push(log.error_message.slice(0, 100))
    groupStats.set(group, stats)
  }

  // Build connector status
  const ACTIVE_PLATFORMS = [
    'binance_futures', 'binance_spot', 'bitget_futures', 'okx_futures',
    'htx_futures', 'mexc', 'coinex', 'bingx', 'gateio', 'xt', 'btcc',
    'bitunix', 'bitfinex', 'toobit', 'etoro',
    'hyperliquid', 'gmx', 'dydx', 'gains', 'jupiter_perps', 'aevo', 'drift',
    'okx_web3', 'binance_web3', 'web3_bot',
  ]

  const connectors: Record<string, {
    status: 'healthy' | 'stale' | 'critical'
    last_update: string | null
    staleness_hours: number | null
  }> = {}

  for (const platform of ACTIVE_PLATFORMS) {
    const latest = latestByPlatform.get(platform)
    const hoursAgo = latest ? (Date.now() - new Date(latest).getTime()) / (60 * 60 * 1000) : null

    connectors[platform] = {
      status: hoursAgo === null ? 'critical' : hoursAgo > 24 ? 'critical' : hoursAgo > 8 ? 'stale' : 'healthy',
      last_update: latest || null,
      staleness_hours: hoursAgo ? Math.round(hoursAgo * 10) / 10 : null,
    }
  }

  const healthy = Object.values(connectors).filter(c => c.status === 'healthy').length
  const stale = Object.values(connectors).filter(c => c.status === 'stale').length
  const critical = Object.values(connectors).filter(c => c.status === 'critical').length

  return NextResponse.json({
    status: critical > 0 ? 'degraded' : 'healthy',
    timestamp: new Date().toISOString(),
    summary: {
      total: ACTIVE_PLATFORMS.length,
      healthy,
      stale,
      critical,
    },
    connectors,
    pipeline_groups: Object.fromEntries(
      Array.from(groupStats.entries()).map(([k, v]) => [
        k,
        { runs_24h: v.total, success_rate: v.total > 0 ? Math.round((v.success / v.total) * 100) : 0, recent_errors: v.errors.slice(0, 3) },
      ])
    ),
  })
}
