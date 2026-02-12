#!/usr/bin/env node
/**
 * Bitget Futures - Enrich leaderboard_ranks via cycleData API
 * Refreshes CF clearance every 40 requests
 */
import 'dotenv/config'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import pg from 'pg'

puppeteer.use(StealthPlugin())

const DB_URL = process.env.DATABASE_URL
const CYCLE_MAP = { '7D': 7, '30D': 30, '90D': 90 }
const REFRESH_EVERY = 40

async function main() {
  const seasonArg = process.argv[2] || '30D'
  const limitArg = parseInt(process.argv[3] || '500')
  
  const db = new pg.Client(DB_URL)
  await db.connect()

  const { rows: missing } = await db.query(`
    SELECT source_trader_id, win_rate, max_drawdown, trades_count
    FROM leaderboard_ranks 
    WHERE source='bitget_futures' AND season_id=$1
    AND (win_rate IS NULL OR max_drawdown IS NULL OR trades_count IS NULL)
    AND source_trader_id ~ '^[a-f0-9]{10,}$'
    ORDER BY rank ASC LIMIT $2
  `, [seasonArg, limitArg])

  console.log(`Bitget Futures ${seasonArg}: ${missing.length} traders need enrichment`)
  if (!missing.length) { await db.end(); return }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })

  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')

  async function refreshCF() {
    console.log('  🔄 Refreshing CF clearance...')
    await page.goto('https://www.bitget.com/copy-trading', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
    await new Promise(r => setTimeout(r, 4000))
    await page.evaluate(() => {
      document.querySelectorAll('button').forEach(btn => {
        if (/OK|Got|Accept/i.test(btn.textContent)) try { btn.click() } catch {}
      })
    }).catch(() => {})
    await new Promise(r => setTimeout(r, 1000))
  }

  await refreshCF()
  
  let updated = 0, errors = 0, consecutiveErrors = 0
  const cycleTime = CYCLE_MAP[seasonArg]

  for (let i = 0; i < missing.length; i++) {
    // Refresh CF clearance periodically or after consecutive errors
    if (i > 0 && (i % REFRESH_EVERY === 0 || consecutiveErrors >= 5)) {
      await refreshCF()
      consecutiveErrors = 0
    }

    const t = missing[i]
    try {
      const result = await page.evaluate(async (uid, ct) => {
        try {
          const r = await fetch('/v1/trigger/trace/public/cycleData', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ languageType: 0, triggerUserId: uid, cycleTime: ct }),
          })
          const text = await r.text()
          if (text.includes('challenge') || text.includes('cloudflare') || r.status === 403) return { blocked: true }
          return JSON.parse(text)
        } catch(e) { return { error: e.message } }
      }, t.source_trader_id, cycleTime)

      if (result?.blocked) {
        consecutiveErrors++
        errors++
        continue
      }

      if (result?.code === '00000' && result.data?.statisticsDTO) {
        consecutiveErrors = 0
        const s = result.data.statisticsDTO
        const wr = t.win_rate === null && s.winningRate ? parseFloat(s.winningRate) : null
        const mdd = t.max_drawdown === null && s.maxRetracement ? parseFloat(s.maxRetracement) : null
        const tc = t.trades_count === null && s.totalTrades ? parseInt(s.totalTrades) : null

        if (wr !== null || mdd !== null || tc !== null) {
          const sets = [], vals = [t.source_trader_id, seasonArg]
          let idx = 3
          if (wr !== null) { sets.push(`win_rate=$${idx++}`); vals.push(wr) }
          if (mdd !== null) { sets.push(`max_drawdown=$${idx++}`); vals.push(mdd) }
          if (tc !== null) { sets.push(`trades_count=$${idx++}`); vals.push(tc) }
          if (sets.length) {
            await db.query(`UPDATE leaderboard_ranks SET ${sets.join(',')} WHERE source='bitget_futures' AND source_trader_id=$1 AND season_id=$2`, vals)
            updated++
          }
        }
      } else {
        consecutiveErrors++
        errors++
      }
    } catch { consecutiveErrors++; errors++ }

    if ((i + 1) % 20 === 0 || i === missing.length - 1) {
      console.log(`  [${i + 1}/${missing.length}] updated=${updated} errors=${errors}`)
    }
    await new Promise(r => setTimeout(r, 800 + Math.random() * 500))
  }

  await browser.close()
  
  const { rows: [v] } = await db.query(`
    SELECT count(*)::int as total, 
      round(100.0*count(CASE WHEN win_rate IS NOT NULL THEN 1 END)/count(*))::int as wr_pct,
      round(100.0*count(CASE WHEN max_drawdown IS NOT NULL THEN 1 END)/count(*))::int as mdd_pct,
      round(100.0*count(CASE WHEN trades_count IS NOT NULL THEN 1 END)/count(*))::int as tc_pct
    FROM leaderboard_ranks WHERE source='bitget_futures' AND season_id=$1
  `, [seasonArg])
  console.log(`\n✅ ${seasonArg} final: ${v.total} traders | WR=${v.wr_pct}% MDD=${v.mdd_pct}% TC=${v.tc_pct}%`)

  await db.end()
}

main().catch(e => { console.error(e); process.exit(1) })
