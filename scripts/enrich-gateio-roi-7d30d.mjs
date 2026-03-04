#!/usr/bin/env node
/**
 * enrich-gateio-roi-7d30d.mjs
 * Enriches trader_snapshots with roi_7d and roi_30d for gateio traders
 * 
 * API: POST https://www.gate.com/apiw/v2/copy/api/leader/yield_curve
 * Body: {"leader_ids": [id1, id2, ...], "data_type": "seven"|"month"}
 * Returns daily cumulative profit_rate curves
 * 
 * Numeric source_trader_id = leader_id (can call yield_curve directly)
 * CTA source_trader_id = "cta_nickname" (need lookup via list API)
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const SOURCE = 'gateio'
const BASE = 'https://www.gate.com'
const BATCH_SIZE = 20 // leader_ids per API call

async function main() {
  console.log('═'.repeat(60))
  console.log('Gate.io — ROI 7d/30d Enricher (trader_snapshots)')
  console.log('═'.repeat(60))

  // Load all gateio snapshots that need roi_7d or roi_30d
  let allRows = [], offset = 0
  while (true) {
    const { data, error } = await sb.from('trader_snapshots')
      .select('id, source_trader_id, roi_7d, roi_30d')
      .eq('source', SOURCE)
      .or('roi_7d.is.null,roi_30d.is.null')
      .range(offset, offset + 999)
    if (error) { console.error('DB error:', error.message); break }
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }

  // Group by trader
  const traderMap = new Map()
  for (const r of allRows) {
    const key = String(r.source_trader_id)
    if (!traderMap.has(key)) traderMap.set(key, [])
    traderMap.get(key).push(r)
  }

  const numericIds = [...traderMap.keys()].filter(id => /^\d+$/.test(id))
  const ctaIds = [...traderMap.keys()].filter(id => id.startsWith('cta_'))
  
  console.log(`Total rows: ${allRows.length}, unique traders: ${traderMap.size}`)
  console.log(`Numeric IDs: ${numericIds.length}, CTA IDs: ${ctaIds.length}`)

  if (!traderMap.size) {
    console.log('Nothing to do!')
    return
  }

  // Launch browser
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
  })
  const page = await context.newPage()

  // Establish session
  console.log('\nEstablishing Gate.io session...')
  await page.goto(`${BASE}/copytrading`, { waitUntil: 'networkidle', timeout: 45000 }).catch(e => console.warn('  nav warn:', e.message))
  await sleep(5000)
  console.log('Session ready')

  // POST helper
  async function postYieldCurve(leaderIds, dataType) {
    try {
      return await page.evaluate(async ({ leaderIds, dataType, BASE }) => {
        try {
          const r = await fetch(`${BASE}/apiw/v2/copy/api/leader/yield_curve`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ leader_ids: leaderIds, data_type: dataType })
          })
          if (!r.ok) return null
          return await r.json()
        } catch { return null }
      }, { leaderIds, dataType, BASE })
    } catch { return null }
  }

  // Compute ROI from yield curve data (cumulative profit_rate series)
  function computeRoiFromCurve(curves) {
    if (!curves || !curves.length) return null
    // Find the most recent entry's profit_rate
    const sorted = [...curves].sort((a, b) => (b.create_time || 0) - (a.create_time || 0))
    const lastRate = parseFloat(sorted[0]?.profit_rate || '0')
    if (isNaN(lastRate)) return null
    // Convert to percentage
    const roi = Math.abs(lastRate) <= 1 ? lastRate * 100 : lastRate
    return parseFloat(roi.toFixed(4))
  }

  // Map: leaderId -> { roi7d, roi30d }
  const roiMap = new Map()

  // Phase 1: Numeric IDs via yield_curve POST API
  console.log(`\n── Phase 1: Numeric traders via yield_curve API (${numericIds.length} traders) ──`)
  const numericIntIds = numericIds.map(id => parseInt(id)).filter(id => !isNaN(id))

  let processed = 0
  for (let i = 0; i < numericIntIds.length; i += BATCH_SIZE) {
    const batch = numericIntIds.slice(i, i + BATCH_SIZE)
    
    // 7-day data
    const r7d = await postYieldCurve(batch, 'seven')
    if (r7d?.code === 0 && r7d.data?.list) {
      for (const item of r7d.data.list) {
        const id = String(item.leader_id)
        const roi = computeRoiFromCurve(item.leader_yield_curves)
        if (!roiMap.has(id)) roiMap.set(id, {})
        if (roi != null) roiMap.get(id).roi7d = roi
      }
    }
    
    // 30-day data
    const r30d = await postYieldCurve(batch, 'month')
    if (r30d?.code === 0 && r30d.data?.list) {
      for (const item of r30d.data.list) {
        const id = String(item.leader_id)
        const roi = computeRoiFromCurve(item.leader_yield_curves)
        if (!roiMap.has(id)) roiMap.set(id, {})
        if (roi != null) roiMap.get(id).roi30d = roi
      }
    }
    
    processed += batch.length
    if (processed % 100 === 0 || i + BATCH_SIZE >= numericIntIds.length) {
      console.log(`  Progress: ${processed}/${numericIntIds.length} | roiMap size: ${roiMap.size}`)
    }
    await sleep(300)
  }

  // Phase 2: CTA IDs - get leader_id via list API, then call yield_curve
  if (ctaIds.length > 0) {
    console.log(`\n── Phase 2: CTA traders (${ctaIds.length} traders) ──`)
    
    // Build name -> leaderId mapping from list API
    const nameToId = new Map()
    
    for (const orderBy of ['profit_rate', 'aum', 'win_rate', 'sharp_ratio']) {
      for (const period of ['month', 'quarter']) {
        let pageNum = 1
        while (true) {
          const url = `${BASE}/apiw/v2/copy/leader/list?page=${pageNum}&page_size=100&trader_name=&private_type=0&is_curated=0&label_ids=&order_by=${orderBy}&sort_by=desc&cycle=${period}`
          const j = await page.evaluate(async (u) => {
            try {
              const r = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } })
              return await r.json()
            } catch { return null }
          }, url)
          if (!j || j.code !== 0 || !j.data?.list?.length) break
          for (const t of j.data.list) {
            const name = (t.user_info?.nickname || t.user_info?.nick || t.nickname || t.user_name || '').toLowerCase()
            if (name) nameToId.set(name, t.leader_id)
          }
          if (j.data.list.length < 100) break
          pageNum++
          await sleep(200)
        }
      }
    }
    
    // Also try CTA-specific list
    for (const sortField of ['NINETY_PROFIT_RATE_SORT', 'THIRTY_PROFIT_RATE_SORT', 'SEVEN_PROFIT_RATE_SORT']) {
      let pageNum = 1
      while (true) {
        const url = `${BASE}/apiw/v2/copy/leader/query_cta_trader?page_num=${pageNum}&page_size=100&sort_field=${sortField}`
        const j = await page.evaluate(async (u) => {
          try {
            const r = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } })
            return await r.json()
          } catch { return null }
        }, url)
        if (!j?.data?.list?.length) break
        for (const t of j.data.list) {
          const name = (t.user_name || t.userName || t.nickname || '').toLowerCase()
          const id = t.leader_id || t.id
          if (name && id) {
            nameToId.set(name, id)
            const roi7d = t.seven_profit_rate != null ? parseFloat(t.seven_profit_rate) : null
            const roi30d = t.thirty_profit_rate != null ? parseFloat(t.thirty_profit_rate) : null
            const ctaKey = `cta_${name}`
            if (!roiMap.has(ctaKey)) roiMap.set(ctaKey, {})
            if (roi7d != null) roiMap.get(ctaKey).roi7d = Math.abs(roi7d) <= 1 ? roi7d * 100 : roi7d
            if (roi30d != null) roiMap.get(ctaKey).roi30d = Math.abs(roi30d) <= 1 ? roi30d * 100 : roi30d
          }
        }
        if (j.data.list.length < 100) break
        pageNum++
        await sleep(200)
      }
    }
    
    console.log(`  Name mapping: ${nameToId.size} traders`)
    
    // Match CTA ids to leaderIds, then batch fetch yield_curve
    const ctaLeaderIds = []
    const ctaIdToLeaderId = new Map()
    for (const ctaId of ctaIds) {
      if (roiMap.has(ctaId) && roiMap.get(ctaId).roi7d != null && roiMap.get(ctaId).roi30d != null) continue
      const name = ctaId.replace(/^cta_/, '')
      const leaderId = nameToId.get(name)
      if (leaderId) {
        ctaLeaderIds.push(parseInt(leaderId))
        ctaIdToLeaderId.set(ctaId, parseInt(leaderId))
      }
    }
    
    console.log(`  CTA with leader_id: ${ctaLeaderIds.length}/${ctaIds.length}`)
    
    // Batch fetch yield_curve for CTA traders  
    for (let i = 0; i < ctaLeaderIds.length; i += BATCH_SIZE) {
      const batch = ctaLeaderIds.slice(i, i + BATCH_SIZE)
      
      const r7d = await postYieldCurve(batch, 'seven')
      if (r7d?.code === 0 && r7d.data?.list) {
        for (const item of r7d.data.list) {
          // Find which cta_ id corresponds to this leaderId
          for (const [ctaId, lid] of ctaIdToLeaderId) {
            if (lid === item.leader_id) {
              const roi = computeRoiFromCurve(item.leader_yield_curves)
              if (!roiMap.has(ctaId)) roiMap.set(ctaId, {})
              if (roi != null) roiMap.get(ctaId).roi7d = roi
            }
          }
        }
      }
      
      const r30d = await postYieldCurve(batch, 'month')
      if (r30d?.code === 0 && r30d.data?.list) {
        for (const item of r30d.data.list) {
          for (const [ctaId, lid] of ctaIdToLeaderId) {
            if (lid === item.leader_id) {
              const roi = computeRoiFromCurve(item.leader_yield_curves)
              if (!roiMap.has(ctaId)) roiMap.set(ctaId, {})
              if (roi != null) roiMap.get(ctaId).roi30d = roi
            }
          }
        }
      }
      await sleep(300)
    }
  }

  await browser.close()

  // Coverage check
  let covered7d = 0, covered30d = 0
  for (const [id, data] of roiMap) {
    if (data.roi7d != null) covered7d++
    if (data.roi30d != null) covered30d++
  }
  console.log(`\nCollected: ${roiMap.size} traders, 7d=${covered7d}, 30d=${covered30d}`)

  // Update trader_snapshots
  console.log('\nUpdating trader_snapshots...')
  let updated = 0, skipped = 0, notFound = 0

  for (const [traderId, rows] of traderMap) {
    const data = roiMap.get(traderId)
    if (!data) { notFound++; continue }

    for (const row of rows) {
      const updates = {}
      if (row.roi_7d == null && data.roi7d != null) updates.roi_7d = data.roi7d
      if (row.roi_30d == null && data.roi30d != null) updates.roi_30d = data.roi30d

      if (!Object.keys(updates).length) { skipped++; continue }

      const { error } = await sb.from('trader_snapshots').update(updates).eq('id', row.id)
      if (!error) updated++
      else console.error(`  Error updating ${row.id}:`, error.message)
    }
  }

  console.log(`\n✅ DONE`)
  console.log(`  Updated: ${updated}`)
  console.log(`  Skipped (already full): ${skipped}`)
  console.log(`  Not found in API: ${notFound}`)

  // Final verification
  const { count: null7d } = await sb.from('trader_snapshots')
    .select('*', { count: 'exact', head: true })
    .eq('source', SOURCE)
    .is('roi_7d', null)
  const { count: null30d } = await sb.from('trader_snapshots')
    .select('*', { count: 'exact', head: true })
    .eq('source', SOURCE)
    .is('roi_30d', null)
  console.log(`\n  gateio roi_7d remaining NULL: ${null7d}`)
  console.log(`  gateio roi_30d remaining NULL: ${null30d}`)
}

main().catch(e => { console.error(e); process.exit(1) })
