#!/usr/bin/env node
/**
 * Bitget Enrichment — fills pnl, win_rate, trades_count, max_drawdown, aum
 * in trader_snapshots for both bitget_futures and bitget_spot.
 *
 * Uses Puppeteer + stealth to call Bitget internal API:
 *   POST /v1/trigger/trace/public/cycleData
 *
 * Usage: node scripts/import/enrich_bitget_all_snapshots.mjs [--source=bitget_futures|bitget_spot] [--limit=9999]
 */

import 'dotenv/config'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { createClient } from '@supabase/supabase-js'

puppeteer.use(StealthPlugin())

const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const args = process.argv.slice(2)
const sourceArg = args.find(a => a.startsWith('--source='))
const SOURCES = sourceArg ? [sourceArg.split('=')[1]] : ['bitget_futures', 'bitget_spot']
const limitArg = args.find(a => a.startsWith('--limit='))
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1]) : 9999

const SEASON_TO_CYCLE = { '7D': 7, '30D': 30, '90D': 90 }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function main() {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Bitget Snapshot Enrichment`)
  console.log(`Sources: ${SOURCES.join(', ')}, Limit: ${LIMIT}`)
  console.log(`${'='.repeat(60)}`)

  // ---- BEFORE snapshot ----
  const beforeStats = {}
  for (const source of SOURCES) {
    const { data: rows } = await sb.from('trader_snapshots')
      .select('season_id, pnl, win_rate, trades_count, max_drawdown, aum')
      .eq('source', source)
    const agg = { total: 0, no_pnl: 0, no_wr: 0, no_tc: 0, no_mdd: 0, no_aum: 0 }
    for (const r of (rows || [])) {
      agg.total++
      if (r.pnl == null) agg.no_pnl++
      if (r.win_rate == null) agg.no_wr++
      if (r.trades_count == null) agg.no_tc++
      if (r.max_drawdown == null) agg.no_mdd++
      if (r.aum == null) agg.no_aum++
    }
    beforeStats[source] = agg
    console.log(`BEFORE ${source}: total=${agg.total} no_pnl=${agg.no_pnl} no_wr=${agg.no_wr} no_tc=${agg.no_tc} no_mdd=${agg.no_mdd} no_aum=${agg.no_aum}`)
  }

  // ---- Get all snapshots needing enrichment ----
  const allWork = [] // { source, source_trader_id, season_id }
  for (const source of SOURCES) {
    // Get snapshots missing any field
    const { data: rows } = await sb.from('trader_snapshots')
      .select('source_trader_id, season_id, pnl, win_rate, trades_count, max_drawdown, aum')
      .eq('source', source)
    
    for (const r of (rows || [])) {
      if (r.pnl == null || r.win_rate == null || r.trades_count == null || r.max_drawdown == null || r.aum == null) {
        allWork.push({ source, source_trader_id: r.source_trader_id, season_id: r.season_id, existing: r })
      }
    }
  }

  // Group by trader (source + source_trader_id) to minimize API calls
  const byTrader = {}
  for (const w of allWork) {
    const k = `${w.source}|${w.source_trader_id}`
    if (!byTrader[k]) byTrader[k] = { source: w.source, tid: w.source_trader_id, seasons: {} }
    byTrader[k].seasons[w.season_id] = w.existing
  }

  const traders = Object.values(byTrader).slice(0, LIMIT)
  console.log(`\nTraders to enrich: ${traders.length}`)

  if (traders.length === 0) { console.log('Nothing to do!'); return }

  // ---- Launch browser ----
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })

  let updated = 0, errors = 0, apiCalls = 0

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

    console.log('🌐 Getting Cloudflare clearance...')
    await page.goto('https://www.bitget.com/copy-trading', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})
    await sleep(5000)

    // Close popups
    await page.evaluate(() => {
      document.querySelectorAll('button').forEach(btn => {
        if ((btn.textContent || '').match(/OK|Got|Accept/)) try { btn.click() } catch {}
      })
    }).catch(() => {})
    await sleep(1000)

    console.log('✅ Browser ready\n')

    for (let i = 0; i < traders.length; i++) {
      const t = traders[i]

      try {
        for (const [season, cycleTime] of Object.entries(SEASON_TO_CYCLE)) {
          if (!t.seasons[season]) continue // no snapshot for this season

          const existing = t.seasons[season]
          // Skip if all fields present
          if (existing.pnl != null && existing.win_rate != null && existing.trades_count != null && existing.max_drawdown != null && existing.aum != null) continue

          const result = await page.evaluate(async (uid, ct) => {
            try {
              const r = await fetch('/v1/trigger/trace/public/cycleData', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ languageType: 0, triggerUserId: uid, cycleTime: ct }),
              })
              return await r.json()
            } catch (e) { return { error: e.message } }
          }, t.tid, cycleTime)

          apiCalls++

          if (result?.code === '00000' && result.data?.statisticsDTO) {
            const s = result.data.statisticsDTO
            const updates = {}

            if (existing.pnl == null && s.profit) updates.pnl = parseFloat(s.profit)
            if (existing.win_rate == null && s.winningRate) updates.win_rate = parseFloat(s.winningRate)
            if (existing.trades_count == null && s.totalTrades != null) updates.trades_count = parseInt(s.totalTrades)
            if (existing.max_drawdown == null && s.maxRetracement) updates.max_drawdown = parseFloat(s.maxRetracement)
            if (existing.aum == null && s.aum) updates.aum = parseFloat(s.aum)

            if (Object.keys(updates).length > 0) {
              const { error } = await sb.from('trader_snapshots')
                .update(updates)
                .eq('source', t.source)
                .eq('source_trader_id', t.tid)
                .eq('season_id', season)

              if (!error) updated++
              else console.log(`  ⚠ DB error: ${error.message}`)
            }
          } else if (result?.code !== '00000') {
            // Check if blocked
            if (result?.msg?.includes('frequent') || result?.code === '40012') {
              console.log('  ⏳ Rate limited, waiting 10s...')
              await sleep(10000)
            }
          }

          await sleep(300 + Math.random() * 200)
        }
      } catch (e) {
        errors++
      }

      if ((i + 1) % 20 === 0 || i === traders.length - 1) {
        console.log(`  [${i + 1}/${traders.length}] updated=${updated} apiCalls=${apiCalls} errors=${errors}`)
      }

      await sleep(500 + Math.random() * 300)
    }
  } finally {
    await browser.close()
  }

  // ---- AFTER snapshot ----
  console.log(`\n${'='.repeat(60)}`)
  console.log(`RESULTS:`)
  for (const source of SOURCES) {
    const { data: rows } = await sb.from('trader_snapshots')
      .select('season_id, pnl, win_rate, trades_count, max_drawdown, aum')
      .eq('source', source)
    const agg = { total: 0, no_pnl: 0, no_wr: 0, no_tc: 0, no_mdd: 0, no_aum: 0 }
    for (const r of (rows || [])) {
      agg.total++
      if (r.pnl == null) agg.no_pnl++
      if (r.win_rate == null) agg.no_wr++
      if (r.trades_count == null) agg.no_tc++
      if (r.max_drawdown == null) agg.no_mdd++
      if (r.aum == null) agg.no_aum++
    }
    const b = beforeStats[source]
    console.log(`${source}:`)
    console.log(`  pnl:    ${b.no_pnl} → ${agg.no_pnl}`)
    console.log(`  wr:     ${b.no_wr} → ${agg.no_wr}`)
    console.log(`  tc:     ${b.no_tc} → ${agg.no_tc}`)
    console.log(`  mdd:    ${b.no_mdd} → ${agg.no_mdd}`)
    console.log(`  aum:    ${b.no_aum} → ${agg.no_aum}`)
  }
  console.log(`\nTotal updated: ${updated}, API calls: ${apiCalls}, Errors: ${errors}`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)
