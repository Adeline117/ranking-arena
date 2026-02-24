#!/usr/bin/env node
/**
 * Bitget Futures Detail Enrichment v2
 * 
 * Strategy:
 * 1. Use traderList API to get traderUid → nickname mapping
 * 2. Match against our DB's source_trader_id (which are nicknames/handles)
 * 3. Call cycleData API with numeric traderUid for each period
 * 4. Upsert to trader_stats_detail
 * 
 * Runs from Mac Mini (not VPS) since Bitget CF blocks VPS IPs.
 * Usage: node scripts/import/enrich_bitget_futures_detail_v2.mjs [--limit=500]
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

const SOURCE = 'bitget_futures'
const CYCLE_MAP = { '7D': 7, '30D': 30, '90D': 90 }
const sleep = ms => new Promise(r => setTimeout(r, ms))

const args = process.argv.slice(2)
const limitArg = args.find(a => a.startsWith('--limit='))
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1]) : 500

// ============================================
// DB helpers
// ============================================
async function upsertStats(traderId, period, stats) {
  if (!stats) return 0
  const now = new Date().toISOString()
  
  let winRate = parseFloat(stats.winningRate || '0') || null
  let mdd = parseFloat(stats.maxRetracement || '0') || null
  let roi = parseFloat(stats.profitRate || '0') || null
  
  // Normalize: API returns 38.71 for 38.71%, but sometimes 0.3871
  if (winRate && winRate > 0 && winRate <= 1) winRate *= 100
  if (mdd && mdd > 0 && mdd <= 1) mdd *= 100
  if (roi && roi > 0 && roi <= 1) roi *= 100
  
  const row = {
    source: SOURCE, source_trader_id: traderId, period,
    roi: roi,
    total_trades: parseInt(stats.totalTrades || '0') || null,
    profitable_trades_pct: winRate,
    avg_holding_time_hours: stats.averageHoldingTime ? stats.averageHoldingTime / 3600000 : null,
    avg_profit: parseFloat(stats.avgWin || '0') || null,
    avg_loss: parseFloat(stats.avgLoss || '0') ? -Math.abs(parseFloat(stats.avgLoss)) : null,
    largest_win: parseFloat(stats.largestProfit || '0') || null,
    largest_loss: parseFloat(stats.largestLoss || '0') ? -Math.abs(parseFloat(stats.largestLoss)) : null,
    sharpe_ratio: null,
    max_drawdown: mdd,
    copiers_count: parseInt(stats.totalFollowers || '0') || null,
    copiers_pnl: parseFloat(stats.totalFollowProfit || '0') || null,
    aum: parseFloat(stats.aum || '0') || null,
    winning_positions: parseInt(stats.profitTrades || '0') || null,
    total_positions: parseInt(stats.totalTrades || '0') || null,
    captured_at: now,
  }
  
  // Only include fields with actual values
  const cleanRow = {}
  for (const [k, v] of Object.entries(row)) {
    if (v !== null && v !== undefined) cleanRow[k] = v
    else if (['source', 'source_trader_id', 'period', 'captured_at'].includes(k)) cleanRow[k] = v
  }
  
  await sb.from('trader_stats_detail')
    .delete().eq('source', SOURCE).eq('source_trader_id', traderId).eq('period', period)
  const { error } = await sb.from('trader_stats_detail').insert(cleanRow)
  if (error) { console.log(`  ⚠ stats: ${error.message}`); return 0 }
  return 1
}

async function updateSnapshot(traderId, seasonId, winRate, mdd, tradesCount, followers) {
  const updateData = {}
  if (winRate != null) updateData.win_rate = winRate
  if (mdd != null) updateData.max_drawdown = mdd
  if (tradesCount != null) updateData.trades_count = tradesCount
  if (followers != null) updateData.followers = followers
  
  if (Object.keys(updateData).length === 0) return 0
  
  const { error } = await sb.from('trader_snapshots')
    .update(updateData)
    .eq('source', SOURCE)
    .eq('source_trader_id', traderId)
    .eq('season_id', seasonId)
  
  if (error) { console.log(`  ⚠ snapshot update: ${error.message}`); return 0 }
  return 1
}

// ============================================
// Main
// ============================================
async function main() {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Bitget Futures Detail Enrichment v2`)
  console.log(`Limit: ${LIMIT}`)
  console.log(`${'='.repeat(60)}`)

  // Get our traders that need enrichment
  const { data: allTraders } = await sb.from('trader_sources')
    .select('source_trader_id, handle')
    .eq('source', SOURCE).eq('is_active', true)

  if (!allTraders?.length) { console.log('No traders found'); return }
  console.log(`Total active traders in DB: ${allTraders.length}`)

  // Check which already have stats for all 3 periods
  const { data: existingStats } = await sb.from('trader_stats_detail')
    .select('source_trader_id, period')
    .eq('source', SOURCE)

  const statsSet = new Set((existingStats || []).map(e => `${e.source_trader_id}|${e.period}`))
  
  // Find traders missing any period
  const needsEnrichment = allTraders.filter(t => {
    return !statsSet.has(`${t.source_trader_id}|7D`) ||
           !statsSet.has(`${t.source_trader_id}|30D`) ||
           !statsSet.has(`${t.source_trader_id}|90D`)
  })
  
  console.log(`Traders needing enrichment: ${needsEnrichment.length}`)
  if (needsEnrichment.length === 0) { console.log('Nothing to do!'); return }

  // Build a lookup by normalized nickname
  const normalizeNick = (n) => n.replace(/^@/, '').toLowerCase()
  const tradersByNick = new Map()
  for (const t of needsEnrichment) {
    tradersByNick.set(normalizeNick(t.source_trader_id), t.source_trader_id)
    if (t.handle && t.handle !== t.source_trader_id) {
      tradersByNick.set(normalizeNick(t.handle), t.source_trader_id)
    }
  }

  // Launch browser
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })

  let statsN = 0, snapshotN = 0, errors = 0, matched = 0

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')

    console.log('🌐 Getting Cloudflare clearance...')
    await page.goto('https://www.bitget.com/copy-trading/futures', { waitUntil: 'networkidle0', timeout: 30000 }).catch(() => {})
    await sleep(3000)
    console.log('✅ Browser ready')

    // Step 1: Fetch all traders from Bitget's traderList API to get UID→nickname mapping
    console.log('\n📋 Fetching trader list from Bitget API...')
    const uidToNick = new Map() // traderUid -> traderNickName
    const nickToUid = new Map() // normalized nickname -> traderUid
    
    let pageNo = 1
    const pageSize = 20
    let hasMore = true
    
    while (hasMore && pageNo <= 100) { // Max 100 pages = 2000 traders
      const result = await page.evaluate(async (pn, ps) => {
        try {
          const r = await fetch('/v1/trigger/trace/public/traderList', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ languageType: 0, sort: 0, rule: 2, pageNo: pn, pageSize: ps }),
          })
          const text = await r.text()
          if (text.startsWith('<')) return null
          return JSON.parse(text)
        } catch { return null }
      }, pageNo, pageSize)
      
      if (!result?.data?.rows?.length) { hasMore = false; break }
      
      for (const t of result.data.rows) {
        if (t.traderUid && t.traderNickName) {
          uidToNick.set(t.traderUid, t.traderNickName)
          nickToUid.set(normalizeNick(t.traderNickName), t.traderUid)
        }
      }
      
      hasMore = result.data.nextFlag === true
      pageNo++
      
      if (pageNo % 10 === 0) {
        console.log(`  Page ${pageNo}, collected ${nickToUid.size} traders`)
      }
      
      await sleep(300 + Math.random() * 200)
    }
    
    console.log(`Collected ${nickToUid.size} Bitget traders with UIDs`)

    // Step 2: Match our DB traders with Bitget UIDs
    const toProcess = []
    for (const [nick, uid] of nickToUid) {
      const dbId = tradersByNick.get(nick)
      if (dbId) {
        // Check which periods are missing
        const missingPeriods = []
        for (const p of ['7D', '30D', '90D']) {
          if (!statsSet.has(`${dbId}|${p}`)) missingPeriods.push(p)
        }
        if (missingPeriods.length > 0) {
          toProcess.push({ uid, dbId, nick, missingPeriods })
        }
      }
    }
    
    console.log(`Matched ${toProcess.length} traders needing enrichment`)
    
    if (toProcess.length === 0) {
      console.log('⚠ No matches found. Nicknames may differ between API and DB.')
      // Debug: show some examples
      const dbNicks = [...tradersByNick.keys()].slice(0, 10)
      const apiNicks = [...nickToUid.keys()].slice(0, 10)
      console.log('  DB nicknames:', dbNicks)
      console.log('  API nicknames:', apiNicks)
    }

    const limited = toProcess.slice(0, LIMIT)
    console.log(`Processing ${limited.length} traders...\n`)

    // Step 3: Enrich each matched trader
    for (let i = 0; i < limited.length; i++) {
      const { uid, dbId, missingPeriods } = limited[i]
      
      try {
        for (const period of missingPeriods) {
          const cycleTime = CYCLE_MAP[period]
          
          const result = await Promise.race([
            page.evaluate(async (triggerUid, ct) => {
              try {
                const r = await fetch('/v1/trigger/trace/public/cycleData', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ languageType: 0, triggerUserId: triggerUid, cycleTime: ct }),
                })
                const text = await r.text()
                if (text.startsWith('<')) return null
                return JSON.parse(text)
              } catch { return null }
            }, uid, cycleTime),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000))
          ]).catch(() => null)

          if (result?.code === '00000' && result.data?.statisticsDTO) {
            const stats = result.data.statisticsDTO
            const sn = await upsertStats(dbId, period, stats)
            if (sn > 0) statsN++
            
            // Also update snapshot
            let winRate = parseFloat(stats.winningRate || '0') || null
            let mdd = parseFloat(stats.maxRetracement || '0') || null
            if (winRate && winRate > 0 && winRate <= 1) winRate *= 100
            if (mdd && mdd > 0 && mdd <= 1) mdd *= 100
            const trades = parseInt(stats.totalTrades || '0') || null
            const followers = parseInt(stats.totalFollowers || '0') || null
            
            const snapN = await updateSnapshot(dbId, period, winRate, mdd, trades, followers)
            if (snapN > 0) snapshotN++
          }
          
          await sleep(400 + Math.random() * 200)
        }
      } catch (e) {
        console.log(`  ⚠ Error for ${dbId}: ${e.message}`)
        errors++
      }

      if ((i + 1) % 10 === 0 || i === limited.length - 1) {
        const pct = ((i + 1) / limited.length * 100).toFixed(0)
        console.log(`  [${i + 1}/${limited.length}] ${pct}% | stats=${statsN} snap=${snapshotN} err=${errors}`)
      }
      
      await sleep(300 + Math.random() * 200)
    }
  } finally {
    await browser.close()
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ Bitget Futures enrichment done`)
  console.log(`   Stats upserted: ${statsN}`)
  console.log(`   Snapshots updated: ${snapshotN}`)
  console.log(`   Errors: ${errors}`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)
