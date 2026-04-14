/**
 * Data Freshness Monitoring API
 * 
 * GET /api/monitoring/freshness
 * Returns the freshness status of all platform data
 * 
 * Query params:
 *   - threshold: hours (default: 24)
 *   - format: json|html (default: json)
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import logger from '@/lib/logger'
import { DEAD_BLOCKED_PLATFORMS } from '@/lib/constants/exchanges'
import { env } from '@/lib/env'
import { safeParseInt } from '@/lib/utils/safe-parse'
import { safeCompare } from '@/lib/auth/verify-service-auth'

const PLATFORM_THRESHOLDS: Record<string, number> = {
  // Tier 1: High-frequency platforms (every 3h)
  okx_futures: 8,
  okx_web3: 8,
  binance_futures: 12,
  binance_spot: 12,
  bybit: 48,
  bitget_futures: 48,
  // Tier 2: Mid-frequency platforms (every 4-6h)
  hyperliquid: 8,
  gmx: 8,
  gains: 8,
  htx_futures: 8,
  dydx: 12,
  aevo: 12,
  jupiter_perps: 12,
  // Tier 3: Every 6h platforms — threshold 24h (4x interval)
  drift: 24,
  bitunix: 24,
  btcc: 24,
  // bitmart removed: copytrade API returns "service not open"
  paradex: 24,
  bybit_spot: 24,
  binance_web3: 24,
  web3_bot: 24,
  // Tier 4: Slower / less reliable
  mexc: 48,
  coinex: 48,
  xt: 48,
  // okx_spot: removed — OKX has no spot copy-trading leaderboard
  bingx: 72,
  gateio: 72,
  bitfinex: 24,
  // Tier 5: Not actively fetched (no cron group) — high threshold to avoid noise
  phemex: 72,
  toobit: 24,  // Re-enabled via VPS scraper in group G2 (2026-03-09)
  // xt_spot, bingx_spot: removed — not in any cron group, no public API
}

interface PlatformStatus {
  source: string
  status: 'healthy' | 'warning' | 'critical' | 'no_data'
  lastUpdate: string | null
  ageHours: number | null
  threshold: number
  total: number
  fieldCoverage: {
    roi: number
    winRate: number
    maxDrawdown: number
  }
}

interface FreshnessResult {
  timestamp: string
  summary: {
    totalPlatforms: number
    healthy: number
    warning: number
    critical: number
    noData: number
  }
  platforms: PlatformStatus[]
}

export async function GET(request: NextRequest) {
  // Security: Verify CRON_SECRET or ADMIN_SECRET (timing-safe)
  const authHeader = request.headers.get('authorization')
  const validSecret = env.ADMIN_SECRET || env.CRON_SECRET
  if (!validSecret || !authHeader || !safeCompare(authHeader, `Bearer ${validSecret}`)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
  const url = new URL(request.url)
  const threshold = safeParseInt(url.searchParams.get('threshold'), 12)
  const format = url.searchParams.get('format') || 'json'

  const supabase = getSupabaseAdmin()

  const { data: aggRows, error: aggErr } = await supabase.rpc('get_monitoring_freshness_summary')

  if (aggErr) {
    return NextResponse.json({ error: aggErr.message }, { status: 500 })
  }

  // Aggregate by source (already grouped in DB RPC)
  const platformData: Record<string, {
    lastUpdate: string | null
    total: number
    roi: number
    winRate: number
    maxDrawdown: number
  }> = {}

  for (const row of (aggRows || []) as Array<{ source: string; last_update: string | null; total: number; roi_count: number; win_rate_count: number; max_drawdown_count: number }>) {
    platformData[row.source] = {
      lastUpdate: row.last_update,
      total: Number(row.total || 0),
      roi: Number(row.roi_count || 0),
      winRate: Number(row.win_rate_count || 0),
      maxDrawdown: Number(row.max_drawdown_count || 0),
    }
  }

  const now = new Date()
  const results: FreshnessResult = {
    timestamp: now.toISOString(),
    summary: { totalPlatforms: 0, healthy: 0, warning: 0, critical: 0, noData: 0 },
    platforms: [],
  }

  const deadSet = new Set([
    ...(DEAD_BLOCKED_PLATFORMS as string[]),
    // Platforms with stale DB data but no active fetcher or public API (not in TraderSource type)
    'xt_spot', 'bingx_spot',
  ])
  const allSources = new Set([
    ...Object.keys(platformData),
    ...Object.keys(PLATFORM_THRESHOLDS),
  ].filter(src => !deadSet.has(src)))

  for (const src of allSources) {
    results.summary.totalPlatforms++
    const p = platformData[src]
    const th = PLATFORM_THRESHOLDS[src] || threshold

    if (!p || !p.lastUpdate) {
      results.summary.noData++
      results.platforms.push({
        source: src,
        status: 'no_data',
        lastUpdate: null,
        ageHours: null,
        threshold: th,
        total: 0,
        fieldCoverage: { roi: 0, winRate: 0, maxDrawdown: 0 },
      })
      continue
    }

    const ageMs = now.getTime() - new Date(p.lastUpdate).getTime()
    const ageHours = Math.round((ageMs / (1000 * 60 * 60)) * 10) / 10

    let status: 'healthy' | 'warning' | 'critical' = 'healthy'
    if (ageHours > th * 2) {
      status = 'critical'
      results.summary.critical++
    } else if (ageHours > th) {
      status = 'warning'
      results.summary.warning++
    } else {
      results.summary.healthy++
    }

    results.platforms.push({
      source: src,
      status,
      lastUpdate: p.lastUpdate,
      ageHours,
      threshold: th,
      total: p.total,
      fieldCoverage: {
        roi: p.total > 0 ? Math.round((p.roi / p.total) * 100) : 0,
        winRate: p.total > 0 ? Math.round((p.winRate / p.total) * 100) : 0,
        maxDrawdown: p.total > 0 ? Math.round((p.maxDrawdown / p.total) * 100) : 0,
      },
    })
  }

  // Sort by status severity
  const statusOrder = { critical: 0, warning: 1, healthy: 2, no_data: 3 }
  results.platforms.sort((a, b) => {
    const orderDiff = statusOrder[a.status] - statusOrder[b.status]
    if (orderDiff !== 0) return orderDiff
    return (b.ageHours || 999) - (a.ageHours || 999)
  })

  if (format === 'html') {
    return new NextResponse(generateHtml(results), {
      headers: { 'Content-Type': 'text/html' },
    })
  }

  return NextResponse.json(results)
  } catch (error) {
    logger.error('[monitoring/freshness] Error:', error)
    return NextResponse.json({ error: 'Failed to check freshness' }, { status: 500 })
  }
}

function generateHtml(results: FreshnessResult): string {
  const statusEmoji: Record<string, string> = {
    healthy: '[OK]',
    warning: '[WARN]',
    critical: '[CRIT]',
    no_data: '[N/A]',
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="300">
  <title>Data Freshness Status</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 20px; max-width: 1000px; margin: 0 auto; }
    h1 { margin-bottom: 5px; }
    .timestamp { color: #64748b; margin-bottom: 20px; }
    .summary { display: flex; gap: 12px; margin-bottom: 25px; flex-wrap: wrap; }
    .stat { background: #1e293b; padding: 12px 18px; border-radius: 8px; }
    .stat-value { font-size: 24px; font-weight: bold; }
    .healthy .stat-value { color: #22c55e; }
    .warning .stat-value { color: #eab308; }
    .critical .stat-value { color: #ef4444; }
    .stat-label { color: #64748b; font-size: 11px; text-transform: uppercase; }
    table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 8px; overflow: hidden; }
    th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #334155; }
    th { background: #0f172a; color: #64748b; font-size: 11px; text-transform: uppercase; }
    .badge { padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; }
    .badge-healthy { background: var(--color-accent-success-20); color: #22c55e; }
    .badge-warning { background: var(--color-orange-border); color: #eab308; }
    .badge-critical { background: var(--color-accent-error-20); color: #ef4444; }
    .badge-no_data { background: var(--color-overlay-subtle); color: #64748b; }
  </style>
</head>
<body>
  <h1>Data Freshness Status</h1>
  <p class="timestamp">Updated: ${new Date(results.timestamp).toLocaleString()} (auto-refresh: 5min)</p>
  
  <div class="summary">
    <div class="stat healthy"><div class="stat-value">${results.summary.healthy}</div><div class="stat-label">Healthy</div></div>
    <div class="stat warning"><div class="stat-value">${results.summary.warning}</div><div class="stat-label">Warning</div></div>
    <div class="stat critical"><div class="stat-value">${results.summary.critical}</div><div class="stat-label">Critical</div></div>
    <div class="stat"><div class="stat-value">${results.summary.noData}</div><div class="stat-label">No Data</div></div>
  </div>
  
  <table>
    <thead>
      <tr><th>Platform</th><th>Status</th><th>Age</th><th>Records</th><th>ROI%</th><th>WR%</th><th>DD%</th></tr>
    </thead>
    <tbody>
      ${results.platforms.map(p => `
        <tr>
          <td><strong>${p.source}</strong></td>
          <td><span class="badge badge-${p.status}">${statusEmoji[p.status]} ${p.status}</span></td>
          <td>${p.ageHours != null ? p.ageHours + 'h' : '—'}</td>
          <td>${p.total}</td>
          <td>${p.fieldCoverage.roi}%</td>
          <td>${p.fieldCoverage.winRate}%</td>
          <td>${p.fieldCoverage.maxDrawdown}%</td>
        </tr>
      `).join('')}
    </tbody>
  </table>
</body>
</html>`
}
