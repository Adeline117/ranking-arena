/**
 * Enrich KuCoin leaderboard_ranks: win_rate, trades_count
 * Uses Puppeteer + Stealth to call KuCoin APIs from browser context
 */
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import pg from 'pg'

puppeteer.use(StealthPlugin())

const DB_URL = 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'
const PERIOD_MAP = { '7D': '7d', '30D': '30d', '90D': '90d' }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function main() {
  const client = new pg.Client(DB_URL)
  await client.connect()

  const { rows } = await client.query(`
    SELECT id, source_trader_id, season_id
    FROM leaderboard_ranks
    WHERE source = 'kucoin' AND win_rate IS NULL
    ORDER BY source_trader_id, season_id
  `)
  console.log(`📊 ${rows.length} rows need enrichment`)

  // Group by trader
  const byTrader = new Map()
  for (const r of rows) {
    if (!byTrader.has(r.source_trader_id)) byTrader.set(r.source_trader_id, [])
    byTrader.get(r.source_trader_id).push(r)
  }
  const traders = [...byTrader.entries()]
  console.log(`📊 ${traders.length} unique traders`)

  // Launch browser
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.goto('https://www.kucoin.com/copytrading', { waitUntil: 'networkidle2', timeout: 60000 })
  await sleep(3000)
  console.log('✅ Browser ready')

  let updated = 0, noData = 0, failed = 0

  for (let i = 0; i < traders.length; i++) {
    const [tid, traderRows] = traders[i]
    const periods = [...new Set(traderRows.map(r => PERIOD_MAP[r.season_id] || '30d'))]

    try {
      const results = await page.evaluate(async (tid, periods) => {
        const out = {}
        for (const per of periods) {
          try {
            const c = new AbortController()
            const tmr = setTimeout(() => c.abort(), 10000)
            const r = await fetch(
              `https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/leadShow/positionHistory?lang=en_US&leadConfigId=${tid}&period=${per}`,
              { signal: c.signal }
            )
            clearTimeout(tmr)
            const j = await r.json()
            if (j.success && Array.isArray(j.data) && j.data.length > 0) {
              const wins = j.data.filter(p => parseFloat(p.closePnl) > 0).length
              out[per] = {
                wr: parseFloat((wins / j.data.length * 100).toFixed(2)),
                tc: j.data.length
              }
            }
          } catch {}
        }
        return out
      }, tid, periods)

      let traderUpdated = 0
      for (const row of traderRows) {
        const per = PERIOD_MAP[row.season_id] || '30d'
        const data = results[per]
        if (!data) { noData++; continue }
        try {
          await client.query(
            'UPDATE leaderboard_ranks SET win_rate = $1, trades_count = $2 WHERE id = $3',
            [data.wr, data.tc, row.id]
          )
          updated++
          traderUpdated++
        } catch (e) {
          process.stderr.write(`DB err ${row.id}: ${e.message}\n`)
          failed++
        }
      }

      if (traderUpdated > 0) {
        process.stdout.write(`  [${i + 1}/${traders.length}] ${tid}: ✅ updated ${traderUpdated} rows (${JSON.stringify(results)})\n`)
      }
    } catch (e) {
      process.stderr.write(`err ${tid}: ${e.message}\n`)
      failed += traderRows.length
    }

    // Progress every 50 traders
    if ((i + 1) % 50 === 0 || i === traders.length - 1) {
      process.stdout.write(`  📊 [${i + 1}/${traders.length}] updated=${updated} noData=${noData} failed=${failed}\n`)
    }

    // Random delay 2-5s between traders
    await sleep(2000 + Math.random() * 3000)

    // Refresh page every 150 traders
    if ((i + 1) % 150 === 0) {
      process.stdout.write('  🔄 Refreshing browser session...\n')
      await page.reload({ waitUntil: 'networkidle2', timeout: 60000 })
      await sleep(3000)
    }
  }

  await browser.close()
  await client.end()
  process.stdout.write(`\n✅ Done: updated=${updated}, noData=${noData}, failed=${failed}\n`)
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
