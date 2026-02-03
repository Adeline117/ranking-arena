#!/usr/bin/env node
/**
 * 数据新鲜度检测脚本
 * 
 * 功能:
 * - 检查各平台数据的最后更新时间
 * - 超过阈值(默认24小时)未更新时记录告警
 * - 生成状态报告 (JSON/HTML)
 * - 可选发送通知 (未来可扩展 webhook/email)
 * 
 * 用法:
 *   node scripts/monitoring/data-freshness-check.mjs [--threshold=24] [--output=json|html|both] [--verbose]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

// Load env
try {
  for (const l of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = l.match(/^([^#=]+)=["']?(.+?)["']?$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch {}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// ============================================================
// Configuration
// ============================================================

const DEFAULT_THRESHOLD_HOURS = 24

// Platform-specific thresholds (some platforms update less frequently)
const PLATFORM_THRESHOLDS = {
  // CEX with stable APIs - expect 4-6 hour updates
  okx_futures: 8,
  okx_web3: 8,
  htx: 8,
  htx_futures: 8,
  binance_futures: 12,
  binance_spot: 12,
  
  // DEX - stable GraphQL/API
  hyperliquid: 8,
  gmx: 8,
  gains: 8,
  dydx: 12,
  
  // Browser-dependent platforms - more lenient
  mexc: 48,
  kucoin: 48,
  coinex: 48,
  bybit: 48,
  bitget_futures: 48,
  bitget_spot: 48,
  xt: 48,
  
  // Known problematic platforms - very lenient
  bingx: 72,
  blofin: 72,
  lbank: 72,
  weex: 72,
  phemex: 72,
  pionex: 72,
}

// Platform categories for reporting
const PLATFORM_CATEGORIES = {
  cex_api: ['okx_futures', 'okx_web3', 'htx', 'htx_futures', 'binance_futures', 'binance_spot'],
  dex: ['hyperliquid', 'gmx', 'gains', 'dydx', 'kwenta', 'mux', 'vertex', 'drift', 'jupiter_perps', 'aevo', 'synthetix'],
  cex_browser: ['mexc', 'kucoin', 'coinex', 'bybit', 'bitget_futures', 'bitget_spot', 'xt', 'phemex', 'weex', 'bingx', 'blofin', 'lbank', 'pionex', 'gateio'],
}

// ============================================================
// Core Logic
// ============================================================

async function getPlatformFreshness() {
  const { data, error } = await sb
    .from('trader_snapshots')
    .select('source, captured_at, roi, win_rate, max_drawdown, season_id')
  
  if (error) throw new Error(`Supabase error: ${error.message}`)
  
  // Aggregate by source
  const platforms = {}
  
  for (const row of data || []) {
    const src = row.source
    if (!platforms[src]) {
      platforms[src] = {
        source: src,
        lastUpdate: null,
        counts: { '7D': 0, '30D': 0, '90D': 0 },
        fieldCoverage: { roi: 0, winRate: 0, maxDrawdown: 0 },
        total: 0,
      }
    }
    
    const p = platforms[src]
    if (!p.lastUpdate || row.captured_at > p.lastUpdate) {
      p.lastUpdate = row.captured_at
    }
    
    p.total++
    if (row.season_id) p.counts[row.season_id] = (p.counts[row.season_id] || 0) + 1
    if (row.roi != null) p.fieldCoverage.roi++
    if (row.win_rate != null) p.fieldCoverage.winRate++
    if (row.max_drawdown != null) p.fieldCoverage.maxDrawdown++
  }
  
  return platforms
}

function analyzeStatus(platforms, globalThreshold) {
  const now = new Date()
  const results = {
    timestamp: now.toISOString(),
    summary: {
      totalPlatforms: 0,
      healthy: 0,
      warning: 0,
      critical: 0,
      noData: 0,
    },
    platforms: [],
    alerts: [],
  }
  
  // Get all known platforms
  const allPlatforms = new Set([
    ...Object.keys(platforms),
    ...Object.values(PLATFORM_CATEGORIES).flat(),
  ])
  
  for (const src of allPlatforms) {
    results.summary.totalPlatforms++
    
    const p = platforms[src]
    const threshold = PLATFORM_THRESHOLDS[src] || globalThreshold
    
    if (!p || !p.lastUpdate) {
      results.summary.noData++
      results.platforms.push({
        source: src,
        status: 'no_data',
        lastUpdate: null,
        ageHours: null,
        threshold,
        total: 0,
        fieldCoverage: { roi: 0, winRate: 0, maxDrawdown: 0 },
      })
      results.alerts.push({
        level: 'critical',
        platform: src,
        message: `No data found for platform: ${src}`,
      })
      continue
    }
    
    const ageMs = now - new Date(p.lastUpdate)
    const ageHours = Math.round(ageMs / (1000 * 60 * 60) * 10) / 10
    
    let status = 'healthy'
    if (ageHours > threshold * 2) {
      status = 'critical'
      results.summary.critical++
    } else if (ageHours > threshold) {
      status = 'warning'
      results.summary.warning++
    } else {
      results.summary.healthy++
    }
    
    // Calculate field coverage percentages
    const coverage = {
      roi: p.total > 0 ? Math.round((p.fieldCoverage.roi / p.total) * 100) : 0,
      winRate: p.total > 0 ? Math.round((p.fieldCoverage.winRate / p.total) * 100) : 0,
      maxDrawdown: p.total > 0 ? Math.round((p.fieldCoverage.maxDrawdown / p.total) * 100) : 0,
    }
    
    results.platforms.push({
      source: src,
      status,
      lastUpdate: p.lastUpdate,
      ageHours,
      threshold,
      total: p.total,
      counts: p.counts,
      fieldCoverage: coverage,
    })
    
    // Generate alerts
    if (status === 'critical') {
      results.alerts.push({
        level: 'critical',
        platform: src,
        message: `Data is ${ageHours}h old (threshold: ${threshold}h)`,
      })
    } else if (status === 'warning') {
      results.alerts.push({
        level: 'warning',
        platform: src,
        message: `Data is ${ageHours}h old (threshold: ${threshold}h)`,
      })
    }
    
    // Field coverage alerts
    if (coverage.winRate < 20 && p.total > 10) {
      results.alerts.push({
        level: 'warning',
        platform: src,
        message: `Low win_rate coverage: ${coverage.winRate}% (${p.fieldCoverage.winRate}/${p.total})`,
      })
    }
    if (coverage.maxDrawdown < 20 && p.total > 10) {
      results.alerts.push({
        level: 'warning',
        platform: src,
        message: `Low max_drawdown coverage: ${coverage.maxDrawdown}% (${p.fieldCoverage.maxDrawdown}/${p.total})`,
      })
    }
  }
  
  // Sort platforms by status severity
  const statusOrder = { critical: 0, warning: 1, healthy: 2, no_data: 3 }
  results.platforms.sort((a, b) => {
    const orderDiff = statusOrder[a.status] - statusOrder[b.status]
    if (orderDiff !== 0) return orderDiff
    return (b.ageHours || 999) - (a.ageHours || 999)
  })
  
  return results
}

function generateHtmlReport(results) {
  const statusColors = {
    healthy: '#22c55e',
    warning: '#eab308',
    critical: '#ef4444',
    no_data: '#6b7280',
  }
  
  const statusEmoji = {
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
  <title>Ranking Arena - Data Freshness Status</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 20px; }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { color: #f1f5f9; margin-bottom: 10px; }
    .timestamp { color: #94a3b8; margin-bottom: 20px; }
    .summary { display: flex; gap: 15px; margin-bottom: 30px; flex-wrap: wrap; }
    .stat { background: #1e293b; padding: 15px 20px; border-radius: 8px; min-width: 120px; }
    .stat-value { font-size: 28px; font-weight: bold; }
    .stat-label { color: #94a3b8; font-size: 12px; text-transform: uppercase; }
    .healthy .stat-value { color: #22c55e; }
    .warning .stat-value { color: #eab308; }
    .critical .stat-value { color: #ef4444; }
    .alerts { margin-bottom: 30px; }
    .alert { padding: 10px 15px; border-radius: 6px; margin-bottom: 8px; display: flex; align-items: center; gap: 10px; }
    .alert.critical { background: rgba(239, 68, 68, 0.2); border-left: 3px solid #ef4444; }
    .alert.warning { background: rgba(234, 179, 8, 0.2); border-left: 3px solid #eab308; }
    table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 8px; overflow: hidden; }
    th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #334155; }
    th { background: #0f172a; color: #94a3b8; font-weight: 500; text-transform: uppercase; font-size: 11px; }
    tr:hover { background: #334155; }
    .status-badge { padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 500; }
    .status-healthy { background: rgba(34, 197, 94, 0.2); color: #22c55e; }
    .status-warning { background: rgba(234, 179, 8, 0.2); color: #eab308; }
    .status-critical { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
    .status-no_data { background: rgba(107, 114, 128, 0.2); color: #6b7280; }
    .coverage { display: flex; gap: 8px; }
    .coverage span { font-size: 11px; padding: 2px 6px; border-radius: 3px; background: #334155; }
    .coverage .low { color: #ef4444; }
    .coverage .medium { color: #eab308; }
    .coverage .high { color: #22c55e; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🏆 Ranking Arena Data Freshness</h1>
    <p class="timestamp">Last checked: ${new Date(results.timestamp).toLocaleString()}</p>
    
    <div class="summary">
      <div class="stat healthy"><div class="stat-value">${results.summary.healthy}</div><div class="stat-label">Healthy</div></div>
      <div class="stat warning"><div class="stat-value">${results.summary.warning}</div><div class="stat-label">Warning</div></div>
      <div class="stat critical"><div class="stat-value">${results.summary.critical}</div><div class="stat-label">Critical</div></div>
      <div class="stat"><div class="stat-value">${results.summary.noData}</div><div class="stat-label">No Data</div></div>
    </div>
    
    ${results.alerts.filter(a => a.level === 'critical').length > 0 ? `
    <div class="alerts">
      <h3 style="margin-bottom: 10px; color: #ef4444;">🚨 Critical Alerts</h3>
      ${results.alerts.filter(a => a.level === 'critical').map(a => `
        <div class="alert critical">
          <strong>${a.platform}</strong>: ${a.message}
        </div>
      `).join('')}
    </div>
    ` : ''}
    
    <table>
      <thead>
        <tr>
          <th>Platform</th>
          <th>Status</th>
          <th>Last Update</th>
          <th>Age</th>
          <th>Threshold</th>
          <th>Records</th>
          <th>Field Coverage (ROI/WR/DD)</th>
        </tr>
      </thead>
      <tbody>
        ${results.platforms.map(p => {
          const coverageClass = (v) => v >= 80 ? 'high' : v >= 40 ? 'medium' : 'low'
          return `
          <tr>
            <td><strong>${p.source}</strong></td>
            <td><span class="status-badge status-${p.status}">${statusEmoji[p.status]} ${p.status.toUpperCase()}</span></td>
            <td>${p.lastUpdate ? new Date(p.lastUpdate).toLocaleString() : '—'}</td>
            <td>${p.ageHours != null ? p.ageHours + 'h' : '—'}</td>
            <td>${p.threshold}h</td>
            <td>${p.total}</td>
            <td>
              <div class="coverage">
                <span class="${coverageClass(p.fieldCoverage.roi)}">${p.fieldCoverage.roi}%</span>
                <span class="${coverageClass(p.fieldCoverage.winRate)}">${p.fieldCoverage.winRate}%</span>
                <span class="${coverageClass(p.fieldCoverage.maxDrawdown)}">${p.fieldCoverage.maxDrawdown}%</span>
              </div>
            </td>
          </tr>
        `}).join('')}
      </tbody>
    </table>
  </div>
</body>
</html>`
}

function printConsoleReport(results, verbose) {
  console.log('\n' + '='.repeat(70))
  console.log('📊 RANKING ARENA DATA FRESHNESS REPORT')
  console.log('='.repeat(70))
  console.log(`Timestamp: ${new Date(results.timestamp).toLocaleString()}`)
  console.log('')
  
  // Summary
  console.log('SUMMARY:')
  console.log(`  ✅ Healthy:  ${results.summary.healthy}`)
  console.log(`  ⚠️  Warning:  ${results.summary.warning}`)
  console.log(`  🔴 Critical: ${results.summary.critical}`)
  console.log(`  ❓ No Data:  ${results.summary.noData}`)
  console.log('')
  
  // Critical alerts
  const criticalAlerts = results.alerts.filter(a => a.level === 'critical')
  if (criticalAlerts.length > 0) {
    console.log('🚨 CRITICAL ALERTS:')
    for (const a of criticalAlerts) {
      console.log(`  - [${a.platform}] ${a.message}`)
    }
    console.log('')
  }
  
  // Platform details
  if (verbose) {
    console.log('PLATFORM DETAILS:')
    console.log('-'.repeat(70))
    console.log('Platform'.padEnd(20) + 'Status'.padEnd(12) + 'Age'.padEnd(10) + 'Records'.padEnd(10) + 'WR%'.padEnd(8) + 'DD%')
    console.log('-'.repeat(70))
    
    for (const p of results.platforms) {
      const status = p.status === 'healthy' ? '✅' : p.status === 'warning' ? '⚠️' : p.status === 'critical' ? '🔴' : '❓'
      console.log(
        p.source.padEnd(20) +
        status.padEnd(12) +
        (p.ageHours != null ? `${p.ageHours}h` : '—').padEnd(10) +
        String(p.total).padEnd(10) +
        `${p.fieldCoverage.winRate}%`.padEnd(8) +
        `${p.fieldCoverage.maxDrawdown}%`
      )
    }
  }
  
  console.log('')
}

// ============================================================
// Main
// ============================================================

async function main() {
  const args = process.argv.slice(2)
  const threshold = parseInt(args.find(a => a.startsWith('--threshold='))?.split('=')[1]) || DEFAULT_THRESHOLD_HOURS
  const outputArg = args.find(a => a.startsWith('--output='))?.split('=')[1] || 'json'
  const verbose = args.includes('--verbose') || args.includes('-v')
  
  console.log(`\n🔍 Checking data freshness (threshold: ${threshold}h)...`)
  
  try {
    const platforms = await getPlatformFreshness()
    const results = analyzeStatus(platforms, threshold)
    
    // Ensure output directory exists
    const outDir = 'scripts/monitoring/reports'
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
    
    // Output JSON
    if (outputArg === 'json' || outputArg === 'both') {
      const jsonPath = `${outDir}/freshness-status.json`
      writeFileSync(jsonPath, JSON.stringify(results, null, 2))
      console.log(`📄 JSON report: ${jsonPath}`)
    }
    
    // Output HTML
    if (outputArg === 'html' || outputArg === 'both') {
      const htmlPath = `${outDir}/freshness-status.html`
      writeFileSync(htmlPath, generateHtmlReport(results))
      console.log(`🌐 HTML report: ${htmlPath}`)
    }
    
    // Console output
    printConsoleReport(results, verbose)
    
    // Exit with error code if critical issues
    if (results.summary.critical > 0) {
      console.log('⚠️  Exiting with code 1 due to critical issues')
      process.exit(1)
    }
    
  } catch (err) {
    console.error('❌ Error:', err.message)
    process.exit(1)
  }
}

main()
