#!/usr/bin/env node
/**
 * Enrich leaderboard_ranks WR/MDD for Gate.io and MEXC
 * 
 * Gate.io: Only futures (numeric ID) traders have WR/MDD in the list API.
 *   CTA traders (cta_ prefix) do NOT expose WR/MDD - skipped.
 *   Only cycle=month returns data (used for all seasons).
 * MEXC: Paginated trader list via browser session.
 */
import pg from 'pg'
import { chromium } from 'playwright'
import puppeteer from 'puppeteer'

const DB_URL = 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const SOURCE_FILTER = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || null

async function enrichGateio(pool) {
  console.log('\n' + '═'.repeat(50))
  console.log('🔄 Gate.io — leaderboard_ranks enrichment')
  console.log('═'.repeat(50))

  // Only numeric IDs have WR/MDD. CTA traders don't expose it.
  const { rows: missing } = await pool.query(
    `SELECT id, source_trader_id, season_id FROM leaderboard_ranks 
     WHERE source='gateio' AND win_rate IS NULL AND source_trader_id ~ '^[0-9]+$'`
  )
  const { rows: [{count: ctaCount}] } = await pool.query(
    `SELECT COUNT(*) FROM leaderboard_ranks 
     WHERE source='gateio' AND win_rate IS NULL AND source_trader_id LIKE 'cta_%'`
  )
  console.log(`  Numeric (enrichable): ${missing.length}`)
  console.log(`  CTA (no WR/MDD in API): ${ctaCount} — skipping`)

  if (!missing.length) { console.log('  ✅ Nothing to enrich'); return }

  const byId = new Map()
  for (const r of missing) {
    if (!byId.has(r.source_trader_id)) byId.set(r.source_trader_id, [])
    byId.get(r.source_trader_id).push(r)
  }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await ctx.newPage()

  try {
    console.log('  🌐 Loading Gate.io...')
    await page.goto('https://www.gate.io/copytrading', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
    await sleep(8000)

    // Fetch futures list (only cycle=month works)
    const futuresData = new Map()
    for (const orderBy of ['profit_rate', 'profit', 'aum', 'sharp_ratio', 'max_drawdown']) {
      for (let p = 1; p <= 10; p++) {
        const list = await page.evaluate(async (opts) => {
          try {
            const r = await fetch(`/apiw/v2/copy/leader/list?page=${opts.p}&page_size=100&status=running&order_by=${opts.ob}&sort_by=desc&cycle=month`)
            const j = await r.json()
            return (j?.data?.list || []).map(t => ({
              id: String(t.leader_id),
              wr: parseFloat(t.win_rate || 0),
              mdd: parseFloat(t.max_drawdown || 0),
            }))
          } catch { return [] }
        }, { p, ob: orderBy })
        if (!list.length) break
        for (const t of list) {
          if (!futuresData.has(t.id) && (t.wr > 0 || t.mdd > 0)) {
            futuresData.set(t.id, { wr: t.wr * 100, mdd: t.mdd * 100 })
          }
        }
        await sleep(300)
      }
    }
    console.log(`  Collected ${futuresData.size} traders with WR/MDD`)

    // Update all seasons for matched traders
    let updated = 0
    for (const [traderId, d] of futuresData) {
      const rows = byId.get(traderId)
      if (!rows) continue
      for (const row of rows) {
        const sets = [], vals = []
        let i = 1
        if (d.wr > 0) { sets.push(`win_rate=$${i++}`); vals.push(d.wr) }
        if (d.mdd > 0) { sets.push(`max_drawdown=$${i++}`); vals.push(d.mdd) }
        if (!sets.length) continue
        vals.push(row.id)
        await pool.query(`UPDATE leaderboard_ranks SET ${sets.join(',')} WHERE id=$${i}`, vals)
        updated++
      }
    }
    console.log(`  ✅ Gate.io: ${updated} rows updated`)
  } finally {
    await browser.close()
  }
}

async function enrichMexc(pool) {
  console.log('\n' + '═'.repeat(50))
  console.log('🔄 MEXC — leaderboard_ranks enrichment')
  console.log('═'.repeat(50))

  const { rows: missing } = await pool.query(
    `SELECT id, source_trader_id, season_id FROM leaderboard_ranks 
     WHERE source='mexc' AND win_rate IS NULL`
  )
  if (!missing.length) { console.log('  ✅ Nothing to enrich'); return }
  console.log(`  📊 ${missing.length} rows need enrichment`)

  const byNick = new Map()
  for (const r of missing) {
    const key = r.source_trader_id.toLowerCase().trim()
    if (!byNick.has(key)) byNick.set(key, [])
    byNick.get(key).push(r)
  }
  console.log(`  Unique nicknames: ${byNick.size}`)

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

  console.log('  🌐 Loading MEXC page...')
  await page.goto('https://www.mexc.com/futures/copyTrade/home', {
    waitUntil: 'networkidle2', timeout: 60000
  }).catch(() => {})
  await sleep(5000)

  const apiTraders = new Map()
  for (const orderBy of ['COMPREHENSIVE', 'FOLLOWERS', 'ROI', 'WINRATE', 'PNL']) {
    let pageNum = 1, staleCount = 0
    console.log(`\n  📡 orderBy=${orderBy}...`)
    
    while (pageNum <= 100) {
      const result = await page.evaluate(async (pg, lim, ob) => {
        try {
          const r = await fetch(`https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/v2?condition=%5B%5D&limit=${lim}&orderBy=${ob}&page=${pg}`)
          const d = await r.json()
          return {
            items: (d?.data?.content || []).map(i => ({
              nickname: (i.nickname || i.nickName || '').trim(),
              winRate: i.winRate,
              maxDrawdown: i.maxDrawdown7 ?? i.maxDrawdown ?? null,
            })),
            totalPages: d?.data?.totalPages,
          }
        } catch (e) { return { items: [], error: e.message } }
      }, pageNum, 30, orderBy)

      if (result.error || !result.items.length) break

      const prev = apiTraders.size
      for (const t of result.items) {
        if (!t.nickname) continue
        const key = t.nickname.toLowerCase().trim()
        if (!apiTraders.has(key)) {
          apiTraders.set(key, {
            winRate: t.winRate != null ? (Math.abs(t.winRate) <= 1 ? t.winRate * 100 : t.winRate) : null,
            maxDrawdown: t.maxDrawdown != null ? Math.abs(t.maxDrawdown) : null,
          })
        }
      }

      if (pageNum % 20 === 0) console.log(`    Page ${pageNum}: unique=${apiTraders.size}`)
      if (apiTraders.size === prev) { staleCount++; if (staleCount >= 3) break } else staleCount = 0
      pageNum++
      if (result.totalPages && pageNum > result.totalPages) break
      await sleep(500)
    }
  }
  await browser.close()
  console.log(`\n  📊 Total API traders: ${apiTraders.size}`)

  let matched = 0, updated = 0
  for (const [key, rows] of byNick) {
    const d = apiTraders.get(key)
    if (!d || d.winRate == null) continue
    matched++
    for (const row of rows) {
      const sets = [], vals = []
      let i = 1
      if (d.winRate != null) { sets.push(`win_rate=$${i++}`); vals.push(d.winRate) }
      if (d.maxDrawdown != null) { sets.push(`max_drawdown=$${i++}`); vals.push(d.maxDrawdown) }
      if (!sets.length) continue
      vals.push(row.id)
      try {
        await pool.query(`UPDATE leaderboard_ranks SET ${sets.join(',')} WHERE id=$${i}`, vals)
        updated++
      } catch (e) { console.error(`  ❌ ${row.source_trader_id}: ${e.message}`) }
    }
  }
  console.log(`  🔗 Matched: ${matched}/${byNick.size}`)
  console.log(`  ✅ MEXC: ${updated} rows updated`)
}

async function main() {
  console.log('🚀 Enriching leaderboard_ranks — Gate.io + MEXC')
  console.log(`   Time: ${new Date().toISOString()}`)

  const pool = new pg.Pool({ connectionString: DB_URL })
  const { rows: [gb] } = await pool.query(`SELECT COUNT(*) as total, COUNT(win_rate) as has_wr FROM leaderboard_ranks WHERE source='gateio'`)
  const { rows: [mb] } = await pool.query(`SELECT COUNT(*) as total, COUNT(win_rate) as has_wr FROM leaderboard_ranks WHERE source='mexc'`)
  console.log(`  Gate.io: ${gb.has_wr}/${gb.total} have WR`)
  console.log(`  MEXC:    ${mb.has_wr}/${mb.total} have WR`)

  try {
    if (!SOURCE_FILTER || SOURCE_FILTER === 'gateio') await enrichGateio(pool)
    if (!SOURCE_FILTER || SOURCE_FILTER === 'mexc') await enrichMexc(pool)
  } catch (e) { console.error('❌ Error:', e) }

  const { rows: [ga] } = await pool.query(`SELECT COUNT(*) as total, COUNT(win_rate) as has_wr FROM leaderboard_ranks WHERE source='gateio'`)
  const { rows: [ma] } = await pool.query(`SELECT COUNT(*) as total, COUNT(win_rate) as has_wr FROM leaderboard_ranks WHERE source='mexc'`)
  console.log(`\n${'═'.repeat(50)}`)
  console.log(`FINAL:`)
  console.log(`  Gate.io: ${gb.has_wr} → ${ga.has_wr} / ${ga.total} (+${ga.has_wr - gb.has_wr})`)
  console.log(`  MEXC:    ${mb.has_wr} → ${ma.has_wr} / ${ma.total} (+${ma.has_wr - mb.has_wr})`)
  console.log('✨ Done!')
  await pool.end()
}

main().catch(e => { console.error('❌ Fatal:', e); process.exit(1) })
