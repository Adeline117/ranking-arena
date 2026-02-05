#!/usr/bin/env node

/**
 * CDP Network Intercept - Connect to existing Chrome and capture API responses
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import puppeteer from 'puppeteer-core'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const CDP_URL = 'http://127.0.0.1:9338'

const PLATFORMS = {
  bybit: {
    url: 'https://www.bybit.com/copyTrade',
    patterns: ['dynamic-leader-list', 'leaderboard', 'copy-trade'],
    source: 'bybit',
  },
  mexc: {
    url: 'https://www.mexc.com/copy-trading',
    patterns: ['copy-trade', 'leader', 'trader'],
    source: 'mexc',
  },
  kucoin: {
    url: 'https://www.kucoin.com/copy-trading',
    patterns: ['copy-trade', 'leader-list', 'index/list'],
    source: 'kucoin',
  },
  coinex: {
    url: 'https://www.coinex.com/copy-trading',
    patterns: ['copy', 'trader/list'],
    source: 'coinex',
  },
}

async function interceptPlatform(platform) {
  const config = PLATFORMS[platform]
  if (!config) {
    console.log(`❌ Unknown platform: ${platform}`)
    return { success: false, traders: 0 }
  }

  console.log(`\n📊 ${platform.toUpperCase()}`)
  console.log(`  URL: ${config.url}`)

  let browser
  try {
    browser = await puppeteer.connect({
      browserURL: CDP_URL,
    })
    
    const page = await browser.newPage()
    const interceptedData = []

    // Enable network interception
    await page.setRequestInterception(true)
    
    page.on('request', request => {
      request.continue()
    })

    page.on('response', async response => {
      const url = response.url()
      const matched = config.patterns.some(p => url.toLowerCase().includes(p.toLowerCase()))
      
      if (matched && response.headers()['content-type']?.includes('json')) {
        console.log(`  📡 Intercepted: ${url.slice(0, 100)}...`)
        try {
          const json = await response.json()
          interceptedData.push({ url, data: json })
        } catch (e) {
          // Not JSON
        }
      }
    })

    console.log(`  🌐 Navigating...`)
    await page.goto(config.url, { 
      waitUntil: 'networkidle2',
      timeout: 45000 
    })

    // Scroll to trigger lazy loading
    console.log(`  📜 Scrolling...`)
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight / 2)
    })
    await new Promise(r => setTimeout(r, 3000))
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight)
    })
    await new Promise(r => setTimeout(r, 3000))

    await page.close()

    // Process intercepted data
    console.log(`  📦 Intercepted ${interceptedData.length} API responses`)
    
    let traders = []
    for (const item of interceptedData) {
      const extracted = extractTraders(item.data, config.source)
      if (extracted.length > 0) {
        console.log(`  ✅ Found ${extracted.length} traders in ${item.url.slice(0, 60)}...`)
        traders.push(...extracted)
      }
    }

    if (traders.length > 0) {
      // Deduplicate
      const unique = new Map()
      traders.forEach(t => unique.set(t.source_trader_id, t))
      traders = Array.from(unique.values())
      
      const saved = await saveTraders(traders, config.source)
      return { success: true, traders: saved }
    }

    return { success: false, traders: 0 }
  } catch (e) {
    console.log(`  ❌ Error: ${e.message}`)
    return { success: false, traders: 0, error: e.message }
  }
}

function extractTraders(data, source) {
  // Try multiple paths to find trader data
  const paths = [
    data?.result?.leaderDetails,
    data?.result?.list,
    data?.data?.list,
    data?.data?.items,
    data?.data,
    data?.list,
    data?.traders,
    data?.leaders,
  ]

  for (const list of paths) {
    if (Array.isArray(list) && list.length > 0) {
      return list.map(t => ({
        source,
        source_trader_id: String(t.id || t.traderId || t.leaderId || t.uid || t.leaderUid || Math.random()),
        handle: t.nickName || t.name || t.traderName || t.displayName || t.leaderName,
        roi: parseNumber(t.roi || t.roiRate || t.yieldRate || t.profitRate || t.incomeRate),
        pnl: parseNumber(t.pnl || t.profit || t.totalProfit || t.income),
        win_rate: parseNumber(t.winRate || t.winRatio),
        max_drawdown: Math.abs(parseNumber(t.maxDrawdown || t.drawdown || t.mdd || t.maxRetraction)),
        followers: parseInt(t.followers || t.followerNum || t.copyCount || t.currentFollowerCount || 0),
        avatar_url: t.avatar || t.avatarUrl || t.headUrl || t.leaderAvatar,
      })).filter(t => t.handle || t.source_trader_id)
    }
  }
  return []
}

function parseNumber(val) {
  if (val === null || val === undefined) return null
  const num = parseFloat(val)
  if (isNaN(num)) return null
  // If value looks like it's already a percentage (< 10), multiply by 100
  // If it looks like a decimal ratio (< 1), multiply by 100
  if (num > 0 && num < 1) return num * 100
  return num
}

async function saveTraders(traders, source) {
  const snapshots = traders.map(t => ({
    source: t.source,
    source_trader_id: t.source_trader_id,
    handle: t.handle,
    roi: t.roi,
    pnl: t.pnl,
    win_rate: t.win_rate,
    max_drawdown: t.max_drawdown,
    followers: t.followers,
    season_id: '30D',
    recorded_at: new Date().toISOString(),
    market_type: 'futures',
  }))

  const { error } = await supabase
    .from('trader_snapshots')
    .upsert(snapshots, {
      onConflict: 'source,source_trader_id,season_id',
    })

  if (error) {
    console.log(`  ⚠️ DB Error: ${error.message}`)
    return 0
  }

  console.log(`  💾 Saved ${traders.length} traders to DB`)
  return traders.length
}

async function main() {
  console.log('🔗 CDP Network Intercept')
  console.log('========================\n')

  // Check Chrome is running
  try {
    const browser = await puppeteer.connect({ browserURL: CDP_URL })
    const version = await browser.version()
    console.log(`✅ Connected to Chrome: ${version}`)
  } catch (e) {
    console.log('❌ Chrome not running. Start with:')
    console.log('   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9338 --user-data-dir=/tmp/chrome-debug &')
    process.exit(1)
  }

  const platforms = process.argv.slice(2)
  const targets = platforms.length > 0 ? platforms : Object.keys(PLATFORMS)

  const results = []
  for (const p of targets) {
    const result = await interceptPlatform(p)
    results.push({ platform: p, ...result })
  }

  console.log('\n========================')
  console.log('📈 Summary:')
  for (const r of results) {
    const icon = r.success ? '✅' : '❌'
    console.log(`  ${icon} ${r.platform}: ${r.traders} traders`)
  }
}

main().catch(console.error)
