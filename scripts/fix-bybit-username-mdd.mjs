#!/usr/bin/env node
/**
 * Fix bybit leaderboard_ranks max_drawdown for username-format source_trader_ids
 * 
 * Some bybit traders were imported using their nickName as source_trader_id
 * (e.g., "hermes_bot", "strelka", "ixor") instead of the leaderMark token.
 * 
 * Strategy:
 * 1. Collect all username-format null-MDD bybit rows
 * 2. Use Puppeteer to paginate the bybit futures listing and build nickName→leaderMark map
 * 3. For matched traders, call leader-income API and update max_drawdown
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import https from 'https'

puppeteer.use(StealthPlugin())

const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

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

const PERIOD_PREFIX = { '7D': 'sevenDay', '30D': 'thirtyDay', '90D': 'ninetyDay' }

function isBase64Mark(id) {
  return id.includes('=') || id.includes('+') || id.includes('/') || /^[A-Za-z0-9+/]{20,}$/.test(id)
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

async function fetchLeaderIncome(leaderMark) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { status, body } = await httpsGet(
        `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?leaderMark=${encodeURIComponent(leaderMark)}`
      )
      if (status !== 200) return null
      if (body.startsWith('<')) return null
      const json = JSON.parse(body)
      if (json.retCode !== 0) return null
      return json.result
    } catch (e) {
      if (attempt === 0) await sleep(500)
    }
  }
  return null
}

async function main() {
  console.log('=== Fix bybit username-format trader max_drawdown ===')

  // Get null-MDD rows where source_trader_id is NOT a base64 leaderMark
  let allRows = []
  let from = 0
  while (true) {
    const { data, error } = await sb.from('leaderboard_ranks')
      .select('id, source_trader_id, season_id, max_drawdown')
      .eq('source', 'bybit')
      .is('max_drawdown', null)
      .range(from, from + 999)
    if (error) { console.error('DB error:', error.message); break }
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    from += 1000
  }

  // Filter to username-format only
  const usernameRows = allRows.filter(r => !isBase64Mark(r.source_trader_id))
  console.log(`Total null MDD rows: ${allRows.length}`)
  console.log(`Username-format rows: ${usernameRows.length}`)

  if (!usernameRows.length) {
    console.log('Nothing to do!')
    return
  }

  const needNicknames = new Set(usernameRows.map(r => r.source_trader_id))
  console.log(`Unique nicknames to find: ${needNicknames.size}`)
  console.log('Nicknames:', [...needNicknames].join(', '))

  // Group by trader
  const byTrader = new Map()
  for (const r of usernameRows) {
    if (!byTrader.has(r.source_trader_id)) byTrader.set(r.source_trader_id, [])
    byTrader.get(r.source_trader_id).push(r)
  }

  // --- Launch Puppeteer to scan listing ---
  console.log('\nLaunching browser...')
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  })
  const page = await browser.newPage()
  await page.setUserAgent(UA)

  // Visit bybit to get session cookies
  console.log('Visiting bybit.com...')
  try {
    await page.goto('https://www.bybit.com/copyTrade/', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(4000)
    console.log('Page loaded')
  } catch (e) {
    console.log('Warning:', e.message?.substring(0, 80))
  }

  const nickToMark = new Map()

  // Paginate the futures listing to find nicknames
  // Bybit futures uses api2.bybit.com with page.goto (not evaluate fetch)
  const DURATIONS = ['DATA_DURATION_NINETY_DAY', 'DATA_DURATION_THIRTY_DAY', 'DATA_DURATION_SEVEN_DAY']
  const LIST_URL = 'https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list'

  async function navFetch(url) {
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 })
      if (resp?.status() !== 200) return null
      const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '')
      if (!text || text.startsWith('<') || text.length < 10) return null
      return JSON.parse(text)
    } catch { return null }
  }

  // First test the listing works
  const testResult = await navFetch(`${LIST_URL}?pageNo=1&pageSize=2&dataDuration=DATA_DURATION_SEVEN_DAY&sortField=LEADER_SORT_FIELD_SORT_ROI`)
  console.log('Listing API test:', testResult ? `retCode=${testResult.retCode} items=${testResult.result?.leaderDetails?.length}` : 'FAILED')

  if (!testResult || testResult.retCode !== 0) {
    console.log('WARNING: Listing API not working, cannot resolve usernames')
  } else {
    console.log('\n📡 Scanning listing API for username→leaderMark mappings...')
    
    for (const duration of DURATIONS) {
      if (nickToMark.size >= needNicknames.size) break
      console.log(`  Duration ${duration}...`)
      
      for (let pageNo = 1; pageNo <= 40; pageNo++) {
        const result = await navFetch(`${LIST_URL}?pageNo=${pageNo}&pageSize=50&dataDuration=${duration}&sortField=LEADER_SORT_FIELD_SORT_ROI`)

        if (!result || result.retCode !== 0) {
          console.log(`    Page ${pageNo}: error`)
          break
        }

        const items = result.result?.leaderDetails || []
        if (!items.length) { console.log(`    Page ${pageNo}: empty, stopping`); break }

        for (const item of items) {
          const nick = item.nickName || ''
          const mark = item.leaderMark
          
          if (nick && mark && needNicknames.has(nick)) {
            nickToMark.set(nick, mark)
          }
          
          // Also try normalizing: lowercase, replace spaces with _
          const normNick = nick.toLowerCase().replace(/\s+/g, '_')
          for (const n of needNicknames) {
            if (!nickToMark.has(n) && n.toLowerCase() === normNick) {
              nickToMark.set(n, mark)
            }
          }
        }

        await sleep(250)

        if (nickToMark.size >= needNicknames.size) {
          console.log(`    All nicknames found at page ${pageNo}!`)
          break
        }
      }
      
      console.log(`  After ${duration}: ${nickToMark.size}/${needNicknames.size} found`)
    }
  }

  await browser.close()
  console.log(`\nResolved ${nickToMark.size}/${needNicknames.size} username→leaderMark mappings`)
  
  const notFound = [...needNicknames].filter(n => !nickToMark.has(n))
  if (notFound.length) {
    console.log(`NOT found in listing: ${notFound.join(', ')}`)
  }

  if (!nickToMark.size) {
    console.log('No nicknames could be resolved. These traders may no longer be on the leaderboard.')
    return
  }

  // --- Fetch leader-income and update DB ---
  console.log('\n📝 Fetching per-trader data and updating...')
  let updated = 0, noData = 0, apiErr = 0, zeroMDD = 0

  for (const [nick, mark] of nickToMark.entries()) {
    const rows = byTrader.get(nick) || []
    const result = await fetchLeaderIncome(mark)
    
    if (!result) {
      apiErr++
      console.log(`  API err for ${nick} (mark: ${mark.substring(0, 10)}...)`)
      await sleep(300)
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
        console.log(`  ✓ ${nick} season=${row.season_id} mdd=${mdd}`)
      }
    }
    await sleep(100)
  }

  console.log('\n=== Done ===')
  console.log(`Updated: ${updated}`)
  console.log(`No data: ${noData}`)
  console.log(`API errors: ${apiErr}`)
  console.log(`Rows set to 0% drawdown: ${zeroMDD}`)
  console.log(`Unresolved nicknames: ${[...needNicknames].filter(n => !nickToMark.has(n)).length}`)

  const { count } = await sb.from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'bybit')
    .is('max_drawdown', null)
  console.log(`\nRemaining bybit null MDD rows: ${count}`)
}

main().catch(e => { console.error(e); process.exit(1) })
