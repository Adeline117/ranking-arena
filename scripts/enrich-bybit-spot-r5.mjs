#!/usr/bin/env node
/**
 * Bybit Spot - Enrich trader_snapshots for bybit_spot
 * Uses puppeteer-stealth to call Bybit API (bypasses geo-block)
 * Fills: trades_count, max_drawdown
 */
import 'dotenv/config'
import pg from 'pg'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'

puppeteer.use(StealthPlugin())

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 })
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  console.log('=== Bybit Spot trader_snapshots enrichment ===')
  const client = await pool.connect()

  // Get distinct traders needing TC or MDD
  const { rows } = await client.query(`
    SELECT DISTINCT source_trader_id 
    FROM trader_snapshots 
    WHERE source = 'bybit_spot' 
      AND (trades_count IS NULL OR max_drawdown IS NULL)
  `)
  console.log(`Unique traders needing enrichment: ${rows.length}`)

  // Launch browser
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  })
  const page = await browser.newPage()
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')

  console.log('Visiting bybit.com to establish cookies...')
  try {
    await page.goto('https://www.bybit.com/copyTrade/', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(3000)
  } catch (e) {
    console.log('Warning:', e.message?.slice(0, 80))
  }

  // We need to map source_trader_id (numeric UID) to leaderMark
  // Try the leader-income endpoint directly with the UID as leaderMark
  // Also try the spot-specific API
  
  let updated = 0, failed = 0, noData = 0

  for (let i = 0; i < rows.length; i++) {
    const traderId = rows[i].source_trader_id

    // Refresh cookies every 150 traders
    if (i > 0 && i % 150 === 0) {
      try {
        await page.goto('https://www.bybit.com/copyTrade/', { waitUntil: 'domcontentloaded', timeout: 20000 })
        await sleep(2000)
      } catch {}
    }

    try {
      // Try the leader-income API (works for both spot and futures with the right leaderMark)
      const response = await Promise.race([
        page.evaluate(async (uid) => {
          try {
            // Try spot copy trade API first
            const res = await fetch(`https://api2.bybit.com/spot/api/copyTrading/v1/leader/detail?leaderId=${uid}`)
            if (res.ok) {
              const j = await res.json()
              if (j.retCode === 0 || j.ret_code === 0) return { type: 'spot', data: j.result || j.data }
            }
          } catch {}
          
          try {
            // Try the general income API
            const res = await fetch(`https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?leaderMark=${uid}`)
            if (res.ok) {
              const j = await res.json()
              if (j.retCode === 0) return { type: 'income', data: j.result }
            }
          } catch {}
          
          return null
        }, traderId),
        sleep(15000).then(() => null)
      ])

      if (!response || !response.data) {
        noData++
        await sleep(300)
        if ((i + 1) % 50 === 0) console.log(`${i+1}/${rows.length} | updated=${updated} noData=${noData} failed=${failed}`)
        continue
      }

      const d = response.data
      let tc = null, mdd = null

      if (response.type === 'spot') {
        // Extract from spot API
        tc = d.totalTrades ?? d.tradeCount ?? d.total_trades ?? null
        mdd = d.maxDrawdown ?? d.max_drawdown ?? null
      } else if (response.type === 'income') {
        // Extract from income API - try 90d first, then 30d, 7d
        for (const pfx of ['ninetyDay', 'thirtyDay', 'sevenDay']) {
          const wc = parseInt(d[pfx + 'WinCount'] || '0')
          const lc = parseInt(d[pfx + 'LossCount'] || '0')
          if (wc + lc > 0 && tc == null) tc = wc + lc
          const dd = d[pfx + 'DrawDownE4']
          if (dd != null && mdd == null) mdd = parseInt(dd) / 100
        }
      }

      if (tc == null && mdd == null) { noData++; await sleep(300); continue }

      const sets = []
      const vals = []
      let idx = 1
      if (tc != null) { sets.push(`trades_count = $${idx}`); vals.push(tc); idx++ }
      if (mdd != null) { sets.push(`max_drawdown = $${idx}`); vals.push(mdd); idx++ }
      vals.push(traderId)

      const result = await client.query(
        `UPDATE trader_snapshots SET ${sets.join(', ')} 
         WHERE source = 'bybit_spot' AND source_trader_id = $${idx}
           AND (trades_count IS NULL OR max_drawdown IS NULL)`,
        vals
      )
      updated += result.rowCount

    } catch (e) {
      failed++
      console.log(`  err ${traderId}: ${e.message?.slice(0, 60)}`)
    }

    await sleep(400)
    if ((i + 1) % 50 === 0) console.log(`${i+1}/${rows.length} | updated=${updated} noData=${noData} failed=${failed}`)
  }

  await browser.close()

  // Verify
  const verify = await client.query(`
    SELECT 
      COUNT(*) FILTER (WHERE trades_count IS NULL) as tc_null,
      COUNT(*) FILTER (WHERE max_drawdown IS NULL) as mdd_null,
      COUNT(*) as total
    FROM trader_snapshots WHERE source = 'bybit_spot'
  `)
  console.log('\nDone! Updated:', updated, 'NoData:', noData, 'Failed:', failed)
  console.log('Remaining gaps:', verify.rows[0])

  client.release()
  await pool.end()
}

main().catch(e => { console.error(e); process.exit(1) })
