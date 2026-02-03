#!/usr/bin/env node
/**
 * 字段映射分析脚本
 * 
 * 功能:
 * - 分析各平台的 WR/DD 字段覆盖率
 * - 检查 API 响应是否包含未被提取的字段
 * - 生成详细报告和修复建议
 * 
 * 用法:
 *   node scripts/monitoring/field-mapping-analysis.mjs
 */

import { readFileSync, writeFileSync } from 'fs'
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

const PROXY = 'http://127.0.0.1:7890'

// ============================================================
// API Endpoint Definitions for Field Discovery
// ============================================================

const API_ENDPOINTS = {
  gains: {
    url: 'https://backend-arbitrum.gains.trade/leaderboard',
    method: 'GET',
    wrField: 'count_win, count_loss (calculated)',
    ddField: 'NOT AVAILABLE',
    notes: 'API provides win/loss counts, not MDD',
  },
  aevo: {
    url: 'https://api.aevo.xyz/leaderboard?limit=10',
    method: 'GET',
    wrField: 'NOT AVAILABLE',
    ddField: 'NOT AVAILABLE',
    notes: 'API only provides PnL and volume',
  },
  hyperliquid: {
    url: 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard',
    method: 'GET',
    wrField: 'Requires enrichment via userFillsByTime',
    ddField: 'Requires enrichment via portfolio',
    notes: 'Leaderboard has basic data, enrichment needed for WR/DD',
  },
  gmx: {
    url: 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql',
    method: 'POST',
    body: '{"query":"{accountStats(limit:10,orderBy:realizedPnl_DESC){id wins losses realizedPnl maxCapital}}"}',
    wrField: 'wins, losses (calculated)',
    ddField: 'Requires enrichment via positionChanges',
    notes: 'Has wins/losses for WR calculation',
  },
  binance_futures: {
    url: 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list',
    method: 'POST',
    needsProxy: true,
    body: '{"pageNumber":1,"pageSize":5,"timeRange":30,"dataType":"ROI"}',
    wrField: 'winRate',
    ddField: 'maxDrawdown / mdd',
    notes: 'Full data available, geo-blocked from US',
  },
  okx_futures: {
    url: 'https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SWAP&sortType=YIELD_30D&pageNo=0&pageSize=5',
    method: 'GET',
    wrField: 'winRatio',
    ddField: 'maxDrawdown',
    notes: 'Full data available',
  },
  htx: {
    url: 'https://api.huobi.pro/v2/copy/public/top-traders?period=30&sort=TOTAL_YIELD&limit=5',
    method: 'GET',
    wrField: 'winRate',
    ddField: 'maxDrawdown',
    notes: 'Full data available',
  },
  dydx: {
    url: 'https://indexer.v4testnet.dydx.exchange/v4/leaderboard?period=30DAY&limit=5',
    method: 'GET',
    wrField: 'NOT AVAILABLE',
    ddField: 'NOT AVAILABLE',
    notes: 'Basic leaderboard only, no WR/DD',
  },
}

// ============================================================
// Analysis
// ============================================================

async function getFieldCoverageFromDb() {
  const { data } = await sb
    .from('trader_snapshots')
    .select('source, roi, win_rate, max_drawdown, season_id')
    .eq('season_id', '30D')
  
  const stats = {}
  
  for (const row of data || []) {
    const src = row.source
    if (!stats[src]) {
      stats[src] = {
        total: 0,
        hasRoi: 0,
        hasWinRate: 0,
        hasMaxDrawdown: 0,
      }
    }
    stats[src].total++
    if (row.roi != null) stats[src].hasRoi++
    if (row.win_rate != null) stats[src].hasWinRate++
    if (row.max_drawdown != null) stats[src].hasMaxDrawdown++
  }
  
  return stats
}

async function fetchSampleApiResponse(config) {
  const opts = {
    method: config.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
  }
  if (config.body) opts.body = config.body
  
  // Try with and without proxy
  let response
  try {
    if (config.needsProxy) {
      // Use curl for proxy support
      const { execSync } = await import('child_process')
      const curlArgs = [
        'curl', '-s', '-m', '10',
        '-x', PROXY,
        '-H', 'Content-Type: application/json',
        '-H', 'User-Agent: Mozilla/5.0',
      ]
      if (config.method === 'POST') {
        curlArgs.push('-X', 'POST', '-d', config.body)
      }
      curlArgs.push(config.url)
      const result = execSync(curlArgs.join(' '), { encoding: 'utf8', timeout: 15000 })
      return JSON.parse(result)
    } else {
      response = await fetch(config.url, opts)
      return await response.json()
    }
  } catch (err) {
    return { error: err.message }
  }
}

function findPotentialFields(obj, depth = 0, path = '') {
  const fields = []
  if (depth > 5 || !obj || typeof obj !== 'object') return fields
  
  const fieldPatterns = {
    winRate: /win.*rate|winrate|win_rate|winratio/i,
    maxDrawdown: /drawdown|mdd|max.*draw/i,
    roi: /roi|yield|return|profit.*rate/i,
    pnl: /pnl|profit|income/i,
  }
  
  for (const [key, value] of Object.entries(obj)) {
    const currentPath = path ? `${path}.${key}` : key
    
    for (const [fieldType, pattern] of Object.entries(fieldPatterns)) {
      if (pattern.test(key)) {
        fields.push({
          path: currentPath,
          key,
          value: typeof value === 'object' ? '[object]' : value,
          type: fieldType,
        })
      }
    }
    
    if (typeof value === 'object' && value !== null) {
      if (Array.isArray(value) && value.length > 0) {
        fields.push(...findPotentialFields(value[0], depth + 1, `${currentPath}[0]`))
      } else if (!Array.isArray(value)) {
        fields.push(...findPotentialFields(value, depth + 1, currentPath))
      }
    }
  }
  
  return fields
}

// ============================================================
// Report Generation
// ============================================================

async function generateReport() {
  console.log('\n' + '='.repeat(70))
  console.log('📊 FIELD MAPPING ANALYSIS REPORT')
  console.log('='.repeat(70))
  console.log(`Generated: ${new Date().toISOString()}\n`)
  
  // Get DB coverage
  const dbStats = await getFieldCoverageFromDb()
  
  console.log('## 1. DATABASE FIELD COVERAGE (30D Season)\n')
  console.log('Platform'.padEnd(20) + 'Total'.padEnd(8) + 'ROI%'.padEnd(8) + 'WR%'.padEnd(8) + 'DD%'.padEnd(8) + 'Status')
  console.log('-'.repeat(70))
  
  const sortedPlatforms = Object.entries(dbStats)
    .sort((a, b) => b[1].total - a[1].total)
  
  const issues = []
  
  for (const [platform, stats] of sortedPlatforms) {
    const roiPct = Math.round((stats.hasRoi / stats.total) * 100)
    const wrPct = Math.round((stats.hasWinRate / stats.total) * 100)
    const ddPct = Math.round((stats.hasMaxDrawdown / stats.total) * 100)
    
    let status = '✅ Good'
    if (wrPct < 20 || ddPct < 20) {
      status = '⚠️ Missing fields'
      issues.push({ platform, wrPct, ddPct, total: stats.total })
    }
    
    console.log(
      platform.padEnd(20) +
      String(stats.total).padEnd(8) +
      `${roiPct}%`.padEnd(8) +
      `${wrPct}%`.padEnd(8) +
      `${ddPct}%`.padEnd(8) +
      status
    )
  }
  
  console.log('\n## 2. PLATFORMS WITH FIELD ISSUES\n')
  
  if (issues.length === 0) {
    console.log('No significant field coverage issues found.\n')
  } else {
    for (const issue of issues) {
      console.log(`\n### ${issue.platform} (${issue.total} records)`)
      console.log(`   Win Rate: ${issue.wrPct}% | Max Drawdown: ${issue.ddPct}%`)
      
      const apiConfig = API_ENDPOINTS[issue.platform]
      if (apiConfig) {
        console.log(`   API WR Field: ${apiConfig.wrField}`)
        console.log(`   API DD Field: ${apiConfig.ddField}`)
        console.log(`   Notes: ${apiConfig.notes}`)
        
        // Check sample response
        console.log('   Checking API response...')
        const sample = await fetchSampleApiResponse(apiConfig)
        if (sample && !sample.error) {
          const potentialFields = findPotentialFields(sample)
          if (potentialFields.length > 0) {
            console.log('   Potential fields found in API:')
            for (const f of potentialFields) {
              console.log(`     - ${f.path} (${f.type}): ${f.value}`)
            }
          }
        }
      } else {
        console.log('   No API config defined for this platform')
      }
    }
  }
  
  console.log('\n## 3. RECOMMENDATIONS\n')
  
  const recommendations = [
    {
      platform: 'gains',
      priority: 'High',
      action: 'WR calculation exists but may not be working. Check if count_win/count_loss are properly parsed.',
    },
    {
      platform: 'aevo',
      priority: 'Low',
      action: 'API does not provide WR/DD. Would need to track positions over time (complex).',
    },
    {
      platform: 'hyperliquid',
      priority: 'Medium',
      action: 'Enrichment is implemented but limited to top 150 traders for serverless timeouts. Increase limit or use local cron.',
    },
    {
      platform: 'gmx',
      priority: 'Medium',
      action: 'WR from wins/losses is calculated. DD enrichment limited. Consider increasing ENRICH_LIMIT.',
    },
    {
      platform: 'dydx',
      priority: 'Low',
      action: 'dYdX v4 indexer has limited leaderboard data. WR/DD not available in API.',
    },
    {
      platform: 'weex/mexc/coinex',
      priority: 'Medium',
      action: 'Browser-dependent platforms need Real Chrome + proxy. Run locally with refresh-all.mjs.',
    },
  ]
  
  for (const rec of recommendations) {
    console.log(`[${rec.priority}] ${rec.platform}:`)
    console.log(`   ${rec.action}\n`)
  }
  
  console.log('='.repeat(70))
  console.log('Report complete.\n')
  
  return { dbStats, issues, recommendations }
}

// ============================================================
// Main
// ============================================================

generateReport().catch(console.error)
