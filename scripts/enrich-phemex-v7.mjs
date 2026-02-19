#!/usr/bin/env node
/**
 * Phemex Enrichment v7 - Playwright pagination with route interception
 * Collects win_rate, max_drawdown from list API, then individual profiles for remaining
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  console.log('🚀 Phemex Enrichment v7\n')

  // 1. Get all phemex rows needing enrichment
  let allRows = []
  let offset = 0
  while (true) {
    const { data, error } = await sb
      .from('leaderboard_ranks')
      .select('id, source_trader_id, win_rate, max_drawdown')
      .eq('source', 'phemex')
      .or('win_rate.is.null,max_drawdown.is.null')
      .range(offset, offset + 999)
    if (error) { console.error('DB error:', error.message); break }
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }

  const neededIds = new Set(allRows.map(r => r.source_trader_id))
  console.log(`Rows needing enrichment: ${allRows.length}`)
  console.log(`Unique trader IDs needed: ${neededIds.size}\n`)

  // 2. Launch browser and collect data from list pages
  const enrichMap = new Map() // traderId -> { wr, mdd }

  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  })

  const page = await ctx.newPage()

  // Intercept list API responses
  page.on('response', async (resp) => {
    if (!resp.url().includes('v3/user/recommend') || resp.status() !== 200) return
    try {
      const d = await resp.json()
      if (!d?.data?.rows) return
      for (const r of d.data.rows) {
        const uid = String(r.userId)
        // Pick best available win rate (prefer 90d)
        let wr = null
        for (const f of ['tradeWinRate90d', 'tradeWinRate30d', 'tradeWinRate180d']) {
          if (r[f] != null && r[f] !== '') {
            const v = parseFloat(r[f])
            if (!isNaN(v)) { wr = Math.round(v * 10000) / 100; break }
          }
        }
        // Pick best MDD (prefer 90d)
        let mdd = null
        for (const f of ['mdd90d', 'mdd30d', 'mdd180d']) {
          if (r[f] != null && r[f] !== '') {
            const v = parseFloat(r[f])
            if (!isNaN(v)) { mdd = Math.round(Math.abs(v) * 10000) / 100; break }
          }
        }
        if (wr != null || mdd != null) {
          enrichMap.set(uid, { wr, mdd })
        }
      }
    } catch {}
  })

  // Load page
  await page.goto('https://phemex.com/copy-trading/list', { waitUntil: 'networkidle', timeout: 30000 })
  await sleep(3000)
  console.log(`After initial load: ${enrichMap.size} traders`)

  // Paginate by clicking next/pagination buttons
  let prevSize = 0
  let staleCount = 0
  for (let i = 0; i < 50; i++) {
    // Click next page
    try {
      const clicked = await page.evaluate(() => {
        // Find pagination next button
        const btns = document.querySelectorAll('button, [class*=page], [class*=Page], li, a, span')
        for (const el of btns) {
          const t = el.textContent?.trim()
          const cn = (el.className || '') + (el.getAttribute('aria-label') || '')
          if ((t === '›' || t === '>' || t === '»' || cn.toLowerCase().includes('next')) && !el.closest('[disabled]')) {
            el.click()
            return true
          }
        }
        return false
      })
      if (!clicked) {
        // Try keyboard right arrow or scroll
        await page.keyboard.press('ArrowRight')
      }
    } catch {}
    
    await sleep(2500)
    
    if (enrichMap.size === prevSize) {
      staleCount++
      if (staleCount >= 3) {
        console.log('No new data after 3 attempts, stopping pagination')
        break
      }
    } else {
      staleCount = 0
    }
    prevSize = enrichMap.size
    
    if ((i + 1) % 5 === 0) {
      console.log(`  Page ~${i + 1}: ${enrichMap.size} traders collected`)
    }
  }

  console.log(`\nList pages collected: ${enrichMap.size} traders`)

  // Check coverage
  let covered = 0
  for (const id of neededIds) {
    if (enrichMap.has(id)) covered++
  }
  console.log(`Coverage: ${covered}/${neededIds.size} needed traders found`)

  // 3. For remaining traders, try individual profile pages
  const remaining = [...neededIds].filter(id => !enrichMap.has(id))
  if (remaining.length > 0) {
    console.log(`\n=== Phase 2: Individual profiles for ${remaining.length} remaining traders ===`)
    
    const profilePage = await ctx.newPage()
    await profilePage.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,css}', route => route.abort())
    
    let found = 0, notFound = 0
    for (let i = 0; i < remaining.length; i++) {
      const uid = remaining[i]
      let captured = null
      
      const handler = async (resp) => {
        if (resp.status() !== 200) return
        const url = resp.url()
        if (!url.includes('phemex') || !url.includes('api')) return
        try {
          const text = await resp.text()
          if (text.includes('winRate') || text.includes('WinRate') || text.includes('mdd')) {
            captured = JSON.parse(text)
          }
        } catch {}
      }
      
      profilePage.on('response', handler)
      
      try {
        // Try different URL formats
        await profilePage.goto(`https://phemex.com/copy-trading/trader/${uid}`, { 
          waitUntil: 'domcontentloaded', timeout: 15000 
        })
        await sleep(3000)
      } catch {}
      
      profilePage.removeListener('response', handler)
      
      if (captured?.data) {
        const d = captured.data
        let wr = null, mdd = null
        for (const f of ['tradeWinRate90d', 'tradeWinRate30d', 'winRate', 'tradeWinRate180d']) {
          if (d[f] != null) { const v = parseFloat(d[f]); if (!isNaN(v)) { wr = Math.round(v * 10000) / 100; break } }
        }
        for (const f of ['mdd90d', 'mdd30d', 'maxDrawdown', 'mdd180d']) {
          if (d[f] != null) { const v = parseFloat(d[f]); if (!isNaN(v)) { mdd = Math.round(Math.abs(v) * 10000) / 100; break } }
        }
        if (wr != null || mdd != null) {
          enrichMap.set(uid, { wr, mdd })
          found++
        } else notFound++
      } else notFound++
      
      if ((i + 1) % 10 === 0) console.log(`  [${i+1}/${remaining.length}] found=${found} notFound=${notFound}`)
      
      // Stop if first 15 all fail
      if (i >= 15 && found === 0) {
        console.log('⛔ Profile pages not working, stopping')
        break
      }
      
      await sleep(1500)
    }
    console.log(`Phase 2: found=${found} notFound=${notFound}`)
  }
  
  await browser.close()

  // 4. Update database
  console.log(`\n📝 Updating DB with ${enrichMap.size} traders' data...`)
  
  let updated = 0
  for (const row of allRows) {
    const d = enrichMap.get(row.source_trader_id)
    if (!d) continue
    const u = {}
    if (row.win_rate == null && d.wr != null) u.win_rate = d.wr
    if (row.max_drawdown == null && d.mdd != null) u.max_drawdown = d.mdd
    if (Object.keys(u).length === 0) continue
    
    const { error } = await sb.from('leaderboard_ranks').update(u).eq('id', row.id)
    if (!error) updated++
    else console.error(`  Error updating ${row.id}:`, error.message)
  }
  console.log(`Updated ${updated}/${allRows.length} rows`)

  // Also update trader_snapshots
  let snapRows = []
  let off2 = 0
  while (true) {
    const { data } = await sb.from('trader_snapshots')
      .select('id, source_trader_id, win_rate, max_drawdown')
      .eq('source', 'phemex')
      .or('win_rate.is.null,max_drawdown.is.null')
      .range(off2, off2 + 999)
    if (!data?.length) break
    snapRows.push(...data)
    if (data.length < 1000) break
    off2 += 1000
  }
  
  let snapUpdated = 0
  for (const row of snapRows) {
    const d = enrichMap.get(row.source_trader_id)
    if (!d) continue
    const u = {}
    if (row.win_rate == null && d.wr != null) u.win_rate = d.wr
    if (row.max_drawdown == null && d.mdd != null) u.max_drawdown = d.mdd
    if (Object.keys(u).length === 0) continue
    const { error } = await sb.from('trader_snapshots').update(u).eq('id', row.id)
    if (!error) snapUpdated++
  }
  console.log(`Updated ${snapUpdated} trader_snapshots rows`)

  // 5. Verify
  console.log('\n📊 Verification:')
  const { count: total } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'phemex')
  const { count: wrN } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'phemex').is('win_rate', null)
  const { count: mddN } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'phemex').is('max_drawdown', null)
  console.log(`leaderboard_ranks: total=${total} wr_null=${wrN} mdd_null=${mddN}`)
}

main().catch(e => { console.error(e); process.exit(1) })
