#!/usr/bin/env node
/**
 * enrich-bitget-futures-profile.mjs
 * Visit each non-hex trader's profile page, intercept API calls to get hex ID,
 * then use cycleData to get win_rate and max_drawdown.
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
const LIMIT = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '25')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const parseNum = v => { if (v == null) return null; const n = parseFloat(v); return isNaN(n) ? null : n }

const GARBAGE_IDS = new Set([
  '30d max drawdown', 'Activity', 'Achievement', 'AED', 'ARS', 'AUD',
  'BRL', 'EUR', 'GBP', 'HKD', 'IDR', 'INR', 'MXN', 'MYR', 'NGN',
  'PKR', 'PLN', 'php', 'rub', 'try', 'UAH', 'USD', 'UZS', 'vnd',
])

async function launchBrowser() {
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
  })
  return { browser, ctx }
}

async function fetchPageWithIntercept(ctx, traderId, cycleTime) {
  const page = await ctx.newPage()
  await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,css}', r => r.abort())
  
  let hexId = null
  let cycleDataResult = null
  
  // Intercept responses to find cycleData with hex ID
  page.on('response', async r => {
    const url = r.url()
    if (url.includes('/cycleData') || url.includes('/traderView')) {
      try {
        const text = await r.text()
        if (text.includes('statisticsDTO') || text.includes('triggerUserId')) {
          const data = JSON.parse(text)
          if (data?.data?.statisticsDTO) {
            cycleDataResult = data.data.statisticsDTO
          }
        }
      } catch(e) {}
    }
  })
  
  page.on('request', req => {
    const url = req.url()
    if (url.includes('/cycleData')) {
      try {
        const body = req.postData()
        if (body) {
          const parsed = JSON.parse(body)
          if (parsed.triggerUserId && /^[a-f0-9]{16,}$/i.test(parsed.triggerUserId)) {
            hexId = parsed.triggerUserId
          }
        }
      } catch(e) {}
    }
  })
  
  // Navigate to trader detail page
  const url = `https://www.bitget.com/copy-trading/futures/trade-center/detail?traderId=${encodeURIComponent(traderId)}`
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await sleep(4000) // Wait for API calls
  } catch(e) {
    // ignore navigation errors
  }
  
  // If no cycleData intercepted, try in-page fetch
  if (!cycleDataResult && hexId) {
    try {
      const resp = await page.evaluate(async ({ hexId, cycleTime }) => {
        const r = await fetch('/v1/trigger/trace/public/cycleData', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ languageType: 0, triggerUserId: hexId, cycleTime }),
        })
        const text = await r.text()
        return JSON.parse(text)
      }, { hexId, cycleTime })
      if (resp?.data?.statisticsDTO) cycleDataResult = resp.data.statisticsDTO
    } catch(e) {}
  }
  
  // If still no data, try in-page fetch with traderId as the ID
  if (!cycleDataResult) {
    try {
      const resp = await page.evaluate(async ({ traderId, cycleTime }) => {
        const r = await fetch('/v1/trigger/trace/public/cycleData', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ languageType: 0, triggerUserId: traderId, cycleTime }),
        })
        const text = await r.text()
        return JSON.parse(text)
      }, { traderId, cycleTime })
      if (resp?.code === '00000' && resp?.data?.statisticsDTO) cycleDataResult = resp.data.statisticsDTO
    } catch(e) {}
  }
  
  await page.close()
  
  return {
    hexId,
    winRate: parseNum(cycleDataResult?.winningRate),
    maxDD: parseNum(cycleDataResult?.maxRetracement),
  }
}

async function main() {
  console.log(`🔄 Profile-based enrichment for non-hex traders`)
  console.log(`   DRY_RUN: ${DRY_RUN} | LIMIT: ${LIMIT}`)

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
    if (GARBAGE_IDS.has(id)) continue
    if (!seen.has(id)) {
      seen.set(id, { id, season: r.season_id, needWR: r.win_rate === null, needMDD: r.max_drawdown === null })
    } else {
      const e = seen.get(id)
      if (r.win_rate === null) e.needWR = true
      if (r.max_drawdown === null) e.needMDD = true
    }
  }

  const traders = [...seen.values()].slice(0, LIMIT)
  console.log(`Processing ${traders.length} non-hex traders via profile pages\n`)

  const { browser, ctx } = await launchBrowser()
  
  let updated = 0, noData = 0, errors = 0
  
  for (let i = 0; i < traders.length; i++) {
    const trader = traders[i]
    const cycleTime = trader.season?.startsWith('7') ? 7 : trader.season?.startsWith('90') ? 90 : 30
    
    process.stdout.write(`  [${i+1}/${traders.length}] ${trader.id.slice(0, 20).padEnd(20)} cycle=${cycleTime} `)
    
    const { hexId, winRate, maxDD } = await fetchPageWithIntercept(ctx, trader.id, cycleTime)
    
    process.stdout.write(`hexId=${hexId?.slice(0,10) ?? 'none'} wr=${winRate ?? '-'} mdd=${maxDD ?? '-'} `)
    
    const updates = {}
    if (trader.needWR && winRate !== null) updates.win_rate = winRate
    if (trader.needMDD && maxDD !== null) updates.max_drawdown = maxDD
    
    if (Object.keys(updates).length === 0) {
      process.stdout.write(`⚠️  no data\n`)
      noData++
    } else {
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
