#!/usr/bin/env node
/**
 * Fix bybit leaderboard_ranks max_drawdown - COMPREHENSIVE v2
 *
 * Strategy:
 *   Phase 1: Numeric source_trader_ids → call leader-income?leaderUserId={id} directly
 *   Phase 2: Username source_trader_ids → use Puppeteer to scan listing,
 *            build nickName→leaderMark AND leaderUserId→leaderMark maps,
 *            then call leader-income?leaderMark={mark} for matched traders
 *
 * Key discovery: leaderUserId param works directly on leader-income API (no WAF).
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import https from 'https'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'

puppeteer.use(StealthPlugin())

const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── helpers ──────────────────────────────────────────────────────────────────

function httpsGet(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Connection': 'close' },
      timeout: timeoutMs,
    }, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })
}

const PERIOD_PREFIX = { '7D': 'sevenDay', '30D': 'thirtyDay', '90D': 'ninetyDay' }

function extractMDD(result, seasonId) {
  const pfx = PERIOD_PREFIX[seasonId]
  if (!pfx) return null
  const ddRaw = result[pfx + 'DrawDownE4']
  if (ddRaw == null || ddRaw === '') return null
  const ddE4 = parseInt(ddRaw)
  if (isNaN(ddE4)) return null
  return ddE4 / 100  // E4 → percent (e.g. 9964 → 99.64%)
}

function isNumericId(id) {
  return /^\d+$/.test(id)
}

// ── fetch with leaderMark (for username traders) ──────────────────────────────

async function fetchByMark(leaderMark) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { status, body } = await httpsGet(
        `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?leaderMark=${encodeURIComponent(leaderMark)}`
      )
      if (status === 429) { await sleep(3000 * (attempt + 1)); continue }
      if (status !== 200 || body.startsWith('<')) return null
      const json = JSON.parse(body)
      if (json.retCode !== 0) return null
      return json.result
    } catch (e) {
      if (attempt < 2) await sleep(800)
    }
  }
  return null
}

// ── fetch with leaderUserId (for numeric ID traders) ─────────────────────────

async function fetchByUserId(userId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { status, body } = await httpsGet(
        `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?leaderUserId=${encodeURIComponent(userId)}`
      )
      if (status === 429) { await sleep(3000 * (attempt + 1)); continue }
      if (status !== 200 || body.startsWith('<')) return null
      const json = JSON.parse(body)
      if (json.retCode !== 0) return null
      return json.result
    } catch (e) {
      if (attempt < 2) await sleep(800)
    }
  }
  return null
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function updateMDD(rowId, mdd) {
  const { error } = await sb.from('leaderboard_ranks')
    .update({ max_drawdown: mdd })
    .eq('id', rowId)
  if (error) throw new Error(error.message)
}

// ── Phase 1: Numeric IDs via leaderUserId ─────────────────────────────────────

async function phase1(numericRows, byTrader) {
  console.log('\n=== Phase 1: Numeric leaderUserId rows ===')
  console.log(`Traders: ${numericRows.length}`)
  let updated = 0, noData = 0, apiErr = 0, zeroMDD = 0

  for (let i = 0; i < numericRows.length; i++) {
    const traderId = numericRows[i]
    const rows = byTrader.get(traderId) || []

    const result = await fetchByUserId(traderId)
    if (!result) {
      apiErr++
      console.log(`  ✗ apiErr for userId=${traderId}`)
      await sleep(600)
      continue
    }

    let anyUpdate = false
    for (const row of rows) {
      const mdd = extractMDD(result, row.season_id)
      if (mdd === null) {
        noData++
        continue
      }
      if (mdd === 0) zeroMDD++
      try {
        await updateMDD(row.id, mdd)
        updated++
        anyUpdate = true
        console.log(`  ✓ id=${row.id} userId=${traderId} season=${row.season_id} mdd=${mdd}`)
      } catch (e) {
        console.log(`  ⚠ update failed id=${row.id}: ${e.message}`)
      }
    }

    await sleep(300)

    if ((i + 1) % 10 === 0) {
      console.log(`  [${i + 1}/${numericRows.length}] updated=${updated} noData=${noData} apiErr=${apiErr}`)
    }
  }

  console.log(`Phase 1 done: updated=${updated} noData=${noData} apiErr=${apiErr} zeroMDD=${zeroMDD}`)
  return { updated, noData, apiErr }
}

// ── Phase 2: Username IDs via browser listing scan ───────────────────────────

async function scanListing(page, needNicknames, needUserIds) {
  const nickToMark = new Map()    // nick → leaderMark
  const nickToUid = new Map()     // nick → leaderUserId (fallback for API call)
  const userIdToMark = new Map()

  const LIST_URL = 'https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list'
  const DURATIONS = ['DATA_DURATION_NINETY_DAY', 'DATA_DURATION_THIRTY_DAY', 'DATA_DURATION_SEVEN_DAY']
  const SORT_FIELDS = ['LEADER_SORT_FIELD_SORT_ROI', 'LEADER_SORT_FIELD_FOLLOWER_COUNT']
  const MAX_PAGES = 60

  async function navFetch(url) {
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
      if (resp?.status() !== 200) return null
      const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '')
      if (!text || text.startsWith('<') || text.length < 10) return null
      return JSON.parse(text)
    } catch { return null }
  }

  for (const duration of DURATIONS) {
    for (const sortField of SORT_FIELDS) {
      const foundAll = nickToMark.size >= needNicknames.size && userIdToMark.size >= needUserIds.size
      if (foundAll) break

      console.log(`  Scanning ${duration} / ${sortField}...`)

      for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
        const result = await navFetch(
          `${LIST_URL}?pageNo=${pageNo}&pageSize=50&dataDuration=${duration}&sortField=${sortField}`
        )

        if (!result || result.retCode !== 0) {
          if (pageNo > 1) console.log(`    Stopped at page ${pageNo} (error)`)
          break
        }

        const items = result.result?.leaderDetails || []
        if (!items.length) break

        for (const item of items) {
          const nick = item.nickName || ''
          const mark = item.leaderMark
          const uid = String(item.leaderUserId || '')

          if (!mark) continue

          // Match by nickName (for username-format source_trader_ids)
          if (nick && needNicknames.has(nick) && !nickToMark.has(nick)) {
            nickToMark.set(nick, mark)
            if (uid) nickToUid.set(nick, uid)
          }

          // Normalize: lowercase, replace spaces → underscore
          const normNick = nick.toLowerCase().replace(/\s+/g, '_')
          for (const n of needNicknames) {
            if (!nickToMark.has(n) && n.toLowerCase() === normNick) {
              nickToMark.set(n, mark)
              if (uid) nickToUid.set(n, uid)
            }
          }

          // Match by leaderUserId (for numeric source_trader_ids)
          if (uid && needUserIds.has(uid) && !userIdToMark.has(uid)) {
            userIdToMark.set(uid, mark)
          }
        }

        await sleep(200)
      }

      console.log(`    nickMap=${nickToMark.size}/${needNicknames.size} uidMap=${userIdToMark.size}/${needUserIds.size}`)
    }
  }

  return { nickToMark, nickToUid, userIdToMark }
}

async function phase2(usernameRows, byTrader) {
  console.log('\n=== Phase 2: Username IDs via browser listing ===')
  console.log(`Username-format traders: ${usernameRows.length}`)

  const needNicknames = new Set(usernameRows)
  // Also track numeric IDs that weren't updated in phase 1 (retry via mark)
  const needUserIds = new Set() // placeholder - phase 1 handles numerics directly

  // Launch browser
  console.log('Launching browser...')
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  })
  const page = await browser.newPage()
  await page.setUserAgent(UA)

  // Get session cookies
  console.log('Visiting bybit.com...')
  try {
    await page.goto('https://www.bybit.com/copyTrade/', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(4000)
  } catch (e) {
    console.log('Warning:', e.message?.substring(0, 80))
  }

  const { nickToMark, nickToUid } = await scanListing(page, needNicknames, needUserIds)
  await browser.close()

  const resolved = nickToMark.size
  const notFound = [...needNicknames].filter(n => !nickToMark.has(n))
  console.log(`\nResolved ${resolved}/${usernameRows.length} nicknames`)
  if (notFound.length) console.log(`NOT found: ${notFound.join(', ')}`)

  if (!nickToMark.size) {
    console.log('No nicknames resolved. Skipping update.')
    return { updated: 0, noData: 0, apiErr: 0, notResolved: notFound.length }
  }

  // Fetch leader-income and update DB
  console.log('\n📝 Fetching per-trader data...')
  let updated = 0, noData = 0, apiErr = 0, zeroMDD = 0

  // Add a brief pause after the intensive listing scan before API calls
  await sleep(2000)

  for (const [nick, mark] of nickToMark.entries()) {
    const rows = byTrader.get(nick) || []

    // Prefer leaderUserId path (more reliable after intensive scan); fallback to leaderMark
    const uid = nickToUid.get(nick)
    let result = null
    if (uid) {
      result = await fetchByUserId(uid)
      if (!result) result = await fetchByMark(mark)  // fallback
    } else {
      result = await fetchByMark(mark)
    }

    if (!result) {
      apiErr++
      console.log(`  ✗ apiErr for ${nick} (uid=${uid || 'n/a'} mark=${mark.substring(0, 12)}...)`)
      await sleep(500)
      continue
    }

    for (const row of rows) {
      const mdd = extractMDD(result, row.season_id)
      if (mdd === null) {
        noData++
        continue
      }
      if (mdd === 0) zeroMDD++
      try {
        await updateMDD(row.id, mdd)
        updated++
        console.log(`  ✓ ${nick} season=${row.season_id} mdd=${mdd}`)
      } catch (e) {
        console.log(`  ⚠ update failed id=${row.id}: ${e.message}`)
      }
    }
    await sleep(250)
  }

  console.log(`Phase 2 done: updated=${updated} noData=${noData} apiErr=${apiErr} zeroMDD=${zeroMDD} notResolved=${notFound.length}`)
  return { updated, noData, apiErr, notResolved: notFound.length }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Fix bybit max_drawdown v2 ===')

  // Load all null MDD rows
  let allRows = [], from = 0
  while (true) {
    const { data, error } = await sb.from('leaderboard_ranks')
      .select('id, source_trader_id, season_id')
      .eq('source', 'bybit')
      .is('max_drawdown', null)
      .range(from, from + 999)
    if (error) { console.error('DB error:', error.message); break }
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    from += 1000
  }

  console.log(`Total bybit null-MDD rows: ${allRows.length}`)
  if (!allRows.length) { console.log('Nothing to do!'); return }

  // Group by trader
  const byTrader = new Map()
  for (const r of allRows) {
    if (!byTrader.has(r.source_trader_id)) byTrader.set(r.source_trader_id, [])
    byTrader.get(r.source_trader_id).push(r)
  }
  const allTraders = [...byTrader.keys()]
  const numericTraders = allTraders.filter(isNumericId)
  const usernameTraders = allTraders.filter(t => !isNumericId(t))

  console.log(`Numeric ID traders: ${numericTraders.length}`)
  console.log(`Username traders: ${usernameTraders.length}`)

  // Phase 1: numeric IDs
  const p1 = await phase1(numericTraders, byTrader)

  // Phase 2: username IDs (need browser)
  const p2 = await phase2(usernameTraders, byTrader)

  // Final verification
  const { count } = await sb.from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'bybit')
    .is('max_drawdown', null)

  console.log('\n=== Summary ===')
  console.log(`Phase 1 (numeric IDs): updated=${p1.updated} noData=${p1.noData} apiErr=${p1.apiErr}`)
  console.log(`Phase 2 (usernames): updated=${p2.updated} noData=${p2.noData} apiErr=${p2.apiErr} notResolved=${p2.notResolved}`)
  console.log(`Total updated: ${p1.updated + p2.updated}`)
  console.log(`\nRemaining bybit null MDD rows: ${count}`)
}

main().catch(e => { console.error(e); process.exit(1) })
