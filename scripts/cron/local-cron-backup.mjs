#!/usr/bin/env node
/**
 * 本地 Cron 备份脚本
 * 
 * 作为 Vercel Cron 的备份方案，在本地 Mac 上运行
 * 设计要点:
 * - 与 Vercel Cron 错开执行时间（Vercel 整点，本地半点）
 * - 检查数据新鲜度，只在需要时刷新
 * - 记录执行日志
 * 
 * 用法:
 *   node scripts/cron/local-cron-backup.mjs [--force] [--api-only]
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs'
import { execSync } from 'child_process'
import { createClient } from '@supabase/supabase-js'

// Load env
const projectRoot = new URL('../..', import.meta.url).pathname.slice(0, -1)
process.chdir(projectRoot)

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

const STALE_THRESHOLD_HOURS = 6  // Refresh if data older than this
const LOG_DIR = `${projectRoot}/logs`
const LOG_FILE = `${LOG_DIR}/cron-backup.log`

// Platforms to refresh via API (stable, fast)
const API_PLATFORMS = [
  'okx_futures',
  'htx',
  'htx_futures',
  'hyperliquid',
  'gmx',
  'gains',
  'binance_futures',
  'binance_spot',
]

// ============================================================
// Logging
// ============================================================

function log(message) {
  const timestamp = new Date().toISOString()
  const line = `[${timestamp}] ${message}`
  console.log(line)
  
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
  appendFileSync(LOG_FILE, line + '\n')
}

// ============================================================
// Freshness Check
// ============================================================

async function getStaleplatforms() {
  const { data } = await sb
    .from('trader_snapshots')
    .select('source, captured_at')
  
  const now = new Date()
  const bySource = {}
  
  for (const row of data || []) {
    if (!bySource[row.source] || row.captured_at > bySource[row.source]) {
      bySource[row.source] = row.captured_at
    }
  }
  
  const stale = []
  for (const platform of API_PLATFORMS) {
    const lastUpdate = bySource[platform]
    if (!lastUpdate) {
      stale.push({ platform, reason: 'no_data' })
      continue
    }
    
    const ageHours = (now - new Date(lastUpdate)) / (1000 * 60 * 60)
    if (ageHours > STALE_THRESHOLD_HOURS) {
      stale.push({ platform, reason: `stale (${Math.round(ageHours)}h old)` })
    }
  }
  
  return stale
}

// ============================================================
// Refresh Logic
// ============================================================

async function refreshViaApi(platform) {
  const apiUrl = `http://localhost:3000/api/cron/${platform.replace('_', '-')}`
  
  try {
    // First try local dev server
    const res = await fetch(apiUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET || 'dev'}` },
    }).catch(() => null)
    
    if (res?.ok) {
      const data = await res.json()
      return { success: true, ...data }
    }
  } catch {}
  
  // Fallback: try production API
  try {
    const prodUrl = `https://www.arenafi.org/api/cron/unified-connector?platform=${platform}`
    const res = await fetch(prodUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET || ''}` },
    })
    
    if (res?.ok) {
      const data = await res.json()
      return { success: true, ...data }
    }
    
    return { success: false, error: `API returned ${res?.status}` }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

async function runRefreshAll(apiOnly) {
  const args = apiOnly ? '--api-only' : ''
  
  try {
    execSync(`node scripts/import/refresh-all.mjs ${args}`, {
      cwd: projectRoot,
      timeout: 300000, // 5 minutes
      stdio: 'inherit',
    })
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

// ============================================================
// Main
// ============================================================

async function main() {
  const args = process.argv.slice(2)
  const force = args.includes('--force')
  const apiOnly = args.includes('--api-only')
  const fullRefresh = args.includes('--full')
  
  log('========================================')
  log('🔄 Local Cron Backup Starting')
  log(`   Force: ${force}, API-only: ${apiOnly}, Full: ${fullRefresh}`)
  
  try {
    // Check which platforms need refresh
    const stalePlatforms = await getStaleplatforms()
    
    if (stalePlatforms.length === 0 && !force) {
      log('✅ All platforms are fresh, skipping refresh')
      log('========================================')
      return
    }
    
    log(`Found ${stalePlatforms.length} stale platforms:`)
    for (const { platform, reason } of stalePlatforms) {
      log(`  - ${platform}: ${reason}`)
    }
    
    if (fullRefresh) {
      // Run full refresh script
      log('🚀 Running full refresh...')
      const result = await runRefreshAll(apiOnly)
      log(result.success ? '✅ Full refresh completed' : `❌ Full refresh failed: ${result.error}`)
    } else {
      // Refresh stale platforms individually
      for (const { platform } of stalePlatforms) {
        log(`🔄 Refreshing ${platform}...`)
        const result = await refreshViaApi(platform)
        log(result.success ? `  ✅ ${platform} refreshed` : `  ❌ ${platform} failed: ${result.error}`)
      }
    }
    
    log('========================================')
    log('✅ Local Cron Backup Completed')
    
  } catch (err) {
    log(`❌ Error: ${err.message}`)
    process.exit(1)
  }
}

main()
