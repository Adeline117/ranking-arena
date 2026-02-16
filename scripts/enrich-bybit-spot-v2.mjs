#!/usr/bin/env node
/**
 * Bybit Spot - Enrich leaderboard_ranks via per-trader detail API
 * Step 1: Paginate listing to get leaderUserId -> leaderMark mapping
 * Step 2: Use leader-income API with leaderMark to get per-period stats
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'

puppeteer.use(StealthPlugin())

const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const API_PATH = '/x-api/fapi/beehive/public/v1/common/dynamic-leader-list'
const PERIOD_MAP = {
  '7D': 'DATA_DURATION_SEVEN_DAY',
  '30D': 'DATA_DURATION_THIRTY_DAY',
  '90D': 'DATA_DURATION_NINETY_DAY',
}
const PERIOD_PREFIX = { '7D': 'sevenDay', '30D': 'thirtyDay', '90D': 'ninetyDay' }

function extractPeriodStats(result, seasonId) {
  const pfx = PERIOD_PREFIX[seasonId]
  if (!pfx) return null
  const winCount = parseInt(result[pfx + 'WinCount'] || '0')
  const lossCount = parseInt(result[pfx + 'LossCount'] || '0')
  const totalTrades = winCount + lossCount
  const wrE4 = parseInt(result[pfx + 'ProfitWinRateE4'] || '0')
  const ddRaw = result[pfx + 'DrawDownE4']
  const ddE4 = ddRaw != null ? parseInt(ddRaw) : null
  return {
    win_rate: wrE4 > 0 ? wrE4 / 100 : (totalTrades > 0 ? parseFloat((winCount / totalTrades * 100).toFixed(2)) : null),
    max_drawdown: ddE4 != null ? ddE4 / 100 : null,
    trades_count: totalTrades > 0 ? totalTrades : null,
  }
}

async function main() {
  console.log('=== Bybit Spot Enrichment v2 (per-trader detail) ===')

  // Get rows needing enrichment
  let allRows = []
  let from = 0
  while (true) {
    const { data } = await sb.from('leaderboard_ranks')
      .select('id, source_trader_id, season_id, win_rate, max_drawdown, trades_count')
      .eq('source', 'bybit_spot')
      .or('trades_count.is.null,max_drawdown.is.null,win_rate.is.null')
      .range(from, from + 999)
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    from += 1000
  }
  console.log(`Rows needing enrichment: ${allRows.length}`)

  const needTraderIds = new Set(allRows.map(r => r.source_trader_id))
  console.log(`Unique trader IDs needed: ${needTraderIds.size}`)

  // Launch browser
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  })
  let page = await browser.newPage()
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

  console.log('Visiting bybit.com...')
  await page.goto('https://www.bybit.com/copyTrade/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await sleep(3000)

  // Step 1: Collect leaderUserId -> leaderMark mapping from listing API
  const uidToMark = new Map()
  console.log('\n📡 Step 1: Collecting leaderMark mappings...')
  
  for (const [, duration] of Object.entries(PERIOD_MAP)) {
    for (let pageNo = 1; pageNo <= 20; pageNo++) {
      const url = `${API_PATH}?pageNo=${pageNo}&pageSize=50&dataDuration=${duration}&sortField=LEADER_SORT_FIELD_SORT_ROI`
      const result = await page.evaluate(async (apiUrl) => {
        try { const r = await fetch(apiUrl); return await r.json() } catch (e) { return { error: e.message } }
      }, url)

      const items = result?.result?.leaderDetails || []
      if (!items.length) break
      
      for (const item of items) {
        const uid = String(item.leaderUserId || '')
        const mark = item.leaderMark
        if (uid && mark && needTraderIds.has(uid)) uidToMark.set(uid, mark)
      }
      await sleep(300)
    }
  }
  console.log(`  Found ${uidToMark.size}/${needTraderIds.size} leaderMark mappings`)

  // Step 2: Fetch per-trader detail using leader-income API
  console.log('\n📡 Step 2: Fetching per-trader details...')
  const byTrader = new Map()
  for (const r of allRows) {
    if (!byTrader.has(r.source_trader_id)) byTrader.set(r.source_trader_id, [])
    byTrader.get(r.source_trader_id).push(r)
  }

  const tradersWithMarks = [...uidToMark.entries()]
  let updated = 0, apiErr = 0, consecutiveErr = 0
  const startTime = Date.now()

  for (let i = 0; i < tradersWithMarks.length; i++) {
    const [uid, mark] = tradersWithMarks[i]
    const rows = byTrader.get(uid) || []

    try {
      const apiUrl = `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?leaderMark=${encodeURIComponent(mark)}`
      const response = await page.goto(apiUrl, { waitUntil: 'domcontentloaded', timeout: 8000 })
      const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '')

      if (!text || text.startsWith('<') || response.status() === 403) {
        apiErr++; consecutiveErr++
        if (consecutiveErr >= 5) {
          console.log(`  Refreshing browser at ${i}...`)
          await page.close().catch(() => {})
          page = await browser.newPage()
          await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
          try { await page.goto('https://www.bybit.com/copyTrade/', { waitUntil: 'domcontentloaded', timeout: 20000 }); await sleep(5000) } catch {}
          consecutiveErr = 0
        }
        await sleep(1000)
        continue
      }

      let json
      try { json = JSON.parse(text) } catch { apiErr++; consecutiveErr++; continue }
      if (json.retCode !== 0) { apiErr++; consecutiveErr++; continue }

      consecutiveErr = 0
      const result = json.result

      for (const row of rows) {
        const stats = extractPeriodStats(result, row.season_id)
        if (!stats) continue

        const update = {}
        if (row.win_rate == null && stats.win_rate != null) update.win_rate = stats.win_rate
        if (row.max_drawdown == null && stats.max_drawdown != null) update.max_drawdown = stats.max_drawdown
        if (row.trades_count == null && stats.trades_count != null) update.trades_count = stats.trades_count

        if (Object.keys(update).length) {
          const { error } = await sb.from('leaderboard_ranks').update(update).eq('id', row.id)
          if (!error) updated++
        }
      }
    } catch (e) {
      apiErr++; consecutiveErr++
      if (consecutiveErr >= 5) {
        console.log(`  Refreshing browser at ${i} due to ${consecutiveErr} consecutive errors...`)
        await page.close().catch(() => {})
        page = await browser.newPage()
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
        try { await page.goto('https://www.bybit.com/copyTrade/', { waitUntil: 'domcontentloaded', timeout: 20000 }); await sleep(3000) } catch {}
        consecutiveErr = 0
      }
    }

    if ((i + 1) % 50 === 0) {
      const mins = ((Date.now() - startTime) / 60000).toFixed(1)
      console.log(`  [${i + 1}/${tradersWithMarks.length}] updated=${updated} err=${apiErr} | ${mins}m`)
    }
    await sleep(500)
  }

  await browser.close()

  // Verify
  const { count: tcNull } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'bybit_spot').is('trades_count', null)
  const { count: mddNull } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'bybit_spot').is('max_drawdown', null)
  console.log(`\nDone! Updated=${updated}, Errors=${apiErr}`)
  console.log(`Remaining: TC null=${tcNull}, MDD null=${mddNull}`)
}

main().catch(e => { console.error(e); process.exit(1) })
