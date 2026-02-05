#!/usr/bin/env node

/**
 * Multi-Strategy Platform Refresh
 * Tries multiple methods for each blocked platform
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const PROXY_URL = 'http://127.0.0.1:7890'
const STRATEGIES = {
  bybit: [
    { name: 'Direct API', method: 'api', url: 'https://www.bybit.com/x-api/fapi/beehive/public/v1/common/dynamic-leader-list' },
    { name: 'API2 Domain', method: 'api', url: 'https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list' },
    { name: 'CF Worker Proxy', method: 'proxy', url: 'https://ranking-arena-proxy.broosbook.workers.dev' },
    { name: 'Browser Intercept', method: 'browser', url: 'https://www.bybit.com/copyTrade' },
  ],
  mexc: [
    { name: 'Contract API', method: 'api', url: 'https://contract.mexc.com/api/v1/copytrading/public/rank' },
    { name: 'Futures API', method: 'api', url: 'https://futures.mexc.com/api/v1/contract/copyTrade/leader/list' },
    { name: 'Browser', method: 'browser', url: 'https://www.mexc.com/copy-trading' },
  ],
  kucoin: [
    { name: 'Futures API', method: 'api', url: 'https://futures.kucoin.com/_api/copy-trade/api/v1/index/leader-list' },
    { name: 'Browser', method: 'browser', url: 'https://www.kucoin.com/copy-trading' },
  ],
  coinex: [
    { name: 'Direct API', method: 'api', url: 'https://www.coinex.com/res/futures/copy/trader/list' },
    { name: 'Browser', method: 'browser', url: 'https://www.coinex.com/copy-trading' },
  ],
  bitget_spot: [
    { name: 'V2 API', method: 'api', url: 'https://api.bitget.com/api/v2/copy/spot-follower/querySocialTraderList' },
    { name: 'Browser', method: 'browser', url: 'https://www.bitget.com/copy-trading/spot' },
  ],
}

async function tryApiStrategy(platform, strategy) {
  console.log(`  [${strategy.name}] Trying...`)
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    
    const response = await fetch(strategy.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      body: JSON.stringify({ pageNo: 1, pageSize: 20 }),
      signal: controller.signal,
    })
    
    clearTimeout(timeout)
    
    if (!response.ok) {
      console.log(`  [${strategy.name}] HTTP ${response.status}`)
      return { success: false, error: `HTTP ${response.status}` }
    }
    
    const data = await response.json()
    const traders = extractTraders(platform, data)
    
    if (traders.length > 0) {
      console.log(`  [${strategy.name}] ✅ Got ${traders.length} traders`)
      return { success: true, traders }
    } else {
      console.log(`  [${strategy.name}] ❌ 0 traders`)
      return { success: false, error: '0 traders' }
    }
  } catch (e) {
    console.log(`  [${strategy.name}] ❌ ${e.message}`)
    return { success: false, error: e.message }
  }
}

async function tryBrowserStrategy(platform, strategy) {
  console.log(`  [${strategy.name}] Launching browser...`)
  
  let browser
  try {
    browser = await chromium.launch({ 
      headless: true,
      args: ['--disable-blink-features=AutomationControlled']
    })
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    })
    const page = await context.newPage()
    
    const interceptedData = []
    
    // Intercept API responses
    page.on('response', async (response) => {
      const url = response.url()
      if (url.includes('copy') && url.includes('list') || url.includes('leader') || url.includes('trader')) {
        try {
          const json = await response.json()
          interceptedData.push(json)
        } catch {}
      }
    })
    
    await page.goto(strategy.url, { waitUntil: 'networkidle', timeout: 30000 })
    await page.waitForTimeout(5000) // Wait for data to load
    
    await browser.close()
    
    // Process intercepted data
    const traders = []
    for (const data of interceptedData) {
      const extracted = extractTraders(platform, data)
      traders.push(...extracted)
    }
    
    if (traders.length > 0) {
      console.log(`  [${strategy.name}] ✅ Intercepted ${traders.length} traders`)
      return { success: true, traders }
    } else {
      console.log(`  [${strategy.name}] ❌ 0 traders intercepted`)
      return { success: false, error: '0 traders' }
    }
  } catch (e) {
    console.log(`  [${strategy.name}] ❌ ${e.message}`)
    if (browser) await browser.close()
    return { success: false, error: e.message }
  }
}

function extractTraders(platform, data) {
  // Try to find trader list in various response formats
  const possiblePaths = [
    data?.result?.leaderDetails,
    data?.data?.list,
    data?.data,
    data?.list,
    data?.result?.list,
    data?.traders,
  ]
  
  for (const traders of possiblePaths) {
    if (Array.isArray(traders) && traders.length > 0) {
      return traders.map(t => normalizeTrader(platform, t))
    }
  }
  return []
}

function normalizeTrader(platform, raw) {
  // Normalize trader data to common format
  return {
    source: platform,
    source_trader_id: raw.id || raw.traderId || raw.leaderId || raw.uid || String(Math.random()),
    handle: raw.nickName || raw.name || raw.traderName || raw.displayName,
    roi: parseFloat(raw.roi || raw.roiRate || raw.yieldRate || raw.profitRate || 0) * (raw.roi > 1 ? 1 : 100),
    pnl: parseFloat(raw.pnl || raw.profit || raw.totalProfit || 0),
    win_rate: parseFloat(raw.winRate || raw.winRatio || 0) * (raw.winRate > 1 ? 1 : 100),
    max_drawdown: Math.abs(parseFloat(raw.maxDrawdown || raw.drawdown || raw.mdd || 0)) * (raw.maxDrawdown > 1 ? 1 : 100),
    followers: parseInt(raw.followers || raw.followerNum || raw.copyCount || 0),
    avatar_url: raw.avatar || raw.avatarUrl || raw.headUrl,
  }
}

async function saveTraders(traders, seasonId = '30D') {
  if (traders.length === 0) return 0
  
  const snapshots = traders.map(t => ({
    ...t,
    season_id: seasonId,
    recorded_at: new Date().toISOString(),
    arena_score: calculateArenaScore(t),
  }))
  
  const { error } = await supabase
    .from('trader_snapshots')
    .upsert(snapshots, { 
      onConflict: 'source,source_trader_id,season_id',
      ignoreDuplicates: false 
    })
  
  if (error) {
    console.log(`  ⚠️ Save error: ${error.message}`)
    return 0
  }
  
  return traders.length
}

function calculateArenaScore(t) {
  const roiScore = Math.min(100, Math.max(0, (t.roi || 0) / 10))
  const wrScore = (t.win_rate || 50) * 0.5
  const ddPenalty = Math.min(30, (t.max_drawdown || 0) * 0.3)
  return Math.round(roiScore * 0.6 + wrScore * 0.3 - ddPenalty)
}

async function refreshPlatform(platform) {
  console.log(`\n📊 ${platform.toUpperCase()}`)
  const strategies = STRATEGIES[platform]
  
  if (!strategies) {
    console.log(`  ⚠️ No strategies defined`)
    return { platform, success: false, traders: 0 }
  }
  
  for (const strategy of strategies) {
    let result
    
    if (strategy.method === 'api' || strategy.method === 'proxy') {
      result = await tryApiStrategy(platform, strategy)
    } else if (strategy.method === 'browser') {
      result = await tryBrowserStrategy(platform, strategy)
    }
    
    if (result?.success && result.traders?.length > 0) {
      const saved = await saveTraders(result.traders)
      return { platform, success: true, traders: saved, strategy: strategy.name }
    }
  }
  
  return { platform, success: false, traders: 0 }
}

async function main() {
  console.log('🚀 Multi-Strategy Platform Refresh\n')
  console.log('=' .repeat(50))
  
  const platforms = process.argv.slice(2)
  const targetPlatforms = platforms.length > 0 ? platforms : Object.keys(STRATEGIES)
  
  const results = []
  
  for (const platform of targetPlatforms) {
    const result = await refreshPlatform(platform)
    results.push(result)
  }
  
  console.log('\n' + '='.repeat(50))
  console.log('📈 Results Summary:')
  console.log('='.repeat(50))
  
  for (const r of results) {
    const status = r.success ? '✅' : '❌'
    const detail = r.success ? `${r.traders} traders via ${r.strategy}` : 'All strategies failed'
    console.log(`  ${status} ${r.platform}: ${detail}`)
  }
  
  const successCount = results.filter(r => r.success).length
  console.log(`\nTotal: ${successCount}/${results.length} platforms refreshed`)
}

main().catch(console.error)
