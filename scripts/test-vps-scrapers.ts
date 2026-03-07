/**
 * VPS Scraper Health Check & Performance Test
 * 
 * Usage:
 *   npx tsx scripts/test-vps-scrapers.ts
 */

import { logger } from '../lib/logger'

const VPS_SCRAPER_URL = process.env.VPS_SCRAPER_URL || 'http://45.76.152.169:3456'
const VPS_SCRAPER_KEY = process.env.VPS_PROXY_KEY || 'arena-proxy-sg-2026'

interface HealthResponse {
  ok: boolean
  busy: boolean
  queued: number
  uptime: number
  version: string
  endpoints: string[]
}

interface TestResult {
  platform: string
  endpoint: string
  duration: number
  success: boolean
  traderCount: number
  error?: string
}

async function checkHealth(): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`${VPS_SCRAPER_URL}/health`, {
      signal: AbortSignal.timeout(5000),
    })
    return await res.json()
  } catch (err) {
    logger.error(`Health check failed: ${err instanceof Error ? err.message : err}`)
    return null
  }
}

async function testBybit(): Promise<TestResult> {
  const start = Date.now()
  
  try {
    const url = `${VPS_SCRAPER_URL}/bybit/leaderboard-batch?pageSize=50&durations=DATA_DURATION_THIRTY_DAY`
    const res = await fetch(url, {
      headers: { 'X-Proxy-Key': VPS_SCRAPER_KEY },
      signal: AbortSignal.timeout(90_000),
    })
    
    const duration = Date.now() - start
    
    if (!res.ok) {
      return {
        platform: 'Bybit',
        endpoint: '/bybit/leaderboard-batch',
        duration,
        success: false,
        traderCount: 0,
        error: `HTTP ${res.status}`,
      }
    }
    
    const data: any = await res.json()
    const traders = data.DATA_DURATION_THIRTY_DAY?.result?.leaderDetails?.length || 0
    
    return {
      platform: 'Bybit',
      endpoint: '/bybit/leaderboard-batch',
      duration,
      success: traders > 0,
      traderCount: traders,
    }
  } catch (err) {
    return {
      platform: 'Bybit',
      endpoint: '/bybit/leaderboard-batch',
      duration: Date.now() - start,
      success: false,
      traderCount: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function testMexc(): Promise<TestResult> {
  const start = Date.now()
  
  try {
    const url = `${VPS_SCRAPER_URL}/mexc/leaderboard?periodType=2&pageSize=50`
    const res = await fetch(url, {
      headers: { 'X-Proxy-Key': VPS_SCRAPER_KEY },
      signal: AbortSignal.timeout(90_000),
    })
    
    const duration = Date.now() - start
    
    if (!res.ok) {
      return {
        platform: 'MEXC',
        endpoint: '/mexc/leaderboard',
        duration,
        success: false,
        traderCount: 0,
        error: `HTTP ${res.status}`,
      }
    }
    
    const data: any = await res.json()
    const traders =
      data?.data?.resultList?.length ||
      data?.data?.list?.length ||
      data?.data?.comprehensives?.length ||
      0
    
    return {
      platform: 'MEXC',
      endpoint: '/mexc/leaderboard',
      duration,
      success: traders > 0,
      traderCount: traders,
    }
  } catch (err) {
    return {
      platform: 'MEXC',
      endpoint: '/mexc/leaderboard',
      duration: Date.now() - start,
      success: false,
      traderCount: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function main() {
  console.log('🏥 VPS Scraper Health Check\n')
  
  // Check health
  const health = await checkHealth()
  if (!health) {
    console.error('❌ VPS scraper is not responding')
    process.exit(1)
  }
  
  console.log('✅ VPS Scraper Status:')
  console.log(`   URL: ${VPS_SCRAPER_URL}`)
  console.log(`   Version: ${health.version}`)
  console.log(`   Uptime: ${Math.floor(health.uptime / 60)} minutes`)
  console.log(`   Busy: ${health.busy}`)
  console.log(`   Queue: ${health.queued}`)
  console.log(`   Endpoints: ${health.endpoints.length}`)
  console.log('')
  
  // Test Bybit
  console.log('🧪 Testing Bybit...')
  const bybitResult = await testBybit()
  console.log(
    bybitResult.success
      ? `✅ Bybit: ${bybitResult.traderCount} traders in ${(bybitResult.duration / 1000).toFixed(1)}s`
      : `❌ Bybit failed: ${bybitResult.error} (${(bybitResult.duration / 1000).toFixed(1)}s)`
  )
  console.log('')
  
  // Test MEXC
  console.log('🧪 Testing MEXC...')
  const mexcResult = await testMexc()
  console.log(
    mexcResult.success
      ? `✅ MEXC: ${mexcResult.traderCount} traders in ${(mexcResult.duration / 1000).toFixed(1)}s`
      : `❌ MEXC failed: ${mexcResult.error} (${(mexcResult.duration / 1000).toFixed(1)}s)`
  )
  console.log('')
  
  // Summary
  const results = [bybitResult, mexcResult]
  const successful = results.filter((r) => r.success).length
  const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / results.length / 1000
  
  console.log('📊 Summary:')
  console.log(`   Success Rate: ${successful}/${results.length}`)
  console.log(`   Avg Duration: ${avgDuration.toFixed(1)}s`)
  console.log('')
  
  if (successful < results.length) {
    console.warn('⚠️  Some platforms failed. Check VPS scraper logs.')
    process.exit(1)
  }
  
  console.log('✅ All platforms working')
}

main()
