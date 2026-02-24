#!/usr/bin/env node
/**
 * MEXC Local Enrichment - Fetch win_rate via Puppeteer + MEXC copy trading API
 * 
 * Strategy:
 * 1. Launch Puppeteer, load MEXC page to get CF cookies
 * 2. Paginate v1/traders/v2 API (all orderBy variants) to collect traders
 * 3. For unmatched traders, try individual profile API by searching nickname
 * 4. Update DB with ONLY real API data (no estimation)
 * 
 * Usage: node --env-file=.env.local scripts/import/enrich_mexc_local.mjs
 */
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { createClient } from '@supabase/supabase-js'

puppeteer.use(StealthPlugin())

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const SOURCE = 'mexc'
const SEASON = '90D'

async function main() {
  console.log('='.repeat(60))
  console.log('MEXC Local Enrichment — real API data only')
  console.log('='.repeat(60))

  // 1. Get all mexc traders missing win_rate
  const { data: missing, error } = await supabase
    .from('trader_snapshots')
    .select('id, source_trader_id, roi, pnl, win_rate, max_drawdown, trades_count')
    .eq('source', SOURCE)
    .eq('season_id', SEASON)
    .is('win_rate', null)

  if (error) { console.error('DB error:', error); process.exit(1) }
  console.log(`\n📊 Missing win_rate: ${missing.length} traders`)
  if (missing.length === 0) { console.log('Nothing to do!'); return }

  // Build lookup by nickname (lowercase)
  const missingMap = new Map()
  for (const r of missing) {
    missingMap.set(r.source_trader_id.toLowerCase().trim(), r)
  }

  // 2. Launch Puppeteer
  console.log('\n🚀 Launching browser...')
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')

  console.log('🌐 Loading MEXC copy trading page...')
  try {
    await page.goto('https://www.mexc.com/futures/copyTrade/home', { waitUntil: 'networkidle2', timeout: 60000 })
  } catch {
    console.log('  ⚠ Timeout, continuing...')
  }
  await sleep(5000)

  // 3. Paginate the traders API from browser context
  const apiTraders = new Map() // nickname_lower -> { winRate, maxDrawdown, openTimes, uid }
  const orderBys = ['COMPREHENSIVE', 'FOLLOWERS', 'ROI', 'PNL', 'WINRATE']

  for (const orderBy of orderBys) {
    let pageNum = 1
    let staleCount = 0

    console.log(`\n📡 Fetching orderBy=${orderBy}...`)

    while (pageNum <= 100) {
      const result = await page.evaluate(async (pg, ob) => {
        try {
          const url = `https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/v2?condition=%5B%5D&limit=30&orderBy=${ob}&page=${pg}`
          const resp = await fetch(url)
          if (!resp.ok) return { error: resp.status }
          const data = await resp.json()
          const list = data?.data?.content || []
          return {
            items: list.map(i => ({
              nickname: i.nickname || i.nickName || '',
              winRate: i.winRate,
              maxDrawdown7: i.maxDrawdown7 ?? i.maxDrawdown ?? null,
              openTimes: i.openTimes ?? null,
              uid: i.uid,
              pnl: i.pnl ?? null,
            })),
            totalPages: data?.data?.totalPages || 0,
            totalElements: data?.data?.totalElements || 0,
          }
        } catch (e) {
          return { error: e.message }
        }
      }, pageNum, orderBy)

      if (result.error) {
        console.log(`  ❌ Page ${pageNum}: error ${result.error}`)
        break
      }
      if (result.items.length === 0) break

      if (pageNum === 1) {
        console.log(`  Total: ${result.totalElements} traders, ${result.totalPages} pages`)
      }

      const prevSize = apiTraders.size
      for (const t of result.items) {
        if (!t.nickname) continue
        const key = t.nickname.toLowerCase().trim()
        if (!apiTraders.has(key)) {
          apiTraders.set(key, {
            nickname: t.nickname,
            winRate: t.winRate,
            maxDrawdown7: t.maxDrawdown7,
            openTimes: t.openTimes,
            uid: t.uid,
            pnl: t.pnl,
          })
        }
      }

      if (apiTraders.size === prevSize) {
        staleCount++
        if (staleCount >= 5) break
      } else {
        staleCount = 0
      }

      // Don't trust totalPages=0, keep going until empty
      pageNum++
      await sleep(300)
    }
    console.log(`  Cumulative unique: ${apiTraders.size}`)
  }

  console.log(`\n📊 Total API traders: ${apiTraders.size}`)

  // 4. Try individual trader search for unmatched
  const unmatched = []
  for (const [key, record] of missingMap) {
    if (!apiTraders.has(key)) {
      unmatched.push(record)
    }
  }
  console.log(`🔍 Unmatched after paginate: ${unmatched.length}`)

  // Try searching by nickname via search API with different params
  if (unmatched.length > 0) {
    console.log(`\n🔎 Searching individual traders (${unmatched.length})...`)
    let searchFound = 0
    for (let i = 0; i < unmatched.length; i++) {
      const nick = unmatched[i].source_trader_id
      // Try keyword search
      const result = await page.evaluate(async (nickname) => {
        // Try search endpoint
        const urls = [
          `https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/v2?condition=%5B%5D&limit=10&orderBy=COMPREHENSIVE&page=1&nickName=${encodeURIComponent(nickname)}`,
          `https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/v2?condition=%5B%5D&limit=10&orderBy=COMPREHENSIVE&page=1&keyword=${encodeURIComponent(nickname)}`,
          `https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/search?keyword=${encodeURIComponent(nickname)}`,
        ]
        for (const url of urls) {
          try {
            const resp = await fetch(url)
            if (!resp.ok) continue
            const data = await resp.json()
            const list = data?.data?.content || data?.data || []
            if (!Array.isArray(list)) continue
            for (const t of list) {
              const n = (t.nickname || t.nickName || '').toLowerCase().trim()
              if (n === nickname.toLowerCase().trim()) {
                return {
                  winRate: t.winRate,
                  maxDrawdown7: t.maxDrawdown7 ?? t.maxDrawdown ?? null,
                  openTimes: t.openTimes ?? null,
                  uid: t.uid,
                  pnl: t.pnl ?? null,
                }
              }
            }
          } catch {}
        }
        return null
      }, nick)

      if (result && result.winRate != null) {
        apiTraders.set(nick.toLowerCase().trim(), { nickname: nick, ...result })
        searchFound++
      }

      if ((i + 1) % 50 === 0) {
        console.log(`  Searched ${i + 1}/${unmatched.length}, found: ${searchFound}`)
      }
      await sleep(400)
    }
    console.log(`  Search found: ${searchFound}`)
  }

  await browser.close()
  console.log('\n🌐 Browser closed')

  // 5. Update DB
  console.log('\n💾 Updating database...')
  let updated = 0
  let skipped = 0

  for (const record of missing) {
    const key = record.source_trader_id.toLowerCase().trim()
    const apiData = apiTraders.get(key)
    if (!apiData || apiData.winRate == null) {
      skipped++
      continue
    }

    const updates = {}

    // WinRate: API returns decimal 0-1, DB stores percentage
    const wr = apiData.winRate <= 1 ? apiData.winRate * 100 : apiData.winRate
    updates.win_rate = parseFloat(wr.toFixed(2))

    // MDD
    if ((record.max_drawdown == null || record.max_drawdown === 0) && apiData.maxDrawdown7 != null) {
      const mdd = apiData.maxDrawdown7 <= 1 ? apiData.maxDrawdown7 * 100 : apiData.maxDrawdown7
      updates.max_drawdown = parseFloat(mdd.toFixed(2))
    }

    // Trades count
    if (record.trades_count == null && apiData.openTimes != null) {
      updates.trades_count = apiData.openTimes
    }

    const { error: updateErr } = await supabase
      .from('trader_snapshots')
      .update(updates)
      .eq('id', record.id)

    if (updateErr) {
      console.error(`  ❌ ${record.source_trader_id}: ${updateErr.message}`)
    } else {
      updated++
    }
  }

  console.log(`\n✅ Updated: ${updated}, Skipped (no API data): ${skipped}`)

  // 6. Verify
  const { count: stillNull } = await supabase
    .from('trader_snapshots')
    .select('*', { count: 'exact', head: true })
    .eq('source', SOURCE)
    .eq('season_id', SEASON)
    .is('win_rate', null)

  const { count: total } = await supabase
    .from('trader_snapshots')
    .select('*', { count: 'exact', head: true })
    .eq('source', SOURCE)
    .eq('season_id', SEASON)

  console.log(`\n📊 Final: ${total - stillNull}/${total} have win_rate (${stillNull} still null)`)
  console.log('='.repeat(60))
}

main().catch(e => { console.error(e); process.exit(1) })
