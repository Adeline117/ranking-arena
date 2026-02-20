#!/usr/bin/env node
/**
 * Fix bybit_spot leaderboard_ranks max_drawdown - Pass 2
 * 
 * Handles the remaining rows not resolved by fix-bybit-spot-mdd.mjs.
 * Uses leader-income?leaderUserId=<uid> directly (no Puppeteer needed).
 * The leaderUserId parameter works with numeric UIDs for spot traders.
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import https from 'https'

const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const PERIOD_PREFIX = { '7D': 'sevenDay', '30D': 'thirtyDay', '90D': 'ninetyDay' }

/** Use Node.js https module directly to avoid undici pool conflict with Supabase */
function httpsGet(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url)
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Connection': 'close' },
      timeout: timeoutMs,
    }
    const req = https.request(options, (res) => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('timeout', () => { req.destroy(new Error('Request timed out')) })
    req.on('error', reject)
    req.end()
  })
}

async function fetchLeaderIncomeByUID(uid) {
  const delays = [500, 1500]
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { status, body } = await httpsGet(
        `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?leaderUserId=${encodeURIComponent(uid)}`
      )
      if (status === 403) return null
      if (status === 429) { await sleep(3000); continue }
      if (status !== 200) return null
      const json = JSON.parse(body)
      if (json.retCode !== 0) return null
      return json.result
    } catch (e) {
      if (attempt < 2) await sleep(delays[attempt])
      else console.log(`  https err ${uid}: ${e.message?.substring(0, 60)}`)
    }
  }
  return null
}

function extractMDD(result, seasonId) {
  const pfx = PERIOD_PREFIX[seasonId]
  if (!pfx) return null
  const ddRaw = result[pfx + 'DrawDownE4']
  if (ddRaw == null || ddRaw === '') return null
  const ddE4 = parseInt(ddRaw)
  if (isNaN(ddE4)) return null
  return ddE4 / 100
}

async function main() {
  console.log('=== Fix bybit_spot max_drawdown - Pass 2 (leaderUserId API) ===')

  let allRows = []
  let from = 0
  while (true) {
    const { data, error } = await sb.from('leaderboard_ranks')
      .select('id, source_trader_id, season_id, max_drawdown')
      .eq('source', 'bybit_spot')
      .is('max_drawdown', null)
      .range(from, from + 999)
    if (error) { console.error('DB error:', error.message); break }
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    from += 1000
  }

  console.log(`Total bybit_spot null MDD rows: ${allRows.length}`)

  // Group by trader
  const byTrader = new Map()
  for (const r of allRows) {
    if (!byTrader.has(r.source_trader_id)) byTrader.set(r.source_trader_id, [])
    byTrader.get(r.source_trader_id).push(r)
  }
  const traders = [...byTrader.keys()]
  console.log(`Unique traders: ${traders.length}`)

  let updated = 0, noData = 0, apiErr = 0, zeroMDD = 0
  const startTime = Date.now()

  for (let i = 0; i < traders.length; i++) {
    const uid = traders[i]
    const rows = byTrader.get(uid)

    const result = await fetchLeaderIncomeByUID(uid)
    if (!result) {
      apiErr++
      await sleep(600)
      continue
    }

    for (const row of rows) {
      const mdd = extractMDD(result, row.season_id)
      if (mdd === null) {
        noData++
        continue
      }
      if (mdd === 0) zeroMDD++

      const { error } = await sb.from('leaderboard_ranks')
        .update({ max_drawdown: mdd })
        .eq('id', row.id)
      if (error) {
        console.log(`  ⚠ update id=${row.id}: ${error.message}`)
      } else {
        updated++
      }
    }

    await sleep(350)

    if ((i + 1) % 25 === 0 || i === traders.length - 1) {
      const mins = ((Date.now() - startTime) / 60000).toFixed(1)
      console.log(`  [${i + 1}/${traders.length}] updated=${updated} noData=${noData} apiErr=${apiErr} zeroMDD=${zeroMDD} | ${mins}m`)
    }
  }

  console.log('\n=== Done ===')
  console.log(`Updated: ${updated}`)
  console.log(`No data (API returned null): ${noData}`)
  console.log(`API errors: ${apiErr}`)
  console.log(`Rows set to 0% drawdown: ${zeroMDD}`)

  const { count } = await sb.from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'bybit_spot')
    .is('max_drawdown', null)
  console.log(`\nRemaining bybit_spot null MDD rows: ${count}`)
}

main().catch(e => { console.error(e); process.exit(1) })
