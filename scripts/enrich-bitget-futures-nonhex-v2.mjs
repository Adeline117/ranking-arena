#!/usr/bin/env node
/**
 * enrich-bitget-futures-nonhex-v2.mjs
 * Third pass: match non-hex traders by paginating traderList.
 * For each match, use cycleData with numeric traderUid.
 * Also: skip garbage entries (currency codes, etc.)
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
const BATCH_PAGES = parseInt(args.find(a => a.startsWith('--pages='))?.split('=')[1] || '30')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const parseNum = v => { if (v == null) return null; const n = parseFloat(v); return isNaN(n) ? null : n }

// Garbage entries that should be skipped (not real traders)
const GARBAGE_IDS = new Set([
  '30d max drawdown', 'Activity', 'Achievement', 'AED', 'ARS', 'AUD',
  'BRL', 'EUR', 'GBP', 'HKD', 'IDR', 'INR', 'MXN', 'MYR', 'NGN',
  'PKR', 'PLN', 'php', 'rub', 'try', 'UAH', 'USD', 'UZS', 'vnd',
  'CNY', 'JPY', 'KRW', 'CHF', 'CAD', 'THB', 'VND',
])

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
  await sleep(2000)
  return { browser, page }
}

async function inPageFetch(page, path, body) {
  try {
    return await Promise.race([
      page.evaluate(async ({ path, body }) => {
        try {
          const r = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
          const text = await r.text()
          if (!text || text.trim().length < 5 || text.startsWith('<')) return { status: r.status, error: 'empty/html' }
          return { status: r.status, data: JSON.parse(text) }
        } catch(e) { return { error: e.toString() } }
      }, { path, body }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000)),
    ])
  } catch(e) {
    return { error: e.message, closed: true }
  }
}

async function main() {
  console.log(`🔄 Bitget Futures non-hex enrichment v2`)
  console.log(`   DRY_RUN: ${DRY_RUN} | BATCH_PAGES: ${BATCH_PAGES}`)

  // Get all non-hex traders with NULLs
  const { data: allRows } = await sb
    .from('trader_snapshots')
    .select('source_trader_id, win_rate, max_drawdown, season_id')
    .eq('source', 'bitget_futures')
    .or('win_rate.is.null,max_drawdown.is.null')
    .limit(5000)

  const seen = new Map()
  for (const r of allRows) {
    const id = r.source_trader_id
    if (/^[a-f0-9]{16,}$/i.test(id)) continue
    if (GARBAGE_IDS.has(id)) continue // skip garbage
    if (!seen.has(id)) {
      seen.set(id, { id, season: r.season_id, needWR: r.win_rate === null, needMDD: r.max_drawdown === null })
    } else {
      const e = seen.get(id)
      if (r.win_rate === null) e.needWR = true
      if (r.max_drawdown === null) e.needMDD = true
    }
  }

  const nonHexTraders = [...seen.values()]
  const nameMap = new Map(nonHexTraders.map(t => [t.id.toLowerCase(), t]))
  const nameMapBGUSER = new Map()
  for (const t of nonHexTraders) {
    // Also match without @prefix
    const stripped = t.id.replace(/^@/, '').toLowerCase()
    if (!nameMap.has(stripped)) nameMapBGUSER.set(stripped, t)
  }
  
  console.log(`\nReal non-hex traders to enrich: ${nonHexTraders.length}`)
  
  const { browser, page } = await launchBrowser()
  console.log(`🌐 Browser ready\n`)
  
  // Map: lowercaseName → { traderUid, winningRate, cycleTime }
  const discovered = new Map()
  
  const START_PAGE = parseInt(args.find(a => a.startsWith('--start-page='))?.split('=')[1] || '1')
  
  for (const cycleTime of [30, 7, 90]) {
    if (discovered.size >= nonHexTraders.length) break
    console.log(`📋 Scanning traderList cycleTime=${cycleTime}, pages ${START_PAGE}-${START_PAGE + BATCH_PAGES - 1}...`)
    
    for (let pageNo = START_PAGE; pageNo < START_PAGE + BATCH_PAGES; pageNo++) {
      const resp = await inPageFetch(page, '/v1/trigger/trace/public/traderList', {
        languageType: 0, productType: 'USDT-FUTURES', cycleTime, pageNo, pageSize: 50
      })
      
      if (resp.error || resp.closed) {
        console.log(`  Page ${pageNo}: ${resp.error}`)
        if (resp.closed) {
          console.log('  Browser closed, aborting pagination')
          break
        }
        continue
      }
      
      const data = resp.data
      if (data?.code !== '00000') {
        console.log(`  Page ${pageNo}: code=${data?.code}`)
        break
      }
      
      const rows = data?.data?.rows || []
      if (rows.length === 0) break
      
      for (const row of rows) {
        const nick = (row.traderNickName || row.userName || '').toLowerCase()
        const uid = String(row.traderUid)
        const wr = parseNum(row.winningRate)
        
        const match = nameMap.get(nick) || nameMapBGUSER.get(nick)
        if (match && !discovered.has(match.id.toLowerCase())) {
          discovered.set(match.id.toLowerCase(), { traderUid: uid, winningRate: wr, cycleTime })
        }
      }
      
      if (!data?.data?.nextFlag) break
      await sleep(250)
    }
    
    console.log(`  Found so far: ${discovered.size}/${nonHexTraders.length}`)
    await sleep(500)
  }
  
  console.log(`\n📊 Discovered: ${discovered.size}/${nonHexTraders.length}`)
  
  // Now enrich discovered traders using cycleData
  let updated = 0, noData = 0, errors = 0, apiCalls = 0
  
  for (const trader of nonHexTraders) {
    const disc = discovered.get(trader.id.toLowerCase())
    
    if (!disc) {
      noData++
      continue
    }
    
    process.stdout.write(`  ${trader.id.slice(0, 22).padEnd(22)} uid=${disc.traderUid} `)
    
    // Try cycleData with numeric UID
    let winRate = disc.winningRate
    let maxDD = null
    
    const resp = await inPageFetch(page, '/v1/trigger/trace/public/cycleData', {
      languageType: 0, triggerUserId: disc.traderUid, cycleTime: disc.cycleTime
    })
    apiCalls++
    
    if (resp.data?.code === '00000') {
      const stats = resp.data?.data?.statisticsDTO
      if (stats) {
        const wr2 = parseNum(stats.winningRate)
        const mdd2 = parseNum(stats.maxRetracement)
        if (wr2 !== null) winRate = wr2
        if (mdd2 !== null) maxDD = mdd2
      }
    }
    
    const updates = {}
    if (trader.needWR && winRate !== null) updates.win_rate = winRate
    if (trader.needMDD && maxDD !== null) updates.max_drawdown = maxDD
    
    process.stdout.write(`wr=${winRate ?? '-'} mdd=${maxDD ?? '-'} `)
    
    if (Object.keys(updates).length === 0) {
      process.stdout.write(`⚠️  no data\n`)
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
    
    await sleep(500)
  }
  
  await browser.close()
  
  const { count: afterNullWR } = await sb.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', 'bitget_futures').is('win_rate', null)
  const { count: afterNullMDD } = await sb.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', 'bitget_futures').is('max_drawdown', null)
  
  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ Done: updated=${updated} noData=${noData} errors=${errors}`)
  console.log(`📊 NULL win_rate: → ${afterNullWR}`)
  console.log(`📊 NULL max_drawdown: → ${afterNullMDD}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
