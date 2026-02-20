#!/usr/bin/env node
/**
 * enrich-bitget-futures-nonhex.mjs
 * Second pass: enrich non-hex traders using traderList pagination.
 * 
 * Strategy:
 * - Non-hex traders have display names as source_trader_id (e.g. "FutureExpert", "BGUSER-XM4TKGNV")
 * - Paginate through /v1/trigger/trace/public/traderList for cycleTime 7, 30, 90
 * - Match by traderNickName → get winningRate (win_rate) and traderUid
 * - Use traderUid with cycleData to get maxRetracement (max_drawdown)
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
const DRY_RUN = args.includes('--dry-run')
const DELAY_MS = 600
const sleep = ms => new Promise(r => setTimeout(r, ms))
const parseNum = v => { if (v == null) return null; const n = parseFloat(v); return isNaN(n) ? null : n }

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

async function fetchPage(page, cycleTime, pageNo, pageSize = 50) {
  try {
    const result = await page.evaluate(async ({ cycleTime, pageNo, pageSize }) => {
      try {
        const r = await fetch('/v1/trigger/trace/public/traderList', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ languageType: 0, productType: 'USDT-FUTURES', cycleTime, pageNo, pageSize }),
        })
        const text = await r.text()
        if (!text || text.startsWith('<')) return { error: 'HTML/empty', status: r.status }
        return { status: r.status, data: JSON.parse(text) }
      } catch(e) { return { error: e.toString() } }
    }, { cycleTime, pageNo, pageSize })
    return result
  } catch(e) {
    return { error: e.message }
  }
}

async function fetchCycleData(page, triggerUserId, cycleTime) {
  try {
    return await page.evaluate(async ({ triggerUserId, cycleTime }) => {
      try {
        const r = await fetch('/v1/trigger/trace/public/cycleData', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ languageType: 0, triggerUserId, cycleTime }),
        })
        const text = await r.text()
        if (!text || text.startsWith('<')) return { error: 'empty/HTML' }
        const data = JSON.parse(text)
        return { data }
      } catch(e) { return { error: e.toString() } }
    }, { triggerUserId, cycleTime })
  } catch(e) {
    return { error: e.message }
  }
}

async function main() {
  console.log(`🔄 Bitget Futures non-hex trader enrichment`)
  console.log(`   DRY_RUN: ${DRY_RUN}`)

  // Get non-hex traders with NULL win_rate or max_drawdown
  const { data: allRows } = await sb
    .from('trader_snapshots')
    .select('source_trader_id, win_rate, max_drawdown, season_id')
    .eq('source', 'bitget_futures')
    .or('win_rate.is.null,max_drawdown.is.null')
    .limit(5000)

  // Deduplicate non-hex
  const seen = new Map()
  for (const r of allRows) {
    const id = r.source_trader_id
    if (/^[a-f0-9]{16,}$/i.test(id)) continue // skip hex traders (already processed)
    if (!seen.has(id)) {
      seen.set(id, { id, season: r.season_id, needWR: r.win_rate === null, needMDD: r.max_drawdown === null })
    } else {
      const e = seen.get(id)
      if (r.win_rate === null) e.needWR = true
      if (r.max_drawdown === null) e.needMDD = true
    }
  }

  const nonHexTraders = [...seen.values()]
  console.log(`Non-hex traders to enrich: ${nonHexTraders.length}`)
  console.log(`Sample:`, nonHexTraders.slice(0, 5).map(t => t.id))
  
  if (nonHexTraders.length === 0) {
    console.log('✅ Nothing to do')
    return
  }

  // Build name→info map for quick lookup
  const nameMap = new Map()
  for (const t of nonHexTraders) {
    nameMap.set(t.id.toLowerCase(), t)
  }

  const { browser, page } = await launchBrowser()
  console.log(`\n🌐 Browser ready`)
  
  // Build a mapping: traderNickName (lowercase) → { traderUid, winningRate, cycleTime }
  const discovered = new Map()
  
  for (const cycleTime of [30, 7, 90]) {
    console.log(`\n📋 Paginating traderList cycleTime=${cycleTime}...`)
    let pageNo = 1
    let totalFound = 0
    
    while (true) {
      const resp = await fetchPage(page, cycleTime, pageNo, 50)
      if (resp.error) {
        console.log(`  Page ${pageNo}: error=${resp.error}`)
        break
      }
      
      const data = resp.data
      if (data?.code !== '00000') {
        console.log(`  Page ${pageNo}: code=${data?.code} msg=${data?.msg}`)
        break
      }
      
      const rows = data?.data?.rows || []
      if (rows.length === 0) break
      
      let matchCount = 0
      for (const row of rows) {
        const nick = (row.traderNickName || row.userName || '').toLowerCase()
        if (nameMap.has(nick)) {
          const existing = discovered.get(nick)
          // Keep the one with matching cycleTime to the trader's season
          const traderInfo = nameMap.get(nick)
          const traderCycle = traderInfo.season?.startsWith('7') ? 7 : traderInfo.season?.startsWith('90') ? 90 : 30
          
          if (!existing || cycleTime === traderCycle) {
            discovered.set(nick, {
              traderUid: row.traderUid,
              winningRate: parseNum(row.winningRate),
              cycleTime,
            })
            matchCount++
          }
        }
        totalFound++
      }
      
      if (matchCount > 0) {
        console.log(`  Page ${pageNo}: found ${rows.length} traders, ${matchCount} matches (total discovered: ${discovered.size})`)
      }
      
      const nextFlag = data?.data?.nextFlag
      if (!nextFlag) {
        console.log(`  Page ${pageNo}: last page (${totalFound} total traders scanned)`)
        break
      }
      
      pageNo++
      await sleep(300)
      
      if (pageNo > 200) {
        console.log(`  ⚠️  Stopping at page 200 to avoid infinite loop`)
        break
      }
    }
    
    if (discovered.size >= nonHexTraders.length) {
      console.log(`✅ Found all ${discovered.size} traders, stopping early`)
      break
    }
  }
  
  console.log(`\n📊 Discovery summary: ${discovered.size}/${nonHexTraders.length} traders found in traderList`)
  
  const notFound = nonHexTraders.filter(t => !discovered.has(t.id.toLowerCase()))
  if (notFound.length > 0) {
    console.log(`Not found (${notFound.length}):`, notFound.map(t => t.id).slice(0, 10))
  }
  
  // Now enrich the discovered traders
  let updated = 0, noData = 0, errors = 0
  let apiCalls = 0
  
  for (const trader of nonHexTraders) {
    const nick = trader.id.toLowerCase()
    const disc = discovered.get(nick)
    
    if (!disc) {
      console.log(`  ⏭️  ${trader.id}: not found in traderList`)
      noData++
      continue
    }
    
    process.stdout.write(`  ${trader.id.slice(0, 20)}... uid=${disc.traderUid} `)
    
    // Get win_rate from traderList data
    let winRate = disc.winningRate
    let maxDD = null
    
    // Get max_drawdown via cycleData
    if (trader.needMDD && disc.traderUid) {
      const resp = await fetchCycleData(page, String(disc.traderUid), disc.cycleTime)
      apiCalls++
      if (resp.data?.code === '00000') {
        const stats = resp.data?.data?.statisticsDTO
        if (stats) {
          maxDD = parseNum(stats.maxRetracement)
          // Also get winRate from cycleData for consistency
          if (stats.winningRate !== undefined) winRate = parseNum(stats.winningRate)
        }
      }
      await sleep(400)
    }
    
    const updates = {}
    if (trader.needWR && winRate !== null) updates.win_rate = winRate
    if (trader.needMDD && maxDD !== null) updates.max_drawdown = maxDD
    
    process.stdout.write(`wr=${winRate ?? '-'} mdd=${maxDD ?? '-'} `)
    
    if (Object.keys(updates).length === 0) {
      process.stdout.write(`⚠️  no updates\n`)
      noData++
      continue
    }
    
    if (!DRY_RUN) {
      const { error: upErr } = await sb
        .from('trader_snapshots')
        .update(updates)
        .eq('source', 'bitget_futures')
        .eq('source_trader_id', trader.id)

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
    
    await sleep(DELAY_MS)
  }
  
  await browser.close()
  
  const { count: afterNullWR } = await sb.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', 'bitget_futures').is('win_rate', null)
  const { count: afterNullMDD } = await sb.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', 'bitget_futures').is('max_drawdown', null)
  
  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ Non-hex enrichment done: updated=${updated} noData=${noData} errors=${errors}`)
  console.log(`📊 NULL win_rate: → ${afterNullWR}`)
  console.log(`📊 NULL max_drawdown: → ${afterNullMDD}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
