/**
 * Enrich KuCoin leaderboard_ranks: win_rate, trades_count
 * Uses Puppeteer + Stealth to call KuCoin APIs from browser context
 */
const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
const pg = require('pg')

puppeteer.use(StealthPlugin())

const DB_URL = 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'
const PERIOD_MAP = { '7D': '7d', '30D': '30d', '90D': '90d' }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

let browser, page

async function ensurePage() {
  if (!page || page.isClosed()) {
    if (browser) {
      try { await browser.close() } catch {}
    }
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] })
    page = await browser.newPage()
    // Block images/css/fonts to reduce load
    await page.setRequestInterception(true)
    page.on('request', req => {
      const rt = req.resourceType()
      if (['image', 'stylesheet', 'font', 'media'].includes(rt)) req.abort()
      else req.continue()
    })
    await page.goto('https://www.kucoin.com/copytrading', { waitUntil: 'networkidle2', timeout: 60000 })
    await sleep(3000)
    console.log('✅ Browser (re)initialized')
  }
}

async function fetchTraderData(tid, periods) {
  try {
    return await page.evaluate(async (tid, periods) => {
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
  } catch (e) {
    // Frame detached or other puppeteer error - reinit
    console.log(`  ⚠️ page.evaluate failed: ${e.message.slice(0, 60)} — reinitializing...`)
    page = null
    await ensurePage()
    // Retry once
    try {
      return await page.evaluate(async (tid, periods) => {
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
    } catch (e2) {
      console.error(`  ❌ retry failed: ${e2.message.slice(0, 60)}`)
      return {}
    }
  }
}

async function main() {
  const client = new pg.Client(DB_URL)
  await client.connect()
  console.log('DB connected')

  const { rows } = await client.query(`
    SELECT id, source_trader_id, season_id
    FROM leaderboard_ranks
    WHERE source = 'kucoin' AND win_rate IS NULL
    ORDER BY source_trader_id, season_id
  `)
  console.log(`📊 ${rows.length} rows need enrichment`)

  const byTrader = new Map()
  for (const r of rows) {
    if (!byTrader.has(r.source_trader_id)) byTrader.set(r.source_trader_id, [])
    byTrader.get(r.source_trader_id).push(r)
  }
  const traders = [...byTrader.entries()]
  console.log(`📊 ${traders.length} unique traders`)

  await ensurePage()

  let updated = 0, noData = 0, failed = 0

  for (let i = 0; i < traders.length; i++) {
    const [tid, traderRows] = traders[i]
    const periods = [...new Set(traderRows.map(r => PERIOD_MAP[r.season_id] || '30d'))]

    const results = await fetchTraderData(tid, periods)

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
        console.error(`  DB err ${row.id}: ${e.message}`)
        failed++
      }
    }

    if (traderUpdated > 0) {
      console.log(`  [${i + 1}/${traders.length}] ${tid}: ✅ ${traderUpdated} rows | ${JSON.stringify(results)}`)
    }

    if ((i + 1) % 50 === 0 || i === traders.length - 1) {
      console.log(`📊 [${i + 1}/${traders.length}] updated=${updated} noData=${noData} failed=${failed}`)
    }

    // Random delay 2-5s
    await sleep(2000 + Math.random() * 3000)

    // Proactive page refresh every 50 traders (before frame detaches)
    if ((i + 1) % 50 === 0) {
      console.log('  🔄 Refreshing browser...')
      try {
        await page.reload({ waitUntil: 'networkidle2', timeout: 60000 })
        await sleep(3000)
      } catch {
        page = null
        await ensurePage()
      }
    }
  }

  try { await browser.close() } catch {}
  await client.end()
  console.log(`\n✅ Done: updated=${updated}, noData=${noData}, failed=${failed}`)
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
