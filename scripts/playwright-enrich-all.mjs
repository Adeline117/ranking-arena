#!/usr/bin/env node
/**
 * playwright-enrich-all.mjs — 用 Playwright 内部 API 补齐所有平台 snapshot 缺失字段
 *
 * 策略：先访问各平台页面建立 session，然后用 page.evaluate(fetch) 直接调内部 API
 * 比逐页导航快 10x+，不触发反爬
 *
 * Usage:
 *   node scripts/playwright-enrich-all.mjs                    # 全部平台
 *   node scripts/playwright-enrich-all.mjs --source=kucoin    # 单个平台
 *   node scripts/playwright-enrich-all.mjs --dry-run          # 仅打印不写库
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const DRY_RUN = process.argv.includes('--dry-run')
const SOURCE_FILTER = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || null

function parseNum(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return v
  const n = parseFloat(String(v).replace(/[%,\s]/g, ''))
  return isNaN(n) ? null : n
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function randDelay(min = 800, max = 2000) { return Math.floor(Math.random() * (max - min)) + min }

// ═══════════════════════════════════════════
// KuCoin
// ═══════════════════════════════════════════
async function enrichKuCoin() {
  console.log('\n' + '═'.repeat(50))
  console.log('🔄 KuCoin')
  console.log('═'.repeat(50))

  const { data: snapshots } = await supabase
    .from('trader_snapshots')
    .select('id, source_trader_id, pnl, win_rate, max_drawdown, trades_count')
    .eq('source', 'kucoin')
    .or('pnl.is.null,win_rate.is.null,max_drawdown.is.null,trades_count.is.null')

  if (!snapshots?.length) { console.log('  ✅ Nothing to enrich'); return }

  // Group by trader
  const traderMap = new Map()
  for (const s of snapshots) {
    if (!traderMap.has(s.source_trader_id)) traderMap.set(s.source_trader_id, [])
    traderMap.get(s.source_trader_id).push(s)
  }
  console.log(`  📊 ${snapshots.length} snapshots, ${traderMap.size} traders`)

  // Launch browser
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  const page = await ctx.newPage()

  // Establish session
  await page.goto('https://www.kucoin.com/copy-trading', { waitUntil: 'domcontentloaded', timeout: 20000 })
  await sleep(5000)

  // First, get leadConfigId mapping from leaderboard
  console.log('  📋 Fetching full leaderboard for ID mapping...')
  const leaderboard = new Map() // leadConfigId → leaderboard data
  const totalPages = 30
  for (let p = 1; p <= totalPages; p++) {
    const resp = await page.evaluate(async (pg) => {
      const r = await fetch('/_api/ct-copy-trade/v1/copyTrading/rn/leaderboard/query?lang=en_US', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPage: pg, pageSize: 20 })
      })
      return r.json()
    }, p)
    const items = resp?.data?.items || []
    if (!items.length) break
    for (const item of items) {
      leaderboard.set(String(item.leadConfigId), {
        pnl: parseNum(item.totalPnl),
        nickName: item.nickName,
      })
    }
    if (p % 10 === 0) console.log(`    Page ${p}, collected ${leaderboard.size} traders`)
    await sleep(randDelay(300, 800))
  }
  console.log(`  📋 Leaderboard: ${leaderboard.size} traders`)

  let updated = 0, failed = 0
  const traders = [...traderMap.entries()]

  for (let i = 0; i < traders.length; i++) {
    const [traderId, rows] = traders[i]
    if ((i + 1) % 25 === 0) console.log(`  [${i + 1}/${traders.length}]`)

    try {
      const metrics = { pnl: null, win_rate: null, max_drawdown: null, trades_count: null }

      // Get PNL from leaderboard
      const lb = leaderboard.get(traderId)
      if (lb?.pnl != null) metrics.pnl = lb.pnl

      // Get overview (has tradingFrequency, totalReturnRate)
      const overview = await page.evaluate(async (id) => {
        const r = await fetch(`/_api/ct-copy-trade/v1/copyTrading/leadShow/overview?lang=en_US&leadConfigId=${id}`)
        return r.ok ? r.json() : null
      }, traderId)
      if (overview?.data) {
        if (metrics.pnl == null && overview.data.leadPrincipal && overview.data.totalReturnRate) {
          metrics.pnl = parseNum(overview.data.leadPrincipal) * parseNum(overview.data.totalReturnRate)
        }
      }

      // Get position history → win_rate + trades_count
      const positions = await page.evaluate(async (id) => {
        const r = await fetch(`/_api/ct-copy-trade/v1/copyTrading/leadShow/positionHistory?lang=en_US&leadConfigId=${id}&period=90d`)
        return r.ok ? r.json() : null
      }, traderId)
      const posData = positions?.data || []
      if (posData.length > 0) {
        const wins = posData.filter(p => parseFloat(p.closePnl) > 0).length
        metrics.win_rate = parseFloat((wins / posData.length * 100).toFixed(2))
        metrics.trades_count = posData.length
      }

      // Get PNL history → max_drawdown
      const pnlHistory = await page.evaluate(async (id) => {
        const r = await fetch(`/_api/ct-copy-trade/v1/copyTrading/leadShow/pnl/history?lang=en_US&leadConfigId=${id}&period=90d`)
        return r.ok ? r.json() : null
      }, traderId)
      const pnlData = pnlHistory?.data || []
      if (pnlData.length > 0) {
        // Calculate max drawdown from cumulative ratio
        let peak = -Infinity
        let maxDD = 0
        for (const d of pnlData) {
          const ratio = parseNum(d.ratio) || 0
          if (ratio > peak) peak = ratio
          const dd = peak - ratio
          if (dd > maxDD) maxDD = dd
        }
        metrics.max_drawdown = parseFloat((maxDD * 100).toFixed(2)) // convert to percentage
      }

      // Update snapshots
      for (const snap of rows) {
        const updates = {}
        if (snap.pnl == null && metrics.pnl != null) updates.pnl = metrics.pnl
        if (snap.win_rate == null && metrics.win_rate != null) updates.win_rate = metrics.win_rate
        if (snap.max_drawdown == null && metrics.max_drawdown != null) updates.max_drawdown = metrics.max_drawdown
        if (snap.trades_count == null && metrics.trades_count != null) updates.trades_count = metrics.trades_count
        if (!Object.keys(updates).length) continue

        if (!DRY_RUN) {
          const { error } = await supabase.from('trader_snapshots').update(updates).eq('id', snap.id)
          if (error) { failed++; continue }
        }
        updated++
      }

      await sleep(randDelay(500, 1500))
    } catch (e) {
      failed++
      if (i < 3) console.log(`    ❌ ${traderId}: ${e.message}`)
    }
  }

  await browser.close()
  console.log(`  ✅ KuCoin: ${updated} updated, ${failed} failed`)
  return { updated, failed }
}

// ═══════════════════════════════════════════
// MEXC
// ═══════════════════════════════════════════
async function enrichMEXC() {
  console.log('\n' + '═'.repeat(50))
  console.log('🔄 MEXC')
  console.log('═'.repeat(50))

  const { data: snapshots } = await supabase
    .from('trader_snapshots')
    .select('id, source_trader_id, pnl, win_rate, max_drawdown, trades_count')
    .eq('source', 'mexc')
    .or('pnl.is.null,win_rate.is.null,max_drawdown.is.null,trades_count.is.null')

  if (!snapshots?.length) { console.log('  ✅ Nothing to enrich'); return }

  const traderMap = new Map()
  for (const s of snapshots) {
    if (!traderMap.has(s.source_trader_id)) traderMap.set(s.source_trader_id, [])
    traderMap.get(s.source_trader_id).push(s)
  }
  console.log(`  📊 ${snapshots.length} snapshots, ${traderMap.size} traders`)

  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  const page = await ctx.newPage()

  // Establish session - intercept network to find the actual API
  const apiCalls = []
  page.on('response', async (resp) => {
    const url = resp.url()
    if ((url.includes('copy-trade') || url.includes('copyTrad')) && resp.status() === 200) {
      try {
        const ct = resp.headers()['content-type'] || ''
        if (ct.includes('json')) {
          const body = await resp.json()
          apiCalls.push({ url, body })
        }
      } catch {}
    }
  })

  console.log('  🌐 Loading MEXC copy-trading page...')
  await page.goto('https://www.mexc.com/copy-trading', { waitUntil: 'domcontentloaded', timeout: 20000 })
  await sleep(8000)

  console.log(`  📡 Captured ${apiCalls.length} API calls`)
  for (const c of apiCalls) {
    console.log(`    ${c.url.substring(0, 120)}`)
    const data = c.body?.data
    if (Array.isArray(data)) {
      console.log(`    → Array of ${data.length} items`)
      if (data[0]) console.log(`    → Sample keys: ${Object.keys(data[0]).join(', ')}`)
    } else if (data?.list && Array.isArray(data.list)) {
      console.log(`    → list of ${data.list.length} items`)
      if (data.list[0]) console.log(`    → Sample keys: ${Object.keys(data.list[0]).join(', ')}`)
    } else if (data) {
      console.log(`    → Keys: ${Object.keys(data).join(', ')}`)
    }
  }

  // Try direct API to get all traders with details
  console.log('\n  📋 Testing MEXC trader list API...')
  const resp = await page.evaluate(async () => {
    // Try various known MEXC API endpoints
    const endpoints = [
      '/api/platform/copy-trade/trader/list',
      '/api/v1/copy-trade/trader/list',
      '/api/platform/future/copy-trade/trader/list',
    ]
    for (const ep of endpoints) {
      try {
        const r = await fetch(ep + '?page=1&pageSize=50', {
          headers: { 'Accept': 'application/json' }
        })
        if (r.ok) {
          const body = await r.json()
          return { endpoint: ep, status: r.status, body }
        }
      } catch {}
    }
    return { error: 'No working endpoint' }
  })
  console.log('  API result:', resp.endpoint || resp.error, resp.status || '')
  if (resp.body?.data) {
    const d = resp.body.data
    if (d.list?.[0]) {
      console.log('  Sample trader:', JSON.stringify(d.list[0]).substring(0, 300))
    } else if (Array.isArray(d) && d[0]) {
      console.log('  Sample trader:', JSON.stringify(d[0]).substring(0, 300))
    }
  }

  await browser.close()
  console.log('  ⏸ MEXC: API discovery done (will implement based on findings)')
  return { updated: 0, failed: 0 }
}

// ═══════════════════════════════════════════
// CoinEx
// ═══════════════════════════════════════════
async function enrichCoinEx() {
  console.log('\n' + '═'.repeat(50))
  console.log('🔄 CoinEx')
  console.log('═'.repeat(50))

  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  const page = await ctx.newPage()

  const apiCalls = []
  page.on('response', async (resp) => {
    const url = resp.url()
    if (url.includes('coinex.com') && (url.includes('copy') || url.includes('trader')) && resp.status() === 200) {
      try {
        const ct = resp.headers()['content-type'] || ''
        if (ct.includes('json')) {
          const body = await resp.json()
          apiCalls.push({ url, body })
        }
      } catch {}
    }
  })

  console.log('  🌐 Loading CoinEx copy-trading page...')
  await page.goto('https://www.coinex.com/copy-trading', { waitUntil: 'domcontentloaded', timeout: 20000 })
  await sleep(8000)

  console.log(`  📡 Captured ${apiCalls.length} API calls`)
  for (const c of apiCalls) {
    console.log(`    ${c.url.substring(0, 120)}`)
    const data = c.body?.data
    if (Array.isArray(data)) {
      console.log(`    → Array of ${data.length}`)
      if (data[0]) console.log(`    → Keys: ${Object.keys(data[0]).join(', ')}`)
    } else if (data?.records) {
      console.log(`    → records: ${data.records.length}`)
      if (data.records[0]) console.log(`    → Keys: ${Object.keys(data.records[0]).join(', ')}`)
    } else if (data) {
      console.log(`    → Keys: ${Object.keys(data).join(', ')}`)
    }
  }

  await browser.close()
  return { updated: 0, failed: 0 }
}

// ═══════════════════════════════════════════
// Bitget
// ═══════════════════════════════════════════
async function enrichBitget() {
  console.log('\n' + '═'.repeat(50))
  console.log('🔄 Bitget')
  console.log('═'.repeat(50))

  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  const page = await ctx.newPage()

  const apiCalls = []
  page.on('response', async (resp) => {
    const url = resp.url()
    if (url.includes('bitget.com') && (url.includes('copy') || url.includes('trace') || url.includes('trader')) && resp.status() === 200) {
      try {
        const ct = resp.headers()['content-type'] || ''
        if (ct.includes('json')) {
          const body = await resp.json()
          apiCalls.push({ url, body })
        }
      } catch {}
    }
  })

  console.log('  🌐 Loading Bitget copy-trading page...')
  await page.goto('https://www.bitget.com/copy-trading', { waitUntil: 'domcontentloaded', timeout: 20000 })
  await sleep(8000)

  console.log(`  📡 Captured ${apiCalls.length} API calls`)
  for (const c of apiCalls) {
    console.log(`    ${c.url.substring(0, 120)}`)
    const data = c.body?.data
    if (Array.isArray(data)) {
      console.log(`    → Array of ${data.length}`)
      if (data[0]) console.log(`    → Keys: ${Object.keys(data[0]).slice(0, 15).join(', ')}`)
    } else if (data?.list) {
      console.log(`    → list: ${data.list.length}`)
      if (data.list[0]) console.log(`    → Keys: ${Object.keys(data.list[0]).slice(0, 15).join(', ')}`)
    } else if (data) {
      console.log(`    → Keys: ${Object.keys(data).slice(0, 15).join(', ')}`)
    }
  }

  await browser.close()
  return { updated: 0, failed: 0 }
}

// ═══════════════════════════════════════════
// Bybit
// ═══════════════════════════════════════════
async function enrichBybit() {
  console.log('\n' + '═'.repeat(50))
  console.log('🔄 Bybit')
  console.log('═'.repeat(50))

  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  const page = await ctx.newPage()

  const apiCalls = []
  page.on('response', async (resp) => {
    const url = resp.url()
    if (url.includes('bybit.com') && (url.includes('beehive') || url.includes('copy') || url.includes('leader')) && resp.status() === 200) {
      try {
        const ct = resp.headers()['content-type'] || ''
        if (ct.includes('json')) {
          const body = await resp.json()
          apiCalls.push({ url, body })
        }
      } catch {}
    }
  })

  console.log('  🌐 Loading Bybit copy-trading page...')
  await page.goto('https://www.bybit.com/copyTrading/traderRanking', { waitUntil: 'domcontentloaded', timeout: 20000 })
  await sleep(8000)

  console.log(`  📡 Captured ${apiCalls.length} API calls`)
  for (const c of apiCalls) {
    console.log(`    ${c.url.substring(0, 120)}`)
    const data = c.body?.result || c.body?.data
    if (data?.leaderDetails) {
      console.log(`    → leaderDetails: ${data.leaderDetails.length}`)
      if (data.leaderDetails[0]) console.log(`    → Keys: ${Object.keys(data.leaderDetails[0]).slice(0, 15).join(', ')}`)
    } else if (Array.isArray(data)) {
      console.log(`    → Array of ${data.length}`)
      if (data[0]) console.log(`    → Keys: ${Object.keys(data[0]).slice(0, 15).join(', ')}`)
    } else if (data) {
      console.log(`    → Keys: ${Object.keys(data).slice(0, 15).join(', ')}`)
    }
  }

  await browser.close()
  return { updated: 0, failed: 0 }
}

// ═══════════════════════════════════════════
// Main — Phase 1: API Discovery, Phase 2: KuCoin enrichment
// ═══════════════════════════════════════════
async function main() {
  console.log(`\n🤖 Playwright Enrichment ${DRY_RUN ? '[DRY RUN]' : ''}`)

  const platforms = SOURCE_FILTER ? [SOURCE_FILTER] : ['kucoin', 'mexc', 'coinex', 'bitget_futures', 'bybit']
  console.log(`   Targets: ${platforms.join(', ')}\n`)

  for (const p of platforms) {
    try {
      if (p === 'kucoin') await enrichKuCoin()
      else if (p === 'mexc') await enrichMEXC()
      else if (p === 'coinex') await enrichCoinEx()
      else if (p === 'bitget_futures') await enrichBitget()
      else if (p === 'bybit') await enrichBybit()
    } catch (e) {
      console.log(`❌ ${p}: ${e.message}`)
    }
  }

  // Final stats
  console.log('\n═══ Final Statistics ═══')
  for (const field of ['pnl', 'win_rate', 'max_drawdown', 'trades_count']) {
    const { count: total } = await supabase.from('trader_snapshots').select('id', { count: 'exact', head: true })
    const { count: filled } = await supabase.from('trader_snapshots').select('id', { count: 'exact', head: true }).not(field, 'is', null)
    console.log(`  ${field.padEnd(16)} ${filled}/${total} (${Math.round(filled / total * 100)}%)`)
  }

  console.log('\n✨ Done!')
}

main().catch(e => { console.error('❌ Fatal:', e); process.exit(1) })
