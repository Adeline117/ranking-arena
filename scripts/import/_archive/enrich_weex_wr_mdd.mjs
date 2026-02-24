/**
 * Enrich Weex traders with Win Rate
 * 
 * Strategy:
 *   1. Intercept traderListView responses for WR from itemVoList
 *   2. For remaining traders, visit detail pages and scrape Wins/Trades
 * 
 * MDD is NOT available from Weex APIs.
 * 
 * Usage: node scripts/import/enrich_weex_wr_mdd.mjs
 */
import { chromium } from 'playwright'
import { getSupabaseClient, calculateArenaScore, sleep } from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const PROXY = 'http://127.0.0.1:7890'

async function main() {
  console.log('Weex WR enrichment\n')

  const { data: dbTraders } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, season_id, win_rate, max_drawdown, roi, pnl')
    .eq('source', 'weex')

  console.log(`DB has ${dbTraders.length} weex snapshot rows`)
  const allIds = [...new Set(dbTraders.map(r => r.source_trader_id))]
  const needIds = [...new Set(dbTraders.filter(r => r.win_rate == null).map(r => r.source_trader_id))]
  console.log(`Unique traders: ${allIds.length}, need WR: ${needIds.length}`)
  if (!needIds.length) { console.log('Nothing to do'); return }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({
    proxy: { server: PROXY },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })

  // wrData: traderId -> winRate (0-100)
  const wrData = new Map()

  // Phase 1: Intercept list API for WR from itemVoList
  console.log('\nPhase 1: Intercepting list API...')
  const page = await ctx.newPage()
  page.on('response', async (r) => {
    if (!r.url().includes('traderListView') && !r.url().includes('topTraderListView')) return
    try {
      const json = await r.json()
      if (json.code !== 'SUCCESS') return
      for (const item of (json.data?.rows || [])) {
        const id = String(item.traderUserId || '')
        if (!id || wrData.has(id)) continue
        for (const col of (item.itemVoList || [])) {
          if ((col.showColumnDesc || '').toLowerCase().includes('win rate')) {
            const val = parseFloat(col.showColumnValue)
            if (!isNaN(val) && val >= 0 && val <= 100) wrData.set(id, val)
          }
        }
      }
    } catch {}
  })

  await page.goto('https://www.weex.com/copy-trading', { timeout: 45000, waitUntil: 'domcontentloaded' })
  await sleep(12000)
  console.log(`  From list interception: ${wrData.size} traders`)

  // Phase 2: Visit each remaining trader's detail page and scrape Wins/Trades
  const remaining = needIds.filter(id => !wrData.has(id))
  console.log(`\nPhase 2: Scraping ${remaining.length} trader detail pages...`)

  let scraped = 0
  for (const id of remaining) {
    try {
      await page.goto(`https://www.weex.com/copy-trading/trader/${id}`, {
        timeout: 20000, waitUntil: 'domcontentloaded'
      })
      await sleep(6000)

      const result = await page.evaluate(() => {
        const text = document.body?.innerText || ''
        // Look for "Trades\nNNN\nWins\nNNN" pattern
        const tradesMatch = text.match(/Trades\s*\n\s*(\d[\d,]*)/i)
        const winsMatch = text.match(/Wins\s*\n\s*(\d[\d,]*)/i)
        if (tradesMatch && winsMatch) {
          const trades = parseInt(tradesMatch[1].replace(/,/g, ''))
          const wins = parseInt(winsMatch[1].replace(/,/g, ''))
          if (trades > 0) return { wins, trades, wr: (wins / trades) * 100 }
        }
        return null
      })

      if (result && result.wr != null) {
        wrData.set(id, Math.round(result.wr * 100) / 100)
        scraped++
      }
    } catch {}

    if ((scraped + wrData.size) % 10 === 0 || remaining.indexOf(id) === remaining.length - 1) {
      console.log(`  Progress: ${remaining.indexOf(id) + 1}/${remaining.length}, scraped: ${scraped}`)
    }
  }

  await browser.close()
  console.log(`\nTotal WR data: ${wrData.size} traders (${scraped} from detail pages)`)

  // Update DB
  let updated = 0
  for (const row of dbTraders) {
    const wr = wrData.get(row.source_trader_id)
    if (wr == null || row.win_rate != null) continue

    const updateObj = { win_rate: Math.round(wr * 100) / 100 }
    updateObj.arena_score = calculateArenaScore(row.roi, row.pnl, row.max_drawdown, wr, row.season_id).totalScore

    const { error } = await supabase.from('trader_snapshots').update(updateObj)
      .eq('source', 'weex').eq('source_trader_id', row.source_trader_id).eq('season_id', row.season_id)
    if (!error) updated++
  }

  console.log(`✅ Updated ${updated} rows`)

  // Verify
  for (const period of ['7D', '30D', '90D']) {
    const { data: v } = await supabase.from('trader_snapshots').select('win_rate,max_drawdown')
      .eq('source', 'weex').eq('season_id', period)
    const t = v.length, wr = v.filter(r => r.win_rate != null).length, mdd = v.filter(r => r.max_drawdown != null).length
    console.log(`  ${period}: ${t} | WR: ${wr}/${t} (${Math.round(100 * wr / t)}%) | MDD: ${mdd}/${t} (${Math.round(100 * mdd / t)}%)`)
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
