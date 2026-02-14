#!/usr/bin/env node
/**
 * BingX - Enrich win_rate, max_drawdown, trades_count
 * Uses Playwright with proxy, captures signed headers, then paginates recommend endpoint.
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const API_BASE = 'https://api-app.qq-os.com'

const PERIOD_MAP = {
  '7D':  { wrField: 'winRate7d',  mddField: 'maxDrawDown7dV2' },
  '30D': { wrField: 'winRate30d', mddField: 'maxDrawDown30dV2' },
  '90D': { wrField: 'winRate90d', mddField: 'maxDrawDown90dV2' },
}

function pct(v) {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[+%,]/g, ''))
  if (isNaN(n)) return null
  // BingX winRate fields are already 0-100, mdd fields are already percent
  return n
}

async function main() {
  const allSnaps = []
  let from = 0
  while (true) {
    const { data, error } = await sb.from('trader_snapshots')
      .select('id, source_trader_id, season_id, win_rate, max_drawdown, trades_count')
      .eq('source', 'bingx')
      .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
      .range(from, from + 999)
    if (error || !data?.length) break
    allSnaps.push(...data)
    if (data.length < 1000) break
    from += 1000
  }

  console.log(`BingX: ${allSnaps.length} snapshots need enrichment`)
  if (!allSnaps.length) return

  const traderIds = [...new Set(allSnaps.map(s => s.source_trader_id))]
  console.log(`Unique traders: ${traderIds.length}`)

  // Launch browser with proxy
  const browser = await chromium.launch({ headless: true, proxy: { server: 'http://127.0.0.1:7890' } })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }, locale: 'en-US',
  })
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {} }
  })
  const page = await ctx.newPage()

  // Capture signed headers
  let capturedHeaders = null
  page.on('request', req => {
    if (req.url().includes('recommend') && req.method() === 'POST' && !capturedHeaders) {
      capturedHeaders = { ...req.headers() }
      capturedHeaders.referer = 'https://bingx.com/'
      capturedHeaders.origin = 'https://bingx.com'
      console.log('✅ Captured signed headers')
    }
  })

  await page.goto('https://bingx.com/en/copytrading/', { timeout: 60000, waitUntil: 'domcontentloaded' })
  await sleep(18000)

  if (!capturedHeaders) {
    for (let i = 0; i < 5; i++) { await page.evaluate(() => window.scrollBy(0, 500)); await sleep(2000) }
  }
  if (!capturedHeaders) {
    console.error('❌ Failed to capture headers')
    await browser.close()
    return
  }

  // Paginate recommend API with signed headers
  console.log('\n📡 Paginating recommend endpoint...')
  const traderData = new Map()

  for (let pageId = 0; pageId < 200; pageId++) {
    const url = `${API_BASE}/api/copy-trade-facade/v2/trader/new/recommend?pageId=${pageId}&pageSize=50`
    try {
      const resp = await page.evaluate(async ({ url, hdr }) => {
        const r = await fetch(url, { method: 'POST', headers: hdr, credentials: 'include' })
        return r.json()
      }, { url, hdr: capturedHeaders })

      if (resp.code !== 0) {
        console.log(`  Page ${pageId}: code=${resp.code}, retrying with updated timestamp...`)
        capturedHeaders.timestamp = String(Date.now())
        const retry = await page.evaluate(async ({ url, hdr }) => {
          const r = await fetch(url, { method: 'POST', headers: hdr, credentials: 'include' })
          return r.json()
        }, { url, hdr: capturedHeaders })
        if (retry.code !== 0) { console.log(`  Retry failed, stopping.`); break }
      }

      const results = resp.data?.result || []
      if (!results.length) { console.log(`  Page ${pageId}: empty, done.`); break }

      for (const item of results) {
        const uid = String(item.trader?.uid || '')
        if (!uid) continue
        traderData.set(uid, item.rankStat || {})
      }

      console.log(`  Page ${pageId}: +${results.length} (${traderData.size} unique)`)
      if (results.length < 50) break
      await sleep(800)
    } catch (e) { console.log(`  Page ${pageId} error: ${e.message}`); break }
  }

  await browser.close()
  console.log(`\n📊 Got data for ${traderData.size} traders`)

  // Update DB
  let updated = 0, skipped = 0
  for (const snap of allSnaps) {
    const rs = traderData.get(snap.source_trader_id)
    if (!rs) { skipped++; continue }

    const pm = PERIOD_MAP[snap.season_id]
    if (!pm) { skipped++; continue }

    const updates = {}

    if (snap.win_rate == null) {
      const wr = pct(rs[pm.wrField]) ?? pct(rs.winRate)
      if (wr != null) updates.win_rate = wr
    }
    if (snap.max_drawdown == null) {
      const mdd = pct(rs[pm.mddField]) ?? pct(rs.maxDrawDown)
      if (mdd != null) updates.max_drawdown = mdd
    }
    if (snap.trades_count == null) {
      const tc = parseInt(rs.totalTransactions)
      if (!isNaN(tc) && tc >= 0) updates.trades_count = tc
    }

    if (Object.keys(updates).length > 0) {
      const { error } = await sb.from('trader_snapshots').update(updates).eq('id', snap.id)
      if (!error) updated++
    }
  }

  console.log(`\n✅ BingX done: updated=${updated}/${allSnaps.length} (skipped=${skipped} no match in recommend)`)
}

main().catch(e => { console.error(e); process.exit(1) })
