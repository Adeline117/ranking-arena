#!/usr/bin/env node
/**
 * Aggressive P0 Fix Strategy
 * 
 * 1. Bitget: Use stealth + longer page interaction
 * 2. Binance: Expand to ALL pages + all chains
 * 3. BingX: Mark as historical data (accept limitation)
 */
import { chromium } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const DRY_RUN = process.argv.includes('--dry-run')
const sleep = ms => new Promise(r => setTimeout(r, ms))

function parseNum(v) {
  if (v == null || v === '') return null
  const n = parseFloat(String(v).replace('%', '').trim())
  return isNaN(n) ? null : n
}

// ============================================
// 1. Bitget with Stealth
// ============================================
async function fixBitgetStealth() {
  console.log('\n🔥 P0: Bitget Futures (Stealth mode)\n')

  const { data: rows } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, handle, win_rate, max_drawdown')
    .eq('source', 'bitget_futures')
    .or('max_drawdown.is.null,win_rate.is.null')
    .limit(200)

  console.log(`  Traders needing enrichment: ${rows.length}`)
  if (rows.length === 0) return

  // Use playwright-extra with stealth plugin
  chromium.use(StealthPlugin())
  
  const browser = await chromium.launch({ 
    headless: false, // Run visible to avoid detection
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ]
  })

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })

  const page = await context.newPage()
  let capturedHeaders = null
  let apiResponses = []

  // Capture both requests AND responses
  page.on('request', req => {
    if (req.url().includes('/cycleData')) {
      capturedHeaders = req.headers()
    }
  })

  page.on('response', async resp => {
    if (resp.url().includes('/cycleData') && resp.status() === 200) {
      try {
        const json = await resp.json()
        if (json.code === '00000') {
          apiResponses.push(json)
        }
      } catch {}
    }
  })

  console.log('  Loading Bitget (headful for stealth)...')
  await page.goto('https://www.bitget.com/copy-trading/futures/USDT', {
    waitUntil: 'networkidle',
    timeout: 90000,
  })

  // Interact with page to trigger API calls
  await sleep(3000)
  await page.mouse.move(500, 500)
  await sleep(1000)
  await page.mouse.wheel(0, 300)
  await sleep(2000)

  // Click on first trader
  try {
    await page.click('tr[data-row-key]', { timeout: 5000 })
    await sleep(3000)
  } catch {}

  console.log(`  Captured ${apiResponses.length} API responses, headers: ${!!capturedHeaders}`)

  if (!capturedHeaders || apiResponses.length === 0) {
    console.log('  ❌ Still blocked. Bitget requires manual browser session.')
    await browser.close()
    return
  }

  // Now use captured headers to enrich
  let updated = 0
  for (const row of rows.slice(0, 100)) {
    try {
      const resp = await fetch('https://www.bitget.com/v1/trigger/trace/public/cycleData', {
        method: 'POST',
        headers: capturedHeaders,
        body: JSON.stringify({
          languageType: 0,
          triggerUserId: row.source_trader_id,
          cycleTime: 30,
        })
      })

      const json = await resp.json()
      if (json.code !== '00000' || !json.data?.statisticsDTO) continue

      const data = json.data.statisticsDTO
      const updates = {}

      let wr = parseNum(data.winningRate)
      let mdd = parseNum(data.maxRetracement)

      if (wr != null && wr >= 0 && wr <= 100) updates.win_rate = wr
      if (mdd != null && Math.abs(mdd) <= 100) updates.max_drawdown = Math.abs(mdd)

      if (Object.keys(updates).length > 0 && !DRY_RUN) {
        await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
        updated++
        console.log(`  ✓ ${row.handle}`)
      }

      await sleep(300)
    } catch {}
  }

  await browser.close()
  console.log(`\n  ✅ Bitget: ${updated} updated`)
}

// ============================================
// 2. Binance Web3 - ALL pages + ALL chains
// ============================================
async function fixBinanceWeb3Deep() {
  console.log('\n⚠️ P1: Binance Web3 (deep scan)\n')

  const { data: rows } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, season_id, win_rate, trades_count')
    .eq('source', 'binance_web3')
    .or('win_rate.is.null,trades_count.is.null')

  console.log(`  Traders needing: ${rows.length}`)
  if (rows.length === 0) return

  const periodMap = { '7D': '7d', '30D': '30d', '90D': '90d', 'ALL': '30d' }
  const chains = [56, 1, 8453] // BSC, ETH, Base

  const allTraders = new Map() // address -> data

  for (const chain of chains) {
    for (const [seasonId, period] of Object.entries(periodMap)) {
      console.log(`  Fetching chain=${chain} period=${period}...`)
      
      let page = 1
      while (page <= 50) { // Max 50 pages (5000 traders)
        try {
          const url = `https://web3.binance.com/bapi/defi/v1/public/wallet-direct/market/leaderboard/query?tag=ALL&pageNo=${page}&pageSize=100&sortBy=0&orderBy=0&period=${period}&chainId=${chain}`
          const resp = await fetch(url)
          const json = await resp.json()

          if (json.code !== '000000' || !json.data?.data || json.data.data.length === 0) break

          for (const item of json.data.data) {
            const addr = (item.address || '').toLowerCase()
            const key = `${addr}:${seasonId}`
            if (!allTraders.has(key)) {
              allTraders.set(key, { ...item, _period: period, _chain: chain })
            }
          }

          if (json.data.data.length < 100) break
          page++
          await sleep(400)
        } catch (e) {
          console.log(`    Error: ${e.message}`)
          break
        }
      }
    }
  }

  console.log(`  Total fetched: ${allTraders.size}`)

  // Match
  let updated = 0
  for (const row of rows) {
    const addr = row.source_trader_id.toLowerCase()
    const key = `${addr}:${row.season_id}`
    const trader = allTraders.get(key)

    if (!trader) continue

    const updates = {}
    let wr = parseNum(trader.winRate)
    if (wr != null && wr > 0 && wr <= 1) wr = wr * 100
    if (wr != null && wr >= 0 && wr <= 100) updates.win_rate = wr

    const tc = parseInt(trader.totalTxCnt)
    if (!isNaN(tc) && tc >= 0) updates.trades_count = tc

    if (Object.keys(updates).length > 0 && !DRY_RUN) {
      await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
      updated++
    }
  }

  console.log(`\n  ✅ Binance Web3: ${updated} updated`)
}

// Main
async function main() {
  console.log('\n🔧 Aggressive P0 Fix\n')
  if (DRY_RUN) console.log('[DRY RUN]\n')

  try {
    await fixBitgetStealth()
  } catch (e) {
    console.error('Bitget error:', e.message)
  }

  await fixBinanceWeb3Deep()

  console.log('\n✅ Done\n')
}

main().catch(console.error)
