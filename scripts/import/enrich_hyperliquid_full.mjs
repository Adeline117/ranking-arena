#!/usr/bin/env node
/**
 * Hyperliquid Full Enrichment — trades_count + AUM + max_drawdown + win_rate
 * 
 * Fills ALL missing fields across ALL seasons.
 * Uses: userFills (trades_count, win_rate), clearinghouseState (AUM), portfolio (max_drawdown)
 * 
 * Rate limit: ~1 req/2s. Caches API responses to avoid duplicate calls per trader.
 * 
 * Usage: node scripts/import/enrich_hyperliquid_full.mjs [--batch=100] [--resume]
 */

import { getSupabaseClient, calculateArenaScore, sleep } from '../lib/shared.mjs'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../..')
const LOGS_DIR = join(ROOT, 'logs')
const PROGRESS_FILE = join(LOGS_DIR, 'hl-full-enrich-progress.json')
if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true })

const supabase = getSupabaseClient()
const SOURCE = 'hyperliquid'
const INFO_API = 'https://api.hyperliquid.xyz/info'
const WINDOW_DAYS = { '7D': 7, '30D': 30, '90D': 90 }
const PORTFOLIO_KEY = { '7D': 'perpWeek', '30D': 'perpMonth', '90D': 'perpAllTime' }

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`) }

async function apiFetch(body) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(INFO_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000)
      })
      if (res.status === 200) return res.json()
      if (res.status === 429) {
        await sleep(3000 * (attempt + 1))
        continue
      }
      throw new Error(`API ${res.status}`)
    } catch (e) {
      if (attempt < 4) { await sleep(2000 * (attempt + 1)); continue }
      throw e
    }
  }
  return null
}

// Load progress
function loadProgress() {
  try {
    if (existsSync(PROGRESS_FILE)) return JSON.parse(readFileSync(PROGRESS_FILE, 'utf8'))
  } catch {}
  return { completed: [] }
}
function saveProgress(data) {
  try { writeFileSync(PROGRESS_FILE, JSON.stringify(data, null, 2)) } catch {}
}

async function main() {
  const args = process.argv.slice(2)
  const batchSize = parseInt(args.find(a => a.startsWith('--batch='))?.split('=')[1] || '100')
  const resume = args.includes('--resume')

  log('='.repeat(60))
  log('Hyperliquid FULL Enrichment — All Seasons')
  log(`Batch: ${batchSize}, Resume: ${resume}`)
  log('='.repeat(60))

  // Fetch ALL snapshots for hyperliquid across all seasons
  const allSnapshots = []
  for (const season of ['7D', '30D', '90D']) {
    let page = 0, pageSize = 1000
    while (true) {
      const { data, error } = await supabase
        .from('trader_snapshots')
        .select('id, source_trader_id, season_id, roi, pnl, win_rate, max_drawdown, trades_count, aum')
        .eq('source', SOURCE)
        .eq('season_id', season)
        .range(page * pageSize, (page + 1) * pageSize - 1)
      if (error) { log(`Error: ${error.message}`); break }
      if (!data?.length) break
      allSnapshots.push(...data)
      if (data.length < pageSize) break
      page++
    }
  }
  log(`Loaded ${allSnapshots.length} snapshots across all seasons`)

  // Find unique traders needing enrichment
  const traderNeeds = new Map() // address -> { needFills, needState, needPortfolio, snapshots[] }
  for (const snap of allSnapshots) {
    const addr = snap.source_trader_id
    if (!traderNeeds.has(addr)) {
      traderNeeds.set(addr, { needFills: false, needState: false, needPortfolio: false, snapshots: [] })
    }
    const entry = traderNeeds.get(addr)
    entry.snapshots.push(snap)
    if (snap.trades_count === null || snap.trades_count === 0 || snap.win_rate === null) entry.needFills = true
    if (snap.aum === null) entry.needState = true
    if (snap.max_drawdown === null) entry.needPortfolio = true
  }

  // Filter to traders that need something
  const needsWork = [...traderNeeds.entries()].filter(([_, v]) => v.needFills || v.needState || v.needPortfolio)
  
  // Resume support
  const progress = resume ? loadProgress() : { completed: [] }
  const completedSet = new Set(progress.completed)
  const remaining = needsWork.filter(([addr]) => !completedSet.has(addr))

  log(`Traders needing work: ${needsWork.length}`)
  log(`Already completed: ${completedSet.size}`)
  log(`Remaining: ${remaining.length}`)
  
  const batch = remaining.slice(0, batchSize)
  if (batch.length === 0) { log('Nothing to do!'); return }
  
  // Estimate: each trader needs 1-3 API calls at ~2.5s each
  const avgCalls = batch.reduce((s, [_, v]) => s + (v.needFills?1:0) + (v.needState?1:0) + (v.needPortfolio?1:0), 0) / batch.length
  log(`Processing ${batch.length} traders (~${avgCalls.toFixed(1)} API calls/trader)`)
  log(`Estimated time: ~${Math.ceil(batch.length * avgCalls * 2.5 / 60)} min`)

  let stats = { tc: 0, aum: 0, wr: 0, mdd: 0, errors: 0, updated: 0, positions: 0 }
  const startTime = Date.now()

  for (let i = 0; i < batch.length; i++) {
    const [addr, needs] = batch[i]
    try {
      let fills = null, state = null, portfolio = null

      // 1. Fetch fills (for trades_count + win_rate)
      if (needs.needFills) {
        log(`  [${i+1}] Fetching fills for ${addr.slice(0,10)}...`)
        fills = await apiFetch({ type: 'userFills', user: addr })
        log(`  [${i+1}] Got ${Array.isArray(fills) ? fills.length : 'null'} fills`)
        await sleep(2200)
      }

      // 2. Fetch clearinghouseState (for AUM + open positions)
      if (needs.needState) {
        state = await apiFetch({ type: 'clearinghouseState', user: addr })
        await sleep(2200)
      }

      // 3. Fetch portfolio (for max_drawdown)
      if (needs.needPortfolio) {
        portfolio = await apiFetch({ type: 'portfolio', user: addr })
        await sleep(2200)
      }

      // Process each snapshot for this trader
      for (const snap of needs.snapshots) {
        const update = {}
        const period = snap.season_id
        const days = WINDOW_DAYS[period]
        const cutoff = Date.now() - days * 24 * 3600 * 1000

        // trades_count from fills
        if ((snap.trades_count === null || snap.trades_count === 0) && Array.isArray(fills)) {
          const periodFills = fills.filter(f => f.time >= cutoff && parseFloat(f.closedPnl || '0') !== 0)
          if (periodFills.length > 0) {
            update.trades_count = periodFills.length
            stats.tc++
          } else {
            // Fallback: count all fills with closedPnl
            const allClosed = fills.filter(f => parseFloat(f.closedPnl || '0') !== 0)
            if (allClosed.length > 0) {
              update.trades_count = allClosed.length
              stats.tc++
            }
          }
        }

        // win_rate from fills
        if (snap.win_rate === null && Array.isArray(fills)) {
          let closed = fills.filter(f => f.time >= cutoff && parseFloat(f.closedPnl || '0') !== 0)
          if (closed.length < 3) closed = fills.filter(f => parseFloat(f.closedPnl || '0') !== 0)
          if (closed.length >= 3) {
            const wins = closed.filter(f => parseFloat(f.closedPnl) > 0).length
            update.win_rate = (wins / closed.length) * 100
            stats.wr++
          }
        }

        // AUM from clearinghouseState
        if (snap.aum === null && state?.marginSummary) {
          const av = parseFloat(state.marginSummary.accountValue || '0')
          if (av > 0) {
            update.aum = av
            stats.aum++
          }
        }

        // max_drawdown from portfolio
        if (snap.max_drawdown === null && Array.isArray(portfolio)) {
          const key = PORTFOLIO_KEY[period]
          const periodData = portfolio.find(([k]) => k === key)?.[1]
          if (periodData?.accountValueHistory && periodData?.pnlHistory) {
            const avh = periodData.accountValueHistory
            const ph = periodData.pnlHistory
            if (avh.length > 0 && ph.length > 0) {
              let maxDD = 0
              for (let ii = 0; ii < ph.length; ii++) {
                const startAV = parseFloat(avh[ii]?.[1] || '0')
                const startPnl = parseFloat(ph[ii][1])
                if (startAV <= 0) continue
                for (let jj = ii + 1; jj < ph.length; jj++) {
                  const endPnl = parseFloat(ph[jj][1])
                  const dd = (endPnl - startPnl) / startAV
                  if (dd < maxDD) maxDD = dd
                }
              }
              if (Math.abs(maxDD) > 0.001) {
                update.max_drawdown = Math.abs(maxDD) * 100
                stats.mdd++
              }
            }
          }
        }

        // Update if we have new data
        if (Object.keys(update).length > 0) {
          const newWr = update.win_rate ?? snap.win_rate
          const newMdd = update.max_drawdown ?? snap.max_drawdown
          const { totalScore } = calculateArenaScore(snap.roi || 0, snap.pnl, newMdd, newWr, period)
          update.arena_score = totalScore
          
          const { error } = await supabase.from('trader_snapshots').update(update).eq('id', snap.id)
          if (error) log(`  DB error ${snap.id}: ${error.message}`)
          else stats.updated++
        }
      }

      // Save positions from clearinghouseState
      if (state?.assetPositions?.length) {
        const now = new Date().toISOString()
        const positions = state.assetPositions
          .filter(p => parseFloat(p.position?.szi || '0') !== 0)
          .map(p => {
            const pos = p.position
            const size = parseFloat(pos.szi || '0')
            return {
              source: SOURCE,
              source_trader_id: addr,
              symbol: pos.coin || 'UNKNOWN',
              direction: size > 0 ? 'long' : 'short',
              position_type: 'perpetual',
              margin_mode: pos.leverage?.type || 'cross',
              entry_price: parseFloat(pos.entryPx || '0') || null,
              exit_price: null,
              max_position_size: Math.abs(size),
              closed_size: null,
              pnl_usd: parseFloat(pos.unrealizedPnl || '0') || null,
              pnl_pct: parseFloat(pos.returnOnEquity || '0') ? parseFloat(pos.returnOnEquity) * 100 : null,
              status: 'open',
              open_time: null,
              close_time: null,
              captured_at: now,
            }
          }).filter(r => r.symbol !== 'UNKNOWN')

        if (positions.length > 0) {
          // Clear recent open positions for this trader
          await supabase.from('trader_position_history')
            .delete()
            .eq('source', SOURCE)
            .eq('source_trader_id', addr)
            .eq('status', 'open')
          await supabase.from('trader_position_history').insert(positions)
          stats.positions += positions.length
        }
      }

      progress.completed.push(addr)
      if ((i + 1) % 10 === 0) saveProgress(progress)

    } catch (e) {
      stats.errors++
      log(`  Error ${addr.slice(0,10)}: ${e.message}`)
    }

    if ((i + 1) % 20 === 0 || i === batch.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1)
      const eta = ((Date.now() - startTime) / (i + 1) * (batch.length - i - 1) / 60000).toFixed(1)
      log(`[${i+1}/${batch.length}] tc+=${stats.tc} aum+=${stats.aum} wr+=${stats.wr} mdd+=${stats.mdd} pos=${stats.positions} err=${stats.errors} | ${elapsed}m, ~${eta}m left`)
    }
  }

  saveProgress(progress)

  log('\n' + '='.repeat(60))
  log('✅ Batch complete')
  log(`  Updated snapshots: ${stats.updated}`)
  log(`  trades_count filled: ${stats.tc}`)
  log(`  AUM filled: ${stats.aum}`)
  log(`  win_rate filled: ${stats.wr}`)
  log(`  max_drawdown filled: ${stats.mdd}`)
  log(`  positions saved: ${stats.positions}`)
  log(`  Errors: ${stats.errors}`)
  log(`  Total completed: ${progress.completed.length}`)
  log(`  Remaining: ${remaining.length - batch.length}`)
  if (remaining.length - batch.length > 0) log('💡 Run again with --resume to continue')
  log('='.repeat(60))
}

main().catch(e => { log(`Fatal: ${e.message}`); process.exit(1) })
