#!/usr/bin/env node
/**
 * Enrich trader_snapshots_v2 for bitget_futures with win_rate and max_drawdown
 * New browser per batch of 25 traders. Uses page.evaluate(fetch) after CF clearance.
 */
import 'dotenv/config'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { sb, sleep } from './lib/index.mjs'

puppeteer.use(StealthPlugin())

const WINDOW_TO_CYCLE = { '7D': 7, '30D': 30, '90D': 90 }
const BATCH_SIZE = 25

async function processBatch(traderBatch, byTrader) {
  let updated = 0, skipped = 0

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

    await page.goto('https://www.bitget.com/copy-trading', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})
    await sleep(4000)
    await page.evaluate(() => {
      document.querySelectorAll('button').forEach(btn => {
        if ((btn.textContent || '').match(/OK|Got|Accept/)) try { btn.click() } catch {}
      })
    }).catch(() => {})
    await sleep(500)

    for (const tid of traderBatch) {
      const snapshots = byTrader[tid]
      const windows = [...new Set(snapshots.map(s => s.window))]
      
      for (const w of windows) {
        const cycleTime = WINDOW_TO_CYCLE[w]
        if (!cycleTime) continue

        try {
          const result = await Promise.race([
            page.evaluate(async (uid, ct) => {
              const r = await fetch('/v1/trigger/trace/public/cycleData', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ languageType: 0, triggerUserId: uid, cycleTime: ct }),
              })
              const text = await r.text()
              if (text.startsWith('<')) return null
              return JSON.parse(text)
            }, tid, cycleTime),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))
          ])

          if (result?.code === '00000' && result.data?.statisticsDTO) {
            const stats = result.data.statisticsDTO
            let winRate = parseFloat(stats.winningRate || '0')
            let mdd = parseFloat(stats.maxRetracement || '0')
            if (winRate > 0 && winRate <= 1) winRate *= 100
            if (mdd > 0 && mdd <= 1) mdd *= 100

            const updateData = {}
            if (winRate > 0) updateData.win_rate = winRate
            if (mdd > 0) updateData.max_drawdown = mdd
            const trades = parseInt(stats.totalTrades || '0') || null
            const followers = parseInt(stats.totalFollowers || '0') || null
            if (trades) updateData.trades_count = trades
            if (followers) updateData.followers = followers

            if (Object.keys(updateData).length > 0) {
              const ids = snapshots.filter(s => s.window === w).map(s => s.id)
              for (const id of ids) {
                const { error: ue } = await sb.from('trader_snapshots_v2').update(updateData).eq('id', id)
                if (!ue) updated++
              }
            } else skipped++
          } else skipped++
        } catch { skipped++ }
        await sleep(200 + Math.random() * 100)
      }
      await sleep(100)
    }
    await page.close().catch(() => {})
  } catch (e) {
    // browser may have crashed
  } finally {
    await browser.close().catch(() => {})
  }
  return { updated, skipped }
}

async function main() {
  const { data: rows, error } = await sb.from('trader_snapshots_v2')
    .select('id, trader_key, window')
    .eq('platform', 'bitget_futures')
    .is('win_rate', null)
    .order('trader_key')
  
  if (error) { console.error('DB error:', error.message); return }
  console.log(`Found ${rows.length} rows to enrich`)
  if (!rows.length) return

  const byTrader = {}
  for (const r of rows) {
    if (!byTrader[r.trader_key]) byTrader[r.trader_key] = []
    byTrader[r.trader_key].push(r)
  }
  const traderKeys = Object.keys(byTrader)
  console.log(`Unique traders: ${traderKeys.length}`)

  const batches = []
  for (let i = 0; i < traderKeys.length; i += BATCH_SIZE)
    batches.push(traderKeys.slice(i, i + BATCH_SIZE))
  console.log(`${batches.length} batches`)

  let totalUpdated = 0, totalSkipped = 0

  for (let b = 0; b < batches.length; b++) {
    try {
      const { updated, skipped } = await processBatch(batches[b], byTrader)
      totalUpdated += updated
      totalSkipped += skipped
      console.log(`  Batch ${b + 1}/${batches.length}: +${updated} | total=${totalUpdated} skip=${totalSkipped}`)
    } catch (e) {
      console.log(`  Batch ${b + 1}/${batches.length}: ERROR ${e.message} | total=${totalUpdated}`)
    }
    await sleep(3000)
  }

  console.log(`\n✅ Done: ${totalUpdated} updated, ${totalSkipped} skipped`)
}

main().catch(console.error)
