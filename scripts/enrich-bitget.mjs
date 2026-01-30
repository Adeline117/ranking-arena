#!/usr/bin/env node
/**
 * enrich-bitget.mjs — Bitget 数据补齐
 * 通过 Playwright 建立 session，用 page.evaluate 调内部 API
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const DRY = process.argv.includes('--dry-run')

function parseNum(v) {
  if (v == null || v === '') return null
  const n = parseFloat(String(v).replace(/[%,]/g, ''))
  return isNaN(n) ? null : n
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function main() {
  console.log('🔄 Bitget Enrichment' + (DRY ? ' [DRY RUN]' : ''))

  // Get missing snapshots
  const { data: snaps } = await sb
    .from('trader_snapshots')
    .select('id, source_trader_id, pnl, win_rate, max_drawdown, trades_count')
    .eq('source', 'bitget_futures')
    .or('pnl.is.null,win_rate.is.null,max_drawdown.is.null,trades_count.is.null')

  if (!snaps?.length) { console.log('✅ Nothing to enrich'); return }

  const traderMap = new Map()
  for (const s of snaps) {
    if (!traderMap.has(s.source_trader_id)) traderMap.set(s.source_trader_id, [])
    traderMap.get(s.source_trader_id).push(s)
  }
  console.log(`📊 ${snaps.length} snapshots, ${traderMap.size} traders`)

  // Launch browser
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process']
  })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }) })
  const page = await ctx.newPage()

  // Block heavy resources
  await ctx.route(/\.(png|jpg|gif|svg|woff|woff2|ttf|ico|mp4)$/, r => r.abort())
  await ctx.route(/google|facebook|twitter|sentry|analytics|hotjar/i, r => r.abort())

  await page.goto('https://www.bitget.com/copy-trading', { waitUntil: 'domcontentloaded', timeout: 15000 })
  await sleep(4000)

  // Test if API works
  const test = await page.evaluate(async () => {
    const r = await fetch('/v1/trigger/trace/public/topTraders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageNo: 1, pageSize: 5, model: 1 })
    })
    return r.ok
  })
  if (!test) { console.log('❌ API not accessible'); await browser.close(); return }
  console.log('✅ API accessible')

  // For each trader, try to get detail data
  let updated = 0, failed = 0
  const traders = [...traderMap.entries()]

  for (let i = 0; i < traders.length; i++) {
    const [uid, rows] = traders[i]
    if ((i + 1) % 25 === 0) console.log(`  [${i + 1}/${traders.length}]`)

    try {
      // Try trader profile info
      const info = await page.evaluate(async (u) => {
        const r = await fetch('/v1/trigger/trace/public/traderInfo?traderUid=' + u)
        return r.ok ? r.json() : null
      }, uid)

      const d = info?.data
      if (!d) { failed++; continue }

      const metrics = {
        pnl: parseNum(d.totalProfit ?? d.pnl),
        win_rate: parseNum(d.winRate ?? d.winRatio),
        max_drawdown: parseNum(d.maxDrawdown ?? d.maxDrawRate ?? d.currentDrawRate),
        trades_count: parseNum(d.totalTrade ?? d.tradeCount ?? d.orderCount),
      }

      for (const snap of rows) {
        const updates = {}
        if (snap.pnl == null && metrics.pnl != null) updates.pnl = metrics.pnl
        if (snap.win_rate == null && metrics.win_rate != null) updates.win_rate = metrics.win_rate
        if (snap.max_drawdown == null && metrics.max_drawdown != null) updates.max_drawdown = metrics.max_drawdown
        if (snap.trades_count == null && metrics.trades_count != null) updates.trades_count = metrics.trades_count
        if (!Object.keys(updates).length) continue

        if (!DRY) {
          const { error } = await sb.from('trader_snapshots').update(updates).eq('id', snap.id)
          if (!error) updated++; else failed++
        } else {
          console.log(`  [DRY] ${snap.id} → ${JSON.stringify(updates)}`)
          updated++
        }
      }

      await sleep(500 + Math.random() * 1000)
    } catch (e) {
      failed++
    }
  }

  await browser.close()
  console.log(`✅ Bitget: ${updated} updated, ${failed} failed`)
}

main().catch(e => { console.error('❌', e.message); process.exit(1) })
