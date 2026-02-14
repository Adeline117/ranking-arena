#!/usr/bin/env node
/**
 * Bitget Spot - Enrich win_rate, max_drawdown, trades_count for all periods
 * Uses Puppeteer to bypass Cloudflare, then fetches cycleData API
 */
import 'dotenv/config'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { createClient } from '@supabase/supabase-js'

puppeteer.use(StealthPlugin())

const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const CYCLE_MAP = { '7D': 7, '30D': 30, '90D': 90 }

async function main() {
  // Get all bitget_spot snapshots needing enrichment
  const allSnaps = []
  let from = 0
  while (true) {
    const { data, error } = await sb.from('trader_snapshots')
      .select('id, source_trader_id, season_id, win_rate, max_drawdown, trades_count, roi, pnl')
      .eq('source', 'bitget_spot')
      .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
      .range(from, from + 999)
    if (error || !data?.length) break
    allSnaps.push(...data)
    if (data.length < 1000) break
    from += 1000
  }

  console.log(`Bitget Spot: ${allSnaps.length} snapshots need enrichment`)
  if (!allSnaps.length) return

  // Group by trader
  const byTrader = new Map()
  for (const s of allSnaps) {
    if (!byTrader.has(s.source_trader_id)) byTrader.set(s.source_trader_id, [])
    byTrader.get(s.source_trader_id).push(s)
  }
  console.log(`Unique traders: ${byTrader.size}`)

  // Launch browser
  console.log('🌐 Launching browser...')
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--proxy-server=http://127.0.0.1:7890'],
  })
  const page = await browser.newPage()
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
  
  await page.goto('https://www.bitget.com/copy-trading', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})
  await sleep(5000)
  console.log('✅ Browser ready')

  let updated = 0, errors = 0, noData = 0
  const traderEntries = [...byTrader.entries()]

  for (let i = 0; i < traderEntries.length; i++) {
    const [tid, snaps] = traderEntries[i]

    for (const snap of snaps) {
      const cycleTime = CYCLE_MAP[snap.season_id]
      if (!cycleTime) continue

      // Only fetch if we actually need data for this period
      if (snap.win_rate != null && snap.max_drawdown != null && snap.trades_count != null) continue

      try {
        const result = await Promise.race([
          page.evaluate(async (uid, ct) => {
            try {
              const r = await fetch('/v1/trigger/trace/public/cycleData', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ languageType: 0, triggerUserId: uid, cycleTime: ct }),
                signal: AbortSignal.timeout(8000),
              })
              return await r.json()
            } catch (e) { return { error: e.message } }
          }, tid, cycleTime),
          sleep(15000).then(() => ({ timeout: true }))
        ])

        if (result?.timeout) {
          errors++
          await page.goto('https://www.bitget.com/copy-trading', { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {})
          await sleep(3000)
          continue
        }

        if (result?.code === '00000' && result.data?.statisticsDTO) {
          const stats = result.data.statisticsDTO
          const updates = {}
          
          if (snap.win_rate == null) {
            const wr = parseFloat(stats.winningRate)
            if (!isNaN(wr)) updates.win_rate = wr
          }
          if (snap.max_drawdown == null) {
            const mdd = parseFloat(stats.maxRetracement)
            if (!isNaN(mdd)) updates.max_drawdown = mdd
          }
          if (snap.trades_count == null) {
            const tc = parseInt(stats.totalTrades)
            if (!isNaN(tc) && tc > 0) updates.trades_count = tc
          }

          if (Object.keys(updates).length > 0) {
            const { error } = await sb.from('trader_snapshots').update(updates).eq('id', snap.id)
            if (!error) updated++
            else errors++
          } else {
            noData++
          }
        } else {
          noData++
        }
      } catch { errors++ }

      await sleep(400 + Math.random() * 300)
    }

    if ((i + 1) % 20 === 0 || i === traderEntries.length - 1) {
      console.log(`  [${i + 1}/${traderEntries.length}] updated=${updated} noData=${noData} errors=${errors}`)
    }
  }

  await browser.close()
  console.log(`\n✅ Bitget Spot done: updated=${updated} noData=${noData} errors=${errors}`)
}

main().catch(e => { console.error(e); process.exit(1) })
