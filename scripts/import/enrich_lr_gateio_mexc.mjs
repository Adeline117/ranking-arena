#!/usr/bin/env node
/**
 * Enrich leaderboard_ranks WR/MDD for Gate.io and MEXC
 * 
 * Gate.io: Uses Playwright to bypass Akamai, fetches from:
 *   - /apiw/v2/copy/leader/list (futures traders with WR/MDD)
 *   - /apiw/v2/copy/leader/query_cta_trader (CTA traders - may lack WR/MDD)
 * MEXC: Uses Puppeteer to establish session, then paginated API
 * 
 * Usage:
 *   node scripts/import/enrich_lr_gateio_mexc.mjs
 *   node scripts/import/enrich_lr_gateio_mexc.mjs --source=gateio
 *   node scripts/import/enrich_lr_gateio_mexc.mjs --source=mexc
 */
import pg from 'pg'
import { chromium } from 'playwright'
import puppeteer from 'puppeteer'

const DB_URL = 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const SOURCE_FILTER = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || null

// ═══════════════════════════════════════════
// Gate.io
// ═══════════════════════════════════════════
async function enrichGateio(pool) {
  console.log('\n' + '═'.repeat(50))
  console.log('🔄 Gate.io — leaderboard_ranks enrichment')
  console.log('═'.repeat(50))

  // Get missing rows
  const { rows: missing } = await pool.query(
    `SELECT id, source_trader_id, season_id FROM leaderboard_ranks 
     WHERE source='gateio' AND win_rate IS NULL`
  )
  if (!missing.length) { console.log('  ✅ Nothing to enrich'); return }
  console.log(`  📊 ${missing.length} rows need enrichment`)

  // Separate CTA vs numeric (futures) traders
  const ctaRows = missing.filter(r => r.source_trader_id.startsWith('cta_'))
  const numericRows = missing.filter(r => /^\d+$/.test(r.source_trader_id))
  console.log(`  CTA: ${ctaRows.length}, Numeric: ${numericRows.length}, Other: ${missing.length - ctaRows.length - numericRows.length}`)

  // Build lookup: source_trader_id -> rows
  const ctaByNick = new Map() // normalized nickname -> [{id, source_trader_id, season_id}]
  for (const r of ctaRows) {
    // cta_xxx -> extract the normalized nickname
    const nick = r.source_trader_id.replace('cta_', '')
    if (!ctaByNick.has(nick)) ctaByNick.set(nick, [])
    ctaByNick.get(nick).push(r)
  }

  const numericById = new Map()
  for (const r of numericRows) {
    if (!numericById.has(r.source_trader_id)) numericById.set(r.source_trader_id, [])
    numericById.get(r.source_trader_id).push(r)
  }

  // Launch Playwright
  let browser
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  } catch (e) {
    console.error('  ❌ Failed to launch browser:', e.message)
    return
  }

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()

  try {
    console.log('  🌐 Loading Gate.io copytrading page...')
    await page.goto('https://www.gate.io/copytrading', {
      waitUntil: 'domcontentloaded', timeout: 60000
    }).catch(e => console.log('  ⚠ Nav:', e.message))
    await sleep(8000)
    console.log('  Page title:', await page.title().catch(() => '?'))

    // ── Futures leaders (numeric IDs) ──
    const CYCLE_MAP = { '7D': 'week', '30D': 'month', '90D': 'quarter' }
    const futuresData = new Map() // traderId -> { season -> {wr, mdd} }

    for (const [season, cycle] of Object.entries(CYCLE_MAP)) {
      console.log(`\n  --- Futures ${season} (cycle=${cycle}) ---`)
      for (const orderBy of ['profit_rate', 'profit', 'aum', 'sharp_ratio', 'max_drawdown']) {
        for (let pg = 1; pg <= 10; pg++) {
          const result = await page.evaluate(async ({pg, cycle, orderBy}) => {
            try {
              const r = await fetch(`/apiw/v2/copy/leader/list?page=${pg}&page_size=100&status=running&order_by=${orderBy}&sort_by=desc&cycle=${cycle}`)
              const j = await r.json()
              return j?.data?.list || []
            } catch { return [] }
          }, {pg, cycle, orderBy})
          
          if (!result.length) break
          for (const t of result) {
            const id = String(t.leader_id)
            if (!futuresData.has(id)) futuresData.set(id, {})
            const wr = parseFloat(t.win_rate || 0) * 100
            const mdd = parseFloat(t.max_drawdown || 0) * 100
            if (wr > 0 || mdd > 0) {
              futuresData.get(id)[season] = { wr, mdd }
            }
          }
          await sleep(300)
        }
      }
      console.log(`  Futures data: ${futuresData.size} traders collected`)
    }

    // ── CTA traders ──
    // CTA list API doesn't return WR/MDD. Try individual detail pages.
    // First, let's see if there's a detail API for CTA traders
    console.log('\n  --- CTA Traders ---')
    const ctaData = new Map() // normalized nick -> {wr, mdd}

    // Fetch CTA list to get any available data
    const ctaList = await page.evaluate(async () => {
      const traders = []
      const seen = new Set()
      for (const sortField of ['NINETY_PROFIT_RATE_SORT', 'THIRTY_PROFIT_RATE_SORT', 'SEVEN_PROFIT_RATE_SORT', 'COPY_USER_COUNT_SORT']) {
        for (let pg = 1; pg <= 15; pg++) {
          try {
            const r = await fetch(`/apiw/v2/copy/leader/query_cta_trader?page_num=${pg}&page_size=100&sort_field=${sortField}`)
            const j = await r.json()
            const list = j?.data?.list || []
            if (list.length === 0) break
            for (const t of list) {
              const nick = t.nickname || t.nick || ''
              const normNick = nick.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20)
              if (!normNick || seen.has(normNick)) continue
              seen.add(normNick)
              traders.push({
                normNick,
                nickname: nick,
                winRate: t.win_rate != null ? parseFloat(t.win_rate) : null,
                maxDrawdown: t.max_drawdown != null ? parseFloat(t.max_drawdown) : null,
                // Try all possible field names
                winRateStr: t.win_rate_str || null,
                totalWinRate: t.total_win_rate || null,
                ninetyWinRate: t.ninety_win_rate || null,
                // Raw keys for debugging
                keys: Object.keys(t).filter(k => k.includes('win') || k.includes('draw') || k.includes('mdd')),
              })
            }
          } catch { break }
        }
      }
      return traders
    })

    console.log(`  CTA list: ${ctaList.length} traders`)
    if (ctaList.length > 0) {
      // Log sample to see what fields are available
      console.log('  Sample CTA trader:', JSON.stringify(ctaList[0]))
    }

    let ctaWithWr = 0
    for (const t of ctaList) {
      let wr = null, mdd = null
      if (t.winRate != null && t.winRate > 0) wr = t.winRate <= 1 ? t.winRate * 100 : t.winRate
      if (t.totalWinRate != null) wr = parseFloat(t.totalWinRate) <= 1 ? parseFloat(t.totalWinRate) * 100 : parseFloat(t.totalWinRate)
      if (t.ninetyWinRate != null) wr = parseFloat(t.ninetyWinRate) <= 1 ? parseFloat(t.ninetyWinRate) * 100 : parseFloat(t.ninetyWinRate)
      if (t.maxDrawdown != null && t.maxDrawdown > 0) mdd = t.maxDrawdown <= 1 ? t.maxDrawdown * 100 : t.maxDrawdown

      if (wr != null || mdd != null) {
        ctaData.set(t.normNick, { wr, mdd })
        ctaWithWr++
      }
    }
    console.log(`  CTA with WR/MDD data: ${ctaWithWr}`)

    // If CTA list didn't provide WR/MDD, try fetching individual CTA trader details
    if (ctaWithWr === 0 && ctaByNick.size > 0) {
      console.log('  CTA list has no WR/MDD. Trying individual detail API...')
      // Try to find detail API endpoint
      const sampleNick = ctaList[0]?.nickname || ''
      if (sampleNick) {
        const detailResult = await page.evaluate(async (nick) => {
          const endpoints = [
            `/apiw/v2/copy/leader/cta_trader_detail?nickname=${encodeURIComponent(nick)}`,
            `/apiw/v2/copy/leader/query_cta_trader_detail?nickname=${encodeURIComponent(nick)}`,
            `/apiw/v2/copy/cta/trader/detail?nickname=${encodeURIComponent(nick)}`,
          ]
          const results = {}
          for (const ep of endpoints) {
            try {
              const r = await fetch(ep)
              const text = await r.text()
              results[ep] = text.slice(0, 500)
            } catch (e) {
              results[ep] = 'error: ' + e.message
            }
          }
          return results
        }, sampleNick)
        console.log('  Detail API probe:', JSON.stringify(detailResult, null, 2))
      }
    }

    // ── Update DB ──
    let updated = 0, skipped = 0

    // Update numeric (futures) traders
    for (const [traderId, seasons] of futuresData) {
      const rows = numericById.get(traderId)
      if (!rows) continue
      for (const row of rows) {
        const d = seasons[row.season_id]
        if (!d) continue
        const updates = []
        const vals = []
        let idx = 1
        if (d.wr != null && d.wr > 0) { updates.push(`win_rate=$${idx++}`); vals.push(d.wr) }
        if (d.mdd != null && d.mdd > 0) { updates.push(`max_drawdown=$${idx++}`); vals.push(d.mdd) }
        if (!updates.length) { skipped++; continue }
        vals.push(row.id)
        await pool.query(`UPDATE leaderboard_ranks SET ${updates.join(', ')} WHERE id=$${idx}`, vals)
        updated++
      }
    }
    console.log(`\n  Futures updated: ${updated}`)

    // Update CTA traders
    let ctaUpdated = 0
    for (const [normNick, d] of ctaData) {
      const rows = ctaByNick.get(normNick)
      if (!rows) continue
      for (const row of rows) {
        const updates = []
        const vals = []
        let idx = 1
        if (d.wr != null) { updates.push(`win_rate=$${idx++}`); vals.push(d.wr) }
        if (d.mdd != null) { updates.push(`max_drawdown=$${idx++}`); vals.push(d.mdd) }
        if (!updates.length) continue
        vals.push(row.id)
        await pool.query(`UPDATE leaderboard_ranks SET ${updates.join(', ')} WHERE id=$${idx}`, vals)
        ctaUpdated++
      }
    }
    console.log(`  CTA updated: ${ctaUpdated}`)
    console.log(`  ✅ Gate.io total: ${updated + ctaUpdated} updated, ${skipped} skipped`)

  } finally {
    await browser.close()
  }
}

// ═══════════════════════════════════════════
// MEXC
// ═══════════════════════════════════════════
async function enrichMexc(pool) {
  console.log('\n' + '═'.repeat(50))
  console.log('🔄 MEXC — leaderboard_ranks enrichment')
  console.log('═'.repeat(50))

  // Get missing rows
  const { rows: missing } = await pool.query(
    `SELECT id, source_trader_id, season_id FROM leaderboard_ranks 
     WHERE source='mexc' AND win_rate IS NULL`
  )
  if (!missing.length) { console.log('  ✅ Nothing to enrich'); return }
  console.log(`  📊 ${missing.length} rows need enrichment`)

  // Build lookup by normalized nickname
  const byNick = new Map() // lowercase nickname -> [{id, source_trader_id, season_id}]
  for (const r of missing) {
    const key = r.source_trader_id.toLowerCase().trim()
    if (!byNick.has(key)) byNick.set(key, [])
    byNick.get(key).push(r)
  }
  console.log(`  Unique nicknames: ${byNick.size}`)

  // Launch Puppeteer
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

  console.log('  🌐 Loading MEXC page...')
  await page.goto('https://www.mexc.com/futures/copyTrade/home', {
    waitUntil: 'networkidle2', timeout: 60000
  }).catch(() => {})
  await sleep(5000)
  console.log('  Page loaded')

  // Collect trader data from paginated API
  const apiTraders = new Map() // lowercase nickname -> {winRate, maxDrawdown}

  const orderBys = ['COMPREHENSIVE', 'FOLLOWERS', 'ROI', 'WINRATE', 'PNL']
  for (const orderBy of orderBys) {
    let pageNum = 1
    let staleCount = 0

    console.log(`\n  📡 orderBy=${orderBy}...`)
    while (pageNum <= 100) {
      const result = await page.evaluate(async (pg, lim, ob) => {
        try {
          const url = `https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/v2?condition=%5B%5D&limit=${lim}&orderBy=${ob}&page=${pg}`
          const resp = await fetch(url)
          const data = await resp.json()
          const list = data?.data?.content || []
          return {
            items: list.map(i => ({
              nickname: (i.nickname || i.nickName || '').trim(),
              winRate: i.winRate,
              maxDrawdown: i.maxDrawdown7 ?? i.maxDrawdown ?? null,
              uid: i.uid
            })),
            totalPages: data?.data?.totalPages,
          }
        } catch (e) { return { items: [], error: e.message } }
      }, pageNum, 30, orderBy)

      if (result.error || !result.items.length) break

      const prevSize = apiTraders.size
      for (const t of result.items) {
        if (!t.nickname) continue
        const key = t.nickname.toLowerCase().trim()
        if (!apiTraders.has(key)) {
          apiTraders.set(key, {
            winRate: t.winRate != null ? (Math.abs(t.winRate) <= 1 ? t.winRate * 100 : t.winRate) : null,
            maxDrawdown: t.maxDrawdown,
          })
        }
      }

      if (pageNum % 20 === 0) console.log(`    Page ${pageNum}: unique=${apiTraders.size}`)
      if (apiTraders.size === prevSize) { staleCount++; if (staleCount >= 3) break } else staleCount = 0

      pageNum++
      if (result.totalPages && pageNum > result.totalPages) break
      await sleep(500)
    }
  }

  await browser.close()
  console.log(`\n  📊 Total API traders: ${apiTraders.size}`)

  // Match and update
  let matched = 0, updated = 0
  for (const [key, rows] of byNick) {
    const d = apiTraders.get(key)
    if (!d || d.winRate == null) continue
    matched++
    for (const row of rows) {
      const updates = []
      const vals = []
      let idx = 1
      if (d.winRate != null) { updates.push(`win_rate=$${idx++}`); vals.push(d.winRate) }
      if (d.maxDrawdown != null) { updates.push(`max_drawdown=$${idx++}`); vals.push(Math.abs(d.maxDrawdown)) }
      if (!updates.length) continue
      vals.push(row.id)
      try {
        await pool.query(`UPDATE leaderboard_ranks SET ${updates.join(', ')} WHERE id=$${idx}`, vals)
        updated++
      } catch (e) {
        console.error(`  ❌ ${row.source_trader_id}: ${e.message}`)
      }
    }
  }

  console.log(`  🔗 Matched nicknames: ${matched}/${byNick.size}`)
  console.log(`  ✅ MEXC: ${updated} rows updated`)
}

// ═══════════════════════════════════════════
// Main
// ═══════════════════════════════════════════
async function main() {
  console.log('🚀 Enriching leaderboard_ranks — Gate.io + MEXC')
  console.log(`   Time: ${new Date().toISOString()}`)
  console.log(`   Filter: ${SOURCE_FILTER || 'all'}`)

  const pool = new pg.Pool({ connectionString: DB_URL })

  // Before counts
  const { rows: [gb] } = await pool.query(`SELECT COUNT(*) as total, COUNT(win_rate) as has_wr FROM leaderboard_ranks WHERE source='gateio'`)
  const { rows: [mb] } = await pool.query(`SELECT COUNT(*) as total, COUNT(win_rate) as has_wr FROM leaderboard_ranks WHERE source='mexc'`)
  console.log(`\n  Gate.io: ${gb.has_wr}/${gb.total} have WR`)
  console.log(`  MEXC:    ${mb.has_wr}/${mb.total} have WR`)

  try {
    if (!SOURCE_FILTER || SOURCE_FILTER === 'gateio') await enrichGateio(pool)
    if (!SOURCE_FILTER || SOURCE_FILTER === 'mexc') await enrichMexc(pool)
  } catch (e) {
    console.error('❌ Error:', e)
  }

  // After counts
  const { rows: [ga] } = await pool.query(`SELECT COUNT(*) as total, COUNT(win_rate) as has_wr FROM leaderboard_ranks WHERE source='gateio'`)
  const { rows: [ma] } = await pool.query(`SELECT COUNT(*) as total, COUNT(win_rate) as has_wr FROM leaderboard_ranks WHERE source='mexc'`)
  console.log(`\n${'═'.repeat(50)}`)
  console.log(`FINAL:`)
  console.log(`  Gate.io: ${gb.has_wr} → ${ga.has_wr} / ${ga.total} have WR (+${ga.has_wr - gb.has_wr})`)
  console.log(`  MEXC:    ${mb.has_wr} → ${ma.has_wr} / ${ma.total} have WR (+${ma.has_wr - mb.has_wr})`)
  console.log('✨ Done!')

  await pool.end()
}

main().catch(e => { console.error('❌ Fatal:', e); process.exit(1) })
