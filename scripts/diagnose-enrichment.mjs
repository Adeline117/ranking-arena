#!/usr/bin/env node
/**
 * Enrichment 诊断脚本
 * 测试各交易所 API 数据获取是否正常
 */

import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = join(__dirname, '../.env.local')

// Load env
try {
  for (const l of readFileSync(envPath, 'utf8').split('\n')) {
    const m = l.match(/^([^#=]+)=["']?(.+?)["']?$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch {}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// ============================================
// Test Functions
// ============================================

async function fetchJson(url, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15000)

  try {
    const res = await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!res.ok) {
      console.error(`  HTTP ${res.status}: ${res.statusText}`)
      return null
    }

    return await res.json()
  } catch (err) {
    clearTimeout(timeout)
    console.error(`  Fetch error: ${err.message}`)
    return null
  }
}

// ============================================
// Binance Test
// ============================================

async function testBinanceEquityCurve(traderId) {
  console.log(`\n[Binance] Testing equity curve for ${traderId}...`)

  const BINANCE_API = 'https://www.binance.com/bapi/futures/v2/friendly/future/copy-trade'

  const data = await fetchJson(
    `${BINANCE_API}/lead-portfolio/query-performance`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://www.binance.com',
        'Referer': 'https://www.binance.com/en/copy-trading',
      },
      body: { portfolioId: traderId, timeRange: 'QUARTERLY' },
      timeoutMs: 15000,
    }
  )

  if (!data) {
    console.log('  Result: FAILED - No response')
    return { success: false, points: 0 }
  }

  console.log('  Raw response:', JSON.stringify(data).slice(0, 300))

  if (data.data?.dailyPnls?.length > 0) {
    console.log(`  Result: SUCCESS - ${data.data.dailyPnls.length} data points`)
    return { success: true, points: data.data.dailyPnls.length }
  } else {
    console.log('  Result: EMPTY - No data points in response')
    return { success: false, points: 0 }
  }
}

// ============================================
// Bybit Test
// ============================================

async function testBybitEquityCurve(traderId) {
  console.log(`\n[Bybit] Testing equity curve for ${traderId}...`)

  const url = `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?leaderMark=${encodeURIComponent(traderId)}`

  const data = await fetchJson(url, { timeoutMs: 15000 })

  if (!data) {
    console.log('  Result: FAILED - No response')
    return { success: false, points: 0 }
  }

  console.log('  Raw response:', JSON.stringify(data).slice(0, 300))

  if (data.retCode === 0 || data.result) {
    console.log('  Result: SUCCESS')
    return { success: true, points: 1 }
  } else {
    console.log(`  Result: API ERROR - code: ${data.retCode}`)
    return { success: false, points: 0 }
  }
}

// ============================================
// OKX Test
// ============================================

async function testOkxEquityCurve(traderId) {
  console.log(`\n[OKX] Testing equity curve for ${traderId}...`)

  // OKX requires hex format uniqueCode
  if (!/^[0-9a-fA-F]{16}$/.test(traderId)) {
    console.log(`  Skipped: traderId "${traderId}" is not valid OKX hex format`)
    return { success: false, points: 0 }
  }

  const url = `https://www.okx.com/api/v5/copytrading/public-weekly-pnl?instType=SWAP&uniqueCode=${traderId}`

  const data = await fetchJson(url, { timeoutMs: 15000 })

  if (!data) {
    console.log('  Result: FAILED - No response')
    return { success: false, points: 0 }
  }

  console.log('  Raw response:', JSON.stringify(data).slice(0, 300))

  if (data.code === '0' && data.data?.length > 0) {
    console.log(`  Result: SUCCESS - ${data.data.length} data points`)
    return { success: true, points: data.data.length }
  } else {
    console.log(`  Result: EMPTY or ERROR - code: ${data.code}, msg: ${data.msg}`)
    return { success: false, points: 0 }
  }
}

// ============================================
// Main
// ============================================

async function main() {
  console.log('=== Enrichment API 诊断 ===\n')

  // 1. 获取各平台的示例交易员
  console.log('Step 1: 获取各平台示例交易员...')

  const platforms = ['binance_futures', 'bybit', 'okx_futures', 'bitget_futures']
  const testResults = {}

  for (const platform of platforms) {
    const { data: traders } = await supabase
      .from('trader_snapshots')
      .select('source_trader_id')
      .eq('source', platform)
      .eq('season_id', '90D')
      .order('arena_score', { ascending: false })
      .limit(1)

    if (!traders || traders.length === 0) {
      console.log(`  ${platform}: 无数据`)
      testResults[platform] = { trader: null, result: null }
      continue
    }

    const traderId = traders[0].source_trader_id
    console.log(`  ${platform}: ${traderId}`)
    testResults[platform] = { trader: traderId, result: null }
  }

  // 2. 测试各平台 API
  console.log('\nStep 2: 测试各平台 API...')

  if (testResults.binance_futures?.trader) {
    testResults.binance_futures.result = await testBinanceEquityCurve(testResults.binance_futures.trader)
  }

  if (testResults.bybit?.trader) {
    testResults.bybit.result = await testBybitEquityCurve(testResults.bybit.trader)
  }

  if (testResults.okx_futures?.trader) {
    testResults.okx_futures.result = await testOkxEquityCurve(testResults.okx_futures.trader)
  }

  // 3. 检查数据库表状态
  console.log('\n\nStep 3: 检查数据库表状态...')

  const tables = ['trader_equity_curve', 'trader_stats_detail', 'trader_asset_breakdown']

  for (const table of tables) {
    const { count, error } = await supabase
      .from(table)
      .select('*', { count: 'exact', head: true })

    if (error) {
      console.log(`  ${table}: ERROR - ${error.message}`)
    } else {
      console.log(`  ${table}: ${count} 条记录`)
    }
  }

  // 4. 汇总
  console.log('\n\n=== 诊断结果汇总 ===')

  for (const [platform, data] of Object.entries(testResults)) {
    if (!data.trader) {
      console.log(`${platform.padEnd(18)}: 无交易员数据`)
    } else if (!data.result) {
      console.log(`${platform.padEnd(18)}: 未测试`)
    } else if (data.result.success) {
      console.log(`${platform.padEnd(18)}: ✅ 正常 (${data.result.points} points)`)
    } else {
      console.log(`${platform.padEnd(18)}: ❌ 失败`)
    }
  }

  console.log('\n诊断完成')
}

main().catch(console.error)
