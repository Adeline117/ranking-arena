#!/usr/bin/env node
/**
 * Fix max_drawdown for bybit AND bybit_spot using Puppeteer to bypass IP rate limit.
 * 
 * Handles:
 * 1. bybit: base64 leaderMark IDs → leader-income?leaderMark=<mark>
 * 2. bybit_spot: numeric UIDs → leader-income?leaderUserId=<uid>
 * 
 * Root cause of remaining null rows: DrawDownE4=0 was treated as null.
 * Fix: treat 0 as valid (0% drawdown).
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
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const PERIOD_PREFIX = { '7D': 'sevenDay', '30D': 'thirtyDay', '90D': 'ninetyDay' }

function isBase64Mark(id) {
  return id.includes('=') || id.includes('+') || (id.includes('/') && !id.startsWith('/'))
}

function extractMDD(result, seasonId) {
  const pfx = PERIOD_PREFIX[seasonId]
  if (!pfx) return null
  const ddRaw = result[pfx + 'DrawDownE4']
  if (ddRaw == null || ddRaw === '') return null
  const ddE4 = parseInt(ddRaw)
  if (isNaN(ddE4)) return null
  return ddE4 / 100  // e.g. 9964 → 99.64%
}

async function main() {
  console.log('=== Fix max_drawdown (bybit + bybit_spot) via Puppeteer ===')

  // ── Load all null-MDD rows ──
  const nullRows = { bybit: [], bybit_spot: [] }
  for (const source of ['bybit', 'bybit_spot']) {
    let from = 0
    while (true) {
      const { data, error } = await sb.from('leaderboard_ranks')
        .select('id, source_trader_id, season_id, max_drawdown')
        .eq('source', source)
        .is('max_drawdown', null)
        .range(from, from + 999)
      if (error) { console.error('DB error:', error.message); break }
      if (!data?.length) break
      nullRows[source].push(...data)
      if (data.length < 1000) break
      from += 1000
    }
  }

  const bybitBase64 = nullRows.bybit.filter(r => isBase64Mark(r.source_trader_id))
  const bybitUsername = nullRows.bybit.filter(r => !isBase64Mark(r.source_trader_id))
  
  console.log(`bybit base64 null rows: ${bybitBase64.length}`)
  console.log(`bybit username null rows: ${bybitUsername.length} (will try listing lookup)`)
  console.log(`bybit_spot null rows: ${nullRows.bybit_spot.length}`)

  // ── Group by trader ──
  function groupByTrader(rows) {
    const m = new Map()
    for (const r of rows) {
      if (!m.has(r.source_trader_id)) m.set(r.source_trader_id, [])
      m.get(r.source_trader_id).push(r)
    }
    return m
  }

  const bybitBase64Map = groupByTrader(bybitBase64)
  const bybitUsernameMap = groupByTrader(bybitUsername)
  const spotMap = groupByTrader(nullRows.bybit_spot)

  // ── Launch Puppeteer ──
  console.log('\nLaunching browser...')
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  })
  const page = await browser.newPage()
  await page.setUserAgent(UA)

  console.log('Visiting bybit.com...')
  try {
    await page.goto('https://www.bybit.com/copyTrade/', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(4000)
    console.log('Page loaded')
  } catch (e) {
    console.log('Warning:', e.message?.substring(0, 80))
  }

  // ── Helper: fetch via page.evaluate ──
  async function browserFetch(url) {
    return page.evaluate(async (fetchUrl) => {
      try {
        const r = await fetch(fetchUrl)
        if (!r.ok) return { error: r.status }
        return await r.json()
      } catch (e) { return { error: e.message } }
    }, url)
  }

  // ── Refresh browser page if needed ──
  let requestCount = 0
  async function maybeRefresh() {
    requestCount++
    if (requestCount % 150 === 0) {
      console.log(`  [refresh at ${requestCount} requests]`)
      try {
        await page.goto('https://www.bybit.com/copyTrade/', { waitUntil: 'domcontentloaded', timeout: 15000 })
        await sleep(2000)
      } catch {}
    }
  }

  // ── Process bybit base64 traders ──
  console.log(`\n─── bybit base64 (${bybitBase64Map.size} traders) ───`)
  let updated = 0, noData = 0, apiErr = 0, zeroMDD = 0
  const startTime = Date.now()
  let idx = 0

  for (const [traderId, rows] of bybitBase64Map) {
    await maybeRefresh()

    const url = `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?leaderMark=${encodeURIComponent(traderId)}`
    let json = null
    try {
      const res = await Promise.race([
        browserFetch(url),
        sleep(12000).then(() => ({ error: 'timeout' }))
      ])
      if (res?.retCode === 0) json = res.result
      else if (res?.error) apiErr++
    } catch { apiErr++ }

    if (!json) {
      await sleep(300)
      idx++
      continue
    }

    for (const row of rows) {
      const mdd = extractMDD(json, row.season_id)
      if (mdd === null) { noData++; continue }
      if (mdd === 0) zeroMDD++

      const { error } = await sb.from('leaderboard_ranks').update({ max_drawdown: mdd }).eq('id', row.id)
      if (!error) updated++
    }

    await sleep(300)
    idx++
    if (idx % 20 === 0 || idx === bybitBase64Map.size) {
      const mins = ((Date.now() - startTime) / 60000).toFixed(1)
      console.log(`  [${idx}/${bybitBase64Map.size}] updated=${updated} noData=${noData} apiErr=${apiErr} zeroMDD=${zeroMDD} | ${mins}m`)
    }
  }

  console.log(`bybit base64 done: updated=${updated} noData=${noData} apiErr=${apiErr}`)

  // ── Process bybit_spot traders ──
  console.log(`\n─── bybit_spot (${spotMap.size} traders) ───`)
  let spotUpdated = 0, spotNoData = 0, spotErr = 0, spotZero = 0
  idx = 0

  for (const [uid, rows] of spotMap) {
    await maybeRefresh()

    const url = `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?leaderUserId=${encodeURIComponent(uid)}`
    let json = null
    try {
      const res = await Promise.race([
        browserFetch(url),
        sleep(12000).then(() => ({ error: 'timeout' }))
      ])
      if (res?.retCode === 0) json = res.result
      else if (res?.error) spotErr++
    } catch { spotErr++ }

    if (!json) {
      await sleep(300)
      idx++
      continue
    }

    for (const row of rows) {
      const mdd = extractMDD(json, row.season_id)
      if (mdd === null) { spotNoData++; continue }
      if (mdd === 0) spotZero++

      const { error } = await sb.from('leaderboard_ranks').update({ max_drawdown: mdd }).eq('id', row.id)
      if (!error) spotUpdated++
    }

    await sleep(300)
    idx++
    if (idx % 20 === 0 || idx === spotMap.size) {
      const mins = ((Date.now() - startTime) / 60000).toFixed(1)
      console.log(`  [${idx}/${spotMap.size}] updated=${spotUpdated} noData=${spotNoData} err=${spotErr} zeroMDD=${spotZero} | ${mins}m`)
    }
  }

  console.log(`bybit_spot done: updated=${spotUpdated} noData=${spotNoData} apiErr=${spotErr}`)

  // ── Process bybit username traders (if any) ──
  if (bybitUsernameMap.size > 0) {
    console.log(`\n─── bybit username traders (${bybitUsernameMap.size} unique) ───`)
    // These require listing to get leaderMark first - handled separately
    // Just log the remaining usernames for reference
    console.log('Usernames needing leaderMark lookup:', [...bybitUsernameMap.keys()].join(', '))
    
    // Try scanning listing for username → leaderMark
    const needNicks = new Set(bybitUsernameMap.keys())
    const nickToMark = new Map()
    const DURATIONS = ['DATA_DURATION_NINETY_DAY', 'DATA_DURATION_THIRTY_DAY', 'DATA_DURATION_SEVEN_DAY']
    
    console.log('Scanning listing for username→leaderMark...')
    for (const duration of DURATIONS) {
      if (nickToMark.size >= needNicks.size) break
      for (let pageNo = 1; pageNo <= 40; pageNo++) {
        const url = `https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list?pageNo=${pageNo}&pageSize=50&dataDuration=${duration}&sortField=LEADER_SORT_FIELD_SORT_ROI`
        let result = null
        try {
          result = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 })
            .then(() => page.evaluate(() => { try { return JSON.parse(document.body.innerText) } catch { return null } }))
        } catch { break }

        if (!result || result.retCode !== 0) break
        const items = result.result?.leaderDetails || []
        if (!items.length) break

        for (const item of items) {
          const nick = item.nickName || ''
          const mark = item.leaderMark
          if (nick && mark && needNicks.has(nick)) nickToMark.set(nick, mark)
        }
        await sleep(200)
        if (nickToMark.size >= needNicks.size) break
      }
      console.log(`  ${duration}: ${nickToMark.size}/${needNicks.size} found`)
    }

    // Fetch data for found usernames
    let nickUpdated = 0, nickErr = 0
    for (const [nick, mark] of nickToMark) {
      const rows = bybitUsernameMap.get(nick) || []
      const url = `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?leaderMark=${encodeURIComponent(mark)}`
      const res = await Promise.race([browserFetch(url), sleep(10000).then(() => ({ error: 'timeout' }))])
      
      if (!res?.retCode || res.retCode !== 0) { nickErr++; await sleep(300); continue }
      
      for (const row of rows) {
        const mdd = extractMDD(res.result, row.season_id)
        if (mdd === null) continue
        const { error } = await sb.from('leaderboard_ranks').update({ max_drawdown: mdd }).eq('id', row.id)
        if (!error) { nickUpdated++; console.log(`  ✓ ${nick} season=${row.season_id} mdd=${mdd}`) }
      }
      await sleep(300)
    }
    console.log(`bybit username done: updated=${nickUpdated} errors=${nickErr} unresolved=${needNicks.size - nickToMark.size}`)
  }

  await browser.close()
  console.log('\nBrowser closed')

  // ── Verify ──
  console.log('\n=== Final counts ===')
  for (const source of ['bybit', 'bybit_spot']) {
    const { count } = await sb.from('leaderboard_ranks')
      .select('*', { count: 'exact', head: true })
      .eq('source', source)
      .is('max_drawdown', null)
    console.log(`${source} null MDD: ${count}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
