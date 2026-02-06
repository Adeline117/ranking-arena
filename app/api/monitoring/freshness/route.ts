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
import { createClient } from '@supabase/supabase-js'

const PLATFORM_THRESHOLDS: Record<string, number> = {
  okx_futures: 8,
  okx_web3: 8,
  htx: 8,
  htx_futures: 8,
  binance_futures: 12,
  binance_spot: 12,
  hyperliquid: 8,
  gmx: 8,
  gains: 8,
  dydx: 12,
  mexc: 48,
  kucoin: 48,
  coinex: 48,
  bybit: 48,
  bitget_futures: 48,
  bitget_spot: 48,
  xt: 48,
  bingx: 72,
  blofin: 72,
  lbank: 72,
  weex: 72,
  phemex: 72,
  pionex: 72,
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
  const url = new URL(request.url)
  const threshold = parseInt(url.searchParams.get('threshold') || '24')
  const format = url.searchParams.get('format') || 'json'

  const supabase = createClient(
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  )

  // Fetch all snapshots (paginated to avoid 1000 row default limit)
  let allData: Array<{ source: string; captured_at: string; roi: number | null; win_rate: number | null; max_drawdown: number | null }> = []
  let page = 0
  const PAGE_SIZE = 5000
  while (true) {
    const { data: batch, error: batchErr } = await supabase
      .from('trader_snapshots')
      .select('source, captured_at, roi, win_rate, max_drawdown')
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
    if (batchErr) {
      return NextResponse.json({ error: batchErr.message }, { status: 500 })
    }
    allData = allData.concat(batch || [])
    if (!batch || batch.length < PAGE_SIZE) break
    page++
  }

  const data = allData

  // Aggregate by source
  const platformData: Record<string, {
    lastUpdate: string | null
    total: number
    roi: number
    winRate: number
    maxDrawdown: number
  }> = {}

  for (const row of data || []) {
    const src = row.source
    if (!platformData[src]) {
      platformData[src] = { lastUpdate: null, total: 0, roi: 0, winRate: 0, maxDrawdown: 0 }
    }
    const p = platformData[src]
    if (!p.lastUpdate || row.captured_at > p.lastUpdate) {
      p.lastUpdate = row.captured_at
    }
    p.total++
    if (row.roi != null) p.roi++
    if (row.win_rate != null) p.winRate++
    if (row.max_drawdown != null) p.maxDrawdown++
  }

  const now = new Date()
  const results: FreshnessResult = {
    timestamp: now.toISOString(),
    summary: { totalPlatforms: 0, healthy: 0, warning: 0, critical: 0, noData: 0 },
    platforms: [],
  }

  const allSources = new Set([
    ...Object.keys(platformData),
    ...Object.keys(PLATFORM_THRESHOLDS),
  ])

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
}

function generateHtml(results: FreshnessResult): string {
  const statusEmoji: Record<string, string> = {
    healthy: '✅',
    warning: '⚠️',
    critical: '🔴',
    no_data: '❓',
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
    .badge-healthy { background: rgba(34, 197, 94, 0.2); color: #22c55e; }
    .badge-warning { background: rgba(234, 179, 8, 0.2); color: #eab308; }
    .badge-critical { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
    .badge-no_data { background: rgba(100, 116, 139, 0.2); color: #64748b; }
  </style>
</head>
<body>
  <h1>🏆 Data Freshness Status</h1>
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
