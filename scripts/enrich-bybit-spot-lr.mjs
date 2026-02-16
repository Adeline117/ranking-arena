#!/usr/bin/env node
/**
 * Bybit Spot - Enrich leaderboard_ranks via listing API
 * Uses puppeteer to bypass WAF, then paginates the dynamic-leader-list API
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
const PAGE_SIZE = 50
const PERIOD_MAP = {
  '7D': 'DATA_DURATION_SEVEN_DAY',
  '30D': 'DATA_DURATION_THIRTY_DAY',
  '90D': 'DATA_DURATION_NINETY_DAY',
}

function parsePercent(s) {
  if (!s && s !== 0) return null
  const m = String(s).replace(/,/g, '').match(/([+-]?)(\d+(?:\.\d+)?)%?/)
  if (!m) return null
  return parseFloat(m[2]) * (m[1] === '-' ? -1 : 1)
}

async function main() {
  console.log('=== Bybit Spot Enrichment (leaderboard_ranks) ===')

  // Before counts
  const { count: tcNull } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'bybit_spot').is('trades_count', null)
  const { count: mddNull } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'bybit_spot').is('max_drawdown', null)
  console.log(`BEFORE: TC null=${tcNull}, MDD null=${mddNull}`)

  // Launch browser
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  })
  const page = await browser.newPage()
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

  console.log('Visiting bybit.com...')
  await page.goto('https://www.bybit.com/copyTrade/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await sleep(5000)

  // Collect enrichment data from listing API for all periods
  const enrichMap = new Map() // numeric uid -> { wr, mdd, tc }

  for (const [seasonId, duration] of Object.entries(PERIOD_MAP)) {
    console.log(`\n📡 Fetching ${seasonId} listing...`)
    for (let pageNo = 1; pageNo <= 20; pageNo++) {
      const url = `${API_PATH}?pageNo=${pageNo}&pageSize=${PAGE_SIZE}&dataDuration=${duration}&sortField=LEADER_SORT_FIELD_SORT_ROI`
      
      const result = await page.evaluate(async (apiUrl) => {
        try {
          const r = await fetch(apiUrl)
          return await r.json()
        } catch (e) { return { error: e.message } }
      }, url)

      if (result.error || result.retCode !== 0) {
        console.log(`  Page ${pageNo}: error`, result.retMsg || result.error)
        break
      }

      const items = result.result?.leaderDetails || []
      if (!items.length) { console.log(`  Page ${pageNo}: empty`); break }

      for (const item of items) {
        const uid = String(item.leaderUserId || '')
        if (!uid) continue

        // Extract metrics from metricValues array
        // [ROI, Drawdown, followerProfit, WinRate, PLRatio, SharpeRatio]
        const metrics = item.metricValues || []
        const mdd = metrics[1] ? Math.abs(parsePercent(metrics[1])) : null
        const wr = metrics[3] ? parsePercent(metrics[3]) : null
        
        // trades count from item fields
        const tc = item.winCount != null && item.loseCount != null ? 
          (parseInt(item.winCount) + parseInt(item.loseCount)) : null

        const key = `${uid}|${seasonId}`
        if (!enrichMap.has(key) || (tc != null && !enrichMap.get(key).tc)) {
          enrichMap.set(key, { wr, mdd, tc, uid, seasonId })
        }
      }

      if (pageNo % 5 === 0) console.log(`  Page ${pageNo}: ${enrichMap.size} total entries`)
      await sleep(800)
    }
  }

  await browser.close()
  console.log(`\n📊 Collected ${enrichMap.size} entries`)

  // Get rows needing enrichment
  let allRows = []
  let from = 0
  while (true) {
    const { data } = await sb.from('leaderboard_ranks')
      .select('id, source_trader_id, season_id, win_rate, max_drawdown, trades_count')
      .eq('source', 'bybit_spot')
      .or('trades_count.is.null,max_drawdown.is.null')
      .range(from, from + 999)
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    from += 1000
  }
  console.log(`Rows needing enrichment: ${allRows.length}`)

  let updated = 0
  for (const row of allRows) {
    const key = `${row.source_trader_id}|${row.season_id}`
    const d = enrichMap.get(key)
    if (!d) continue

    const updates = {}
    if (row.trades_count == null && d.tc != null) updates.trades_count = d.tc
    if (row.max_drawdown == null && d.mdd != null) updates.max_drawdown = d.mdd
    if (row.win_rate == null && d.wr != null) updates.win_rate = d.wr
    if (!Object.keys(updates).length) continue

    const { error } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
    if (!error) updated++
  }

  console.log(`Updated: ${updated}`)

  // After counts
  const { count: tcNull2 } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'bybit_spot').is('trades_count', null)
  const { count: mddNull2 } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'bybit_spot').is('max_drawdown', null)
  console.log(`AFTER: TC null=${tcNull2}, MDD null=${mddNull2}`)
  console.log('Done!')
}

main().catch(e => { console.error(e); process.exit(1) })
