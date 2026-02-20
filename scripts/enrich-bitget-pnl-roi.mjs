#!/usr/bin/env node
/**
 * Enrich Bitget Futures PNL + ROI via Playwright
 * Calls cycleData API directly to get profit and profitRate per season
 * 
 * Usage: node scripts/enrich-bitget-pnl-roi.mjs [--limit=200]
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
const LIMIT = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '200')
const SOURCE = 'bitget_futures'
const CYCLE_MAP = { '7D': 7, '30D': 30, '90D': 90 }

const sleep = ms => new Promise(r => setTimeout(r, ms))
const parseNum = v => { if (v == null) return null; const n = parseFloat(v); return isNaN(n) ? null : n }

async function main() {
  console.log(`🔄 Bitget Futures PNL+ROI Enrichment (limit=${LIMIT})`)

  // Get all rows with pnl=0 or roi=0
  const { data: rows, error } = await sb.from('leaderboard_ranks')
    .select('id, source_trader_id, season_id, pnl, roi')
    .eq('source', SOURCE)
    .or('pnl.eq.0,roi.eq.0')
    .order('id', { ascending: false })
  
  if (error) { console.error('Query error:', error.message); process.exit(1) }

  // Group by source_trader_id, collect all seasons needed
  const traderSeasons = new Map() // source_trader_id -> Set<season_id>
  for (const r of rows) {
    if (!r.source_trader_id || !/^[a-f0-9]{10,}$/i.test(r.source_trader_id)) continue
    if (!traderSeasons.has(r.source_trader_id)) traderSeasons.set(r.source_trader_id, new Set())
    traderSeasons.get(r.source_trader_id).add(r.season_id)
  }

  const traderList = [...traderSeasons.entries()].slice(0, LIMIT)
  console.log(`Found ${rows.length} rows with pnl=0/roi=0 across ${traderSeasons.size} unique traders`)
  console.log(`Processing ${traderList.length} traders`)
  if (!traderList.length) { console.log('Nothing to do'); process.exit(0) }

  const browser = await chromium.launch({ 
    headless: true,
    args: ['--proxy-server=http://127.0.0.1:7890']
  })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  const page = await ctx.newPage()
  await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2}', r => r.abort())

  // Navigate to bitget to get cookies
  console.log('🌐 Getting Bitget cookies...')
  await page.goto('https://www.bitget.com/copy-trading/futures', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  await sleep(3000)
  console.log('✅ Browser ready\n')

  let enriched = 0, failed = 0, apiCalls = 0

  for (let i = 0; i < traderList.length; i++) {
    const [tid, seasons] = traderList[i]
    
    for (const season of seasons) {
      const cycleTime = CYCLE_MAP[season]
      if (!cycleTime) continue
      
      process.stdout.write(`[${i+1}/${traderList.length}] ${tid.slice(0,10)} ${season} `)
      apiCalls++

      try {
        const result = await page.evaluate(async (args) => {
          try {
            const r = await fetch('/v1/trigger/trace/public/cycleData', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ languageType: 0, triggerUserId: args.id, cycleTime: args.c }),
            })
            const text = await r.text()
            if (text.startsWith('<')) return null
            return JSON.parse(text)
          } catch { return null }
        }, { id: tid, c: cycleTime })

        if (result?.code === '00000' && result.data?.statisticsDTO) {
          const stats = result.data.statisticsDTO
          const pnl = parseNum(stats.profit)
          const roi = parseNum(stats.profitRate)

          if (pnl != null || roi != null) {
            const updates = {}
            if (pnl != null) updates.pnl = pnl
            if (roi != null) updates.roi = roi

            const { error: upErr } = await sb.from('leaderboard_ranks')
              .update(updates)
              .eq('source', SOURCE)
              .eq('source_trader_id', tid)
              .eq('season_id', season)

            if (upErr) {
              console.log(`❌ ${upErr.message}`)
              failed++
            } else {
              console.log(`✅ PNL=${pnl?.toFixed(2)} ROI=${roi?.toFixed(2)}%`)
              enriched++
            }
          } else {
            console.log('⚠️ null values')
            failed++
          }
        } else {
          console.log(`⚠️ code=${result?.code || 'null'}`)
          failed++
        }
      } catch (e) {
        console.log(`❌ ${e.message?.slice(0, 60)}`)
        failed++
      }

      await sleep(800 + Math.random() * 400)
      
      // Re-navigate every 100 API calls to refresh session
      if (apiCalls % 100 === 0) {
        console.log('  🔄 Refreshing session...')
        await page.goto('https://www.bitget.com/copy-trading/futures', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
        await sleep(2000)
      }
    }
  }

  await browser.close()

  console.log(`\n${'='.repeat(50)}`)
  console.log(`Done: ${enriched} enriched, ${failed} failed, ${apiCalls} API calls`)

  // Verify
  const { count: total } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE)
  const { count: pnlZero } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).eq('pnl', 0)
  const { count: roiZero } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).eq('roi', 0)
  console.log(`\n📊 Before: total=877 pnl=0: 623 roi=0: 517`)
  console.log(`📊 After:  total=${total} pnl=0: ${pnlZero} roi=0: ${roiZero}`)
}

main().catch(e => { console.error(e); process.exit(1) })
