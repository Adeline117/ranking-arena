#!/usr/bin/env node
/**
 * enrich-bitget-futures-wr-mdd.mjs
 * Enriches bitget_futures trader_snapshots with win_rate and max_drawdown.
 * Uses /v1/trigger/trace/public/cycleData → statisticsDTO.winningRate + maxRetracement
 * Robust: re-launches browser on crash/closure.
 */

import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const args = process.argv.slice(2)
const LIMIT = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '2000')
const DRY_RUN = args.includes('--dry-run')
const DELAY_MS = 500

const sleep = ms => new Promise(r => setTimeout(r, ms))
const parseNum = v => { if (v == null) return null; const n = parseFloat(v); return isNaN(n) ? null : n }

function seasonToCycleTime(season_id) {
  if (!season_id) return 30
  const upper = season_id.toUpperCase()
  if (upper.startsWith('7')) return 7
  if (upper.startsWith('30')) return 30
  if (upper.startsWith('90')) return 90
  return 30
}

// ─── Launch browser + page ────────────────────────────────────────────────────
async function launchBrowser() {
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
  })
  const page = await ctx.newPage()
  await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,css}', r => r.abort())
  await page.goto('https://www.bitget.com/copy-trading/futures', {
    waitUntil: 'domcontentloaded', timeout: 30000,
  }).catch(e => console.warn('Nav warn:', e.message))
  await sleep(2500)
  return { browser, page }
}

// ─── API call ────────────────────────────────────────────────────────────────
async function fetchCycleData(page, triggerUserId, cycleTime) {
  let result
  try {
    result = await Promise.race([
      page.evaluate(async ({ triggerUserId, cycleTime }) => {
        try {
          const r = await fetch('/v1/trigger/trace/public/cycleData', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ languageType: 0, triggerUserId, cycleTime }),
          })
          const text = await r.text()
          if (!text || text.trim().length < 5) return { status: r.status, empty: true }
          if (text.startsWith('<')) return { status: r.status, html: true }
          let parsed
          try { parsed = JSON.parse(text) } catch(e) { return { status: r.status, parseErr: e.message } }
          return { status: r.status, ok: r.ok, data: parsed }
        } catch (e) {
          return { error: e.toString() }
        }
      }, { triggerUserId, cycleTime }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('evaluate timeout')), 15000)),
    ])
  } catch (e) {
    return { error: e.message, closed: e.message.includes('closed') || e.message.includes('Target') || e.message.includes('timeout') }
  }
  return result
}

// ─── Extract stats ───────────────────────────────────────────────────────────
function extractStats(result) {
  if (!result) return { winRate: null, maxDD: null, reason: 'null result' }
  if (result.error) return { winRate: null, maxDD: null, reason: result.error }
  if (result.empty) return { winRate: null, maxDD: null, reason: `empty resp (${result.status})` }
  if (result.html) return { winRate: null, maxDD: null, reason: `HTML resp (${result.status})` }
  if (result.parseErr) return { winRate: null, maxDD: null, reason: `parse: ${result.parseErr}` }
  const data = result.data
  if (!data) return { winRate: null, maxDD: null, reason: 'no data' }
  if (data.code !== '00000') return { winRate: null, maxDD: null, reason: `code=${data.code} ${data.msg || ''}` }
  const stats = data.data?.statisticsDTO
  if (!stats) return { winRate: null, maxDD: null, reason: 'no statisticsDTO' }
  return {
    winRate: parseNum(stats.winningRate),
    maxDD: parseNum(stats.maxRetracement),
    reason: null,
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`🔄 Bitget Futures win_rate/max_drawdown Enrichment`)
  console.log(`   DRY_RUN: ${DRY_RUN} | Limit: ${LIMIT}`)
  console.log('')

  // Count nulls
  const { count: nullWRBefore } = await sb.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', 'bitget_futures').is('win_rate', null)
  const { count: nullMDDBefore } = await sb.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', 'bitget_futures').is('max_drawdown', null)
  console.log(`📊 Before: win_rate NULL=${nullWRBefore}, max_drawdown NULL=${nullMDDBefore}`)

  // Fetch all traders needing enrichment (fetch more than needed to ensure we get hex IDs)
  const { data: allRows, error: fetchErr } = await sb
    .from('trader_snapshots')
    .select('source_trader_id, win_rate, max_drawdown, season_id')
    .eq('source', 'bitget_futures')
    .or('win_rate.is.null,max_drawdown.is.null')
    .order('arena_score', { ascending: false, nullsFirst: false })
    .limit(5000)

  if (fetchErr) { console.error('Fetch error:', fetchErr.message); process.exit(1) }

  // Deduplicate
  const seen = new Map()
  for (const r of allRows) {
    if (!seen.has(r.source_trader_id)) {
      seen.set(r.source_trader_id, { id: r.source_trader_id, season: r.season_id, needWR: r.win_rate === null, needMDD: r.max_drawdown === null })
    } else {
      const e = seen.get(r.source_trader_id)
      if (r.win_rate === null) e.needWR = true
      if (r.max_drawdown === null) e.needMDD = true
    }
  }

  // Filter hex IDs
  const traders = [...seen.values()].filter(t => /^[a-f0-9]{16,}$/i.test(t.id)).slice(0, LIMIT)
  const nonHex = [...seen.values()].filter(t => !/^[a-f0-9]{16,}$/i.test(t.id))

  console.log(`Hex traders to process: ${traders.length}`)
  console.log(`Non-hex skipping: ${nonHex.length}`)
  console.log('')

  if (traders.length === 0) {
    console.log('✅ No hex traders to process')
    return
  }

  let { browser, page } = await launchBrowser()
  console.log(`🌐 Browser ready\n`)

  let updated = 0, noData = 0, errors = 0, browserRestarts = 0
  let apiCalls = 0

  for (let i = 0; i < traders.length; i++) {
    const { id: tid, season: season_id, needWR, needMDD } = traders[i]
    const cycleTime = seasonToCycleTime(season_id)

    process.stdout.write(`  [${i + 1}/${traders.length}] ${tid.slice(0, 16)}... cycle=${cycleTime} `)

    // Refresh page every 50 calls
    if (apiCalls > 0 && apiCalls % 50 === 0) {
      try {
        await page.goto('https://www.bitget.com/copy-trading/futures', { waitUntil: 'domcontentloaded', timeout: 20000 })
        await sleep(1500)
        process.stdout.write(`[refresh] `)
      } catch(e) {
        process.stdout.write(`[refresh fail] `)
      }
    }

    const result = await fetchCycleData(page, tid, cycleTime)

    // If browser/page closed, restart
    if (result.closed) {
      process.stdout.write(`browser died, restarting... `)
      try { await browser.close() } catch(e) {}
      await sleep(3000);
      ({ browser, page } = await launchBrowser())
      browserRestarts++
      // Retry once
      const result2 = await fetchCycleData(page, tid, cycleTime)
      Object.assign(result, result2)
    }

    apiCalls++

    const { winRate, maxDD, reason } = extractStats(result)

    // Build update (only for fields that are NULL and we got a value)
    const updates = {}
    if (needWR && winRate !== null) updates.win_rate = winRate
    if (needMDD && maxDD !== null) updates.max_drawdown = maxDD

    if (Object.keys(updates).length === 0) {
      process.stdout.write(`⚠️  ${reason || 'no data'}\n`)
      noData++
    } else {
      process.stdout.write(`wr=${winRate ?? '-'} mdd=${maxDD ?? '-'} `)
      if (!DRY_RUN) {
        const { error: upErr } = await sb
          .from('trader_snapshots')
          .update(updates)
          .eq('source', 'bitget_futures')
          .eq('source_trader_id', tid)

        if (upErr) {
          process.stdout.write(`❌ ${upErr.message}\n`)
          errors++
        } else {
          process.stdout.write(`✅\n`)
          updated++
        }
      } else {
        process.stdout.write(`[dry]\n`)
        updated++
      }
    }

    if ((updated + noData + errors) % 50 === 0 && (updated + noData + errors) > 0) {
      const { count: curNullWR } = await sb.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', 'bitget_futures').is('win_rate', null)
      console.log(`\n  📊 Checkpoint [${i + 1}/${traders.length}]: updated=${updated} noData=${noData} errors=${errors} restarts=${browserRestarts} | DB null_wr=${curNullWR}\n`)
    }

    await sleep(DELAY_MS + Math.random() * 300)
  }

  try { await browser.close() } catch(e) {}

  // Final counts
  const { count: nullWRAfter } = await sb.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', 'bitget_futures').is('win_rate', null)
  const { count: nullMDDAfter } = await sb.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', 'bitget_futures').is('max_drawdown', null)

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ Done: updated=${updated} noData=${noData} errors=${errors} restarts=${browserRestarts}`)
  console.log(`\n📊 DB Verification:`)
  console.log(`   win_rate  NULL: ${nullWRBefore} → ${nullWRAfter}  (filled ${nullWRBefore - nullWRAfter})`)
  console.log(`   max_drawdown NULL: ${nullMDDBefore} → ${nullMDDAfter}  (filled ${nullMDDBefore - nullMDDAfter})`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
