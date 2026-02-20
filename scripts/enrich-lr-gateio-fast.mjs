#!/usr/bin/env node
/**
 * Gate.io leaderboard_ranks WR/MDD enricher — fast version
 * Uses single browser session + in-page fetch() to avoid per-page overhead
 */
import { chromium } from 'playwright'
import { getSupabaseClient, sleep } from './lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'gateio'

async function main() {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Gate.io — Fast WR/MDD Enricher`)
  console.log(`${'='.repeat(60)}`)

  // Fetch all rows needing enrichment
  const { data: allRows, error } = await supabase
    .from('leaderboard_ranks')
    .select('id, source_trader_id, season_id, win_rate, max_drawdown, trades_count')
    .eq('source', SOURCE)
    .or('win_rate.is.null,max_drawdown.is.null')

  if (error) { console.error('DB error:', error.message); process.exit(1) }
  console.log(`Need enrichment: ${allRows.length} rows`)
  if (!allRows.length) return

  // Build lookup by trader ID
  const byTrader = new Map()
  for (const r of allRows) {
    if (!byTrader.has(r.source_trader_id)) byTrader.set(r.source_trader_id, [])
    byTrader.get(r.source_trader_id).push(r)
  }
  const traderIds = [...byTrader.keys()]
  const numericIds = traderIds.filter(t => /^\d+$/.test(t))
  const ctaIds = traderIds.filter(t => !(/^\d+$/.test(t)))
  console.log(`Unique traders: ${traderIds.length} (numeric: ${numericIds.length}, cta: ${ctaIds.length})`)

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })

  // Navigate once to get session cookies
  console.log('\nEstablishing Gate.io session...')
  const page = await context.newPage()

  // Capture all copy-trading API responses that come in during leaderboard browse
  const capturedData = new Map() // leaderId -> { wr, mdd, tc, cycle }
  let capturedApiBase = null

  page.on('response', async (res) => {
    const url = res.url()
    if (res.status() !== 200) return
    if (!url.includes('gate.') && !url.includes('gateio')) return
    if (!url.includes('copy') && !url.includes('leader') && !url.includes('trader')) return

    try {
      const ct = res.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const j = await res.json()

      // Extract API base for later use
      if (!capturedApiBase && url.includes('/api/')) {
        const m = url.match(/(https?:\/\/[^/]+\/api\/v\d+)/)
        if (m) capturedApiBase = m[1]
      }

      // Parse list responses
      const list = j?.data?.list || j?.data?.rows || (Array.isArray(j?.data) ? j.data : null) || j?.list
      if (Array.isArray(list) && list.length > 0) {
        const cycleMatch = url.match(/cycle[=:](\w+)/)
        const cycle = cycleMatch ? cycleMatch[1] : 'month'
        const season = cycle === 'week' ? '7D' : cycle === 'quarter' ? '90D' : '30D'

        for (const t of list) {
          const id = String(t.leader_id || t.id || t.user_id || '')
          if (!id || id === '0') continue

          let wr = t.win_rate ?? t.winRate ?? t.win_ratio
          let mdd = t.max_drawdown ?? t.maxDrawdown ?? t.max_retrace
          let tc = t.order_count ?? t.orderCount ?? t.trade_count ?? t.tradeCount

          if (wr != null) { wr = parseFloat(wr); if (wr > 0 && wr <= 1) wr *= 100 }
          if (mdd != null) { mdd = Math.abs(parseFloat(mdd)); if (mdd > 0 && mdd <= 1) mdd *= 100 }
          if (tc != null) tc = parseInt(tc)

          if (!capturedData.has(id)) capturedData.set(id, {})
          const entry = capturedData.get(id)
          if (!entry[season] || (wr != null && entry[season].wr == null)) {
            entry[season] = { wr, mdd, tc }
          }

          // Also capture username -> id mapping
          const name = t.user_name || t.userName || t.nickname || t.name || ''
          if (name) {
            const ctaKey = `cta_${name.toLowerCase()}`
            if (!capturedData.has(ctaKey)) {
              capturedData.set(ctaKey, capturedData.get(id))
            }
          }
        }
        if (list.length > 0) console.log(`  API: ${url.split('?')[0].slice(-60)} → ${list.length} traders`)
      }

      // Parse single trader detail response
      const d = j?.data
      if (d && typeof d === 'object' && !Array.isArray(d)) {
        const id = String(d.leader_id || d.id || d.user_id || '')
        if (id && id !== '0') {
          let wr = d.win_rate ?? d.winRate ?? d.win_ratio
          let mdd = d.max_drawdown ?? d.maxDrawdown ?? d.max_retrace
          let tc = d.order_count ?? d.orderCount ?? d.trade_count ?? d.tradeCount

          if (wr != null) { wr = parseFloat(wr); if (wr > 0 && wr <= 1) wr *= 100 }
          if (mdd != null) { mdd = Math.abs(parseFloat(mdd)); if (mdd > 0 && mdd <= 1) mdd *= 100 }
          if (tc != null) tc = parseInt(tc)

          if (wr != null || mdd != null) {
            if (!capturedData.has(id)) capturedData.set(id, {})
            const entry = capturedData.get(id)
            // Apply to all seasons
            for (const s of ['7D', '30D', '90D']) {
              if (!entry[s]) entry[s] = { wr, mdd, tc }
            }
          }
        }
      }
    } catch {}
  })

  // Navigate to Gate.io copy trading to establish session & capture bulk data
  try {
    await page.goto('https://www.gate.io/copytrading', { waitUntil: 'networkidle', timeout: 30000 })
    await sleep(3000)
  } catch {}

  // Also try gate.com
  try {
    await page.goto('https://www.gate.com/copytrading', { waitUntil: 'networkidle', timeout: 30000 })
    await sleep(3000)
  } catch {}

  console.log(`After initial nav: ${capturedData.size} traders with data`)

  // Try browsing different sort orders and cycles to capture more bulk data
  const cycles = ['month', 'week', 'quarter']
  const orderBys = ['profit_rate', 'win_rate', 'max_drawdown', 'aum']
  for (const cycle of cycles) {
    for (const ob of orderBys) {
      for (let pg = 1; pg <= 10; pg++) {
        const url = `https://www.gate.com/copytrading?order_by=${ob}&sort_by=desc&cycle=${cycle}&page=${pg}`
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
          await sleep(2500)
          const prev = capturedData.size
          await sleep(1000)
          if (capturedData.size === prev && pg > 2) break
        } catch { break }
      }
    }
    console.log(`  After ${cycle} cycle: ${capturedData.size} traders`)
  }

  // ── Strategy 2: For numeric IDs still missing, use in-page fetch() ──
  const missingNumerics = numericIds.filter(id => {
    const d = capturedData.get(id)
    return !d || Object.keys(d).length === 0
  })
  console.log(`\nMissing numeric IDs after bulk scrape: ${missingNumerics.length}`)

  if (missingNumerics.length > 0) {
    // First: try to find the API URL by intercepting an existing detail page
    console.log('Finding Gate.io detail API URL...')
    
    // Try navigating to a known trader detail page to get API URL
    const testId = missingNumerics[0]
    const detailCapture = []
    
    const detailCb = async (res) => {
      const url = res.url()
      if (res.status() !== 200) return
      if (url.includes('copy') || url.includes('leader') || url.includes('trader')) {
        detailCapture.push({ url, status: res.status() })
      }
    }
    page.on('response', detailCb)
    
    try {
      await page.goto(`https://www.gate.io/copytrading/trader/${testId}`, { waitUntil: 'networkidle', timeout: 25000 })
      await sleep(3000)
    } catch {}
    
    console.log(`  Detail page API calls: ${detailCapture.map(d => d.url.slice(-80)).join('\n  ')}`)
    
    // Now try in-page fetch for each missing numeric ID
    for (let i = 0; i < missingNumerics.length; i++) {
      const traderId = missingNumerics[i]
      if ((i + 1) % 10 === 0) console.log(`  Fetching numeric ${i + 1}/${missingNumerics.length}`)

      try {
        // Navigate to the trader detail page (fastest way to trigger the API)
        const detailPage = await context.newPage()
        let stats = null

        detailPage.on('response', async (res) => {
          const url = res.url()
          if (res.status() !== 200) return
          if (!url.includes('copy') && !url.includes('leader') && !url.includes('trader')) return
          try {
            const ct = res.headers()['content-type'] || ''
            if (!ct.includes('json')) return
            const j = await res.json()
            const d = j?.data
            if (!d || typeof d !== 'object') return

            let wr = d.win_rate ?? d.winRate ?? d.win_ratio
            let mdd = d.max_drawdown ?? d.maxDrawdown ?? d.max_retrace
            let tc = d.order_count ?? d.orderCount ?? d.trade_count

            if (wr != null) { wr = parseFloat(wr); if (wr > 0 && wr <= 1) wr *= 100 }
            if (mdd != null) { mdd = Math.abs(parseFloat(mdd)); if (mdd > 0 && mdd <= 1) mdd *= 100 }
            if (tc != null) tc = parseInt(tc)

            if (wr != null || mdd != null) {
              stats = { wr, mdd, tc }
            }
          } catch {}
        })

        await detailPage.goto(`https://www.gate.io/copytrading/trader/${traderId}`, {
          waitUntil: 'domcontentloaded', timeout: 15000
        }).catch(() => {})
        await sleep(3000)
        await detailPage.close()

        if (stats) {
          if (!capturedData.has(traderId)) capturedData.set(traderId, {})
          const entry = capturedData.get(traderId)
          for (const s of ['7D', '30D', '90D']) {
            if (!entry[s]) entry[s] = { wr: stats.wr, mdd: stats.mdd, tc: stats.tc }
          }
        }
      } catch {}
      await sleep(1000)
    }
  }

  // ── Strategy 3: For cta_ IDs, extract username and navigate to profile ──
  const missingCtas = ctaIds.filter(id => {
    const d = capturedData.get(id)
    return !d || Object.keys(d).length === 0
  })
  console.log(`\nMissing cta IDs: ${missingCtas.length}`)

  for (let i = 0; i < missingCtas.length; i++) {
    const ctaId = missingCtas[i]
    const username = ctaId.replace(/^cta_/, '')
    if ((i + 1) % 5 === 0) console.log(`  CTA ${i + 1}/${missingCtas.length}: ${ctaId}`)

    try {
      const ctaPage = await context.newPage()
      let stats = null

      ctaPage.on('response', async (res) => {
        const url = res.url()
        if (res.status() !== 200) return
        if (!url.includes('copy') && !url.includes('leader') && !url.includes('trader')) return
        try {
          const ct = res.headers()['content-type'] || ''
          if (!ct.includes('json')) return
          const j = await res.json()
          const d = j?.data
          if (!d) return

          // Check detail response
          let wr = d.win_rate ?? d.winRate ?? d.win_ratio
          let mdd = d.max_drawdown ?? d.maxDrawdown ?? d.max_retrace
          let tc = d.order_count ?? d.orderCount ?? d.trade_count

          if (wr != null) { wr = parseFloat(wr); if (wr > 0 && wr <= 1) wr *= 100 }
          if (mdd != null) { mdd = Math.abs(parseFloat(mdd)); if (mdd > 0 && mdd <= 1) mdd *= 100 }
          if (tc != null) tc = parseInt(tc)

          if (wr != null || mdd != null) {
            stats = { wr, mdd, tc }
          }

          // Also check if response has leader_id for future use
          const leaderId = String(d.leader_id || d.id || d.user_id || '')
          if (leaderId && (wr != null || mdd != null)) {
            if (!capturedData.has(leaderId)) capturedData.set(leaderId, {})
            const entry = capturedData.get(leaderId)
            for (const s of ['7D', '30D', '90D']) {
              if (!entry[s]) entry[s] = { wr, mdd, tc }
            }
          }
        } catch {}
      })

      await ctaPage.goto(`https://www.gate.io/copytrading/trader/${username}`, {
        waitUntil: 'domcontentloaded', timeout: 15000
      }).catch(() => {})
      await sleep(3000)
      await ctaPage.close()

      if (stats) {
        if (!capturedData.has(ctaId)) capturedData.set(ctaId, {})
        const entry = capturedData.get(ctaId)
        for (const s of ['7D', '30D', '90D']) {
          if (!entry[s]) entry[s] = { wr: stats.wr, mdd: stats.mdd, tc: stats.tc }
        }
      }
    } catch {}
    await sleep(1000)
  }

  await browser.close()
  console.log(`\nTotal traders with data: ${capturedData.size}`)

  // ── Update DB ──
  let updated = 0
  for (const [traderId, seasons] of capturedData) {
    const rows = byTrader.get(traderId)
    if (!rows) continue

    for (const row of rows) {
      const season = row.season_id
      const data = seasons[season] || seasons['30D'] || Object.values(seasons)[0]
      if (!data) continue

      const updates = {}
      if (row.win_rate == null && data.wr != null && !isNaN(data.wr)) updates.win_rate = parseFloat(data.wr.toFixed(2))
      if (row.max_drawdown == null && data.mdd != null && !isNaN(data.mdd)) updates.max_drawdown = parseFloat(data.mdd.toFixed(2))
      if (row.trades_count == null && data.tc != null && !isNaN(data.tc)) updates.trades_count = data.tc

      if (Object.keys(updates).length === 0) continue

      const { error } = await supabase.from('leaderboard_ranks').update(updates).eq('id', row.id)
      if (!error) {
        updated++
        console.log(`  ✓ ${traderId} ${season}: wr=${updates.win_rate} mdd=${updates.max_drawdown}`)
      } else {
        console.error(`  ✗ ${traderId}: ${error.message}`)
      }
    }
  }

  console.log(`\n✅ Updated: ${updated}`)

  // Final verification
  const { count: total } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE)
  const { count: wrNull } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('win_rate', null)
  const { count: mddNull } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('max_drawdown', null)
  console.log(`\nFinal: total=${total} wr_null=${wrNull} mdd_null=${mddNull}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
