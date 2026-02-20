#!/usr/bin/env node
/**
 * Gate.io leaderboard_ranks — Final MDD/WR enricher
 *
 * Strategy:
 * 1. Numeric traders (null MDD): paginate list API with all cycles/sorts + individual page intercept
 * 2. CTA traders (null WR+MDD): paginate ALL sort fields of query_cta_trader API
 * 3. Update DB with real data only — no fabrication
 */
import { chromium } from 'playwright'
import { getSupabaseClient, sleep } from './lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'gateio'

// Compute CTA ID from nickname
function computeCtaId(nickname) {
  return 'cta_' + nickname.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20)
}

// Compute stats from strategy_profit_list (daily cumulative profit_rate series)
function computeCtaStats(profitList) {
  if (!profitList || profitList.length < 2) return { wr: null, mdd: null }
  // Sort ascending by date (oldest first)
  const sorted = [...profitList].sort((a, b) => a.trade_date - b.trade_date)
  const rates = sorted.map(d => parseFloat(d.profit_rate || 0))
  
  // MDD: from the cumulative profit_rate curve
  let peak = rates[0], mdd = 0
  for (const r of rates) {
    if (r > peak) peak = r
    // Drawdown as a % of (1 + peak) to get proper percentage
    const dd = peak > -100 ? ((peak - r) / (1 + peak / 100)) : 0
    if (dd > mdd) mdd = dd
  }

  // Win rate: % of trading days where portfolio value increased
  let wins = 0, total = 0
  for (let i = 1; i < sorted.length; i++) {
    const prev = parseFloat(sorted[i - 1].profit_rate || 0)
    const cur = parseFloat(sorted[i].profit_rate || 0)
    total++
    if (cur > prev) wins++
  }
  const wr = total > 0 ? (wins / total) * 100 : null

  return {
    wr: wr != null ? parseFloat(wr.toFixed(2)) : null,
    mdd: mdd > 0 ? parseFloat(mdd.toFixed(2)) : 0
  }
}

async function main() {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Gate.io — Final MDD/WR Enricher`)
  console.log(`${'='.repeat(60)}`)

  // ── Fetch what needs enrichment ──
  const { data: allRows, error } = await supabase
    .from('leaderboard_ranks')
    .select('id, source_trader_id, season_id, win_rate, max_drawdown')
    .eq('source', SOURCE)
    .or('win_rate.is.null,max_drawdown.is.null')

  if (error) { console.error('DB error:', error.message); process.exit(1) }
  console.log(`Rows needing enrichment: ${allRows.length}`)
  if (!allRows.length) { console.log('Nothing to do'); return }

  const byTrader = new Map()
  for (const r of allRows) {
    if (!byTrader.has(r.source_trader_id)) byTrader.set(r.source_trader_id, [])
    byTrader.get(r.source_trader_id).push(r)
  }

  const numericIds = [...byTrader.keys()].filter(id => /^\d+$/.test(id))
  const ctaIds = [...byTrader.keys()].filter(id => id.startsWith('cta_'))
  console.log(`Numeric (need MDD): ${numericIds.length} traders, ${allRows.filter(r => /^\d+$/.test(r.source_trader_id)).length} rows`)
  console.log(`CTA (need WR+MDD): ${ctaIds.length} traders, ${allRows.filter(r => r.source_trader_id.startsWith('cta_')).length} rows`)

  // ── Launch browser ──
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
  })
  const page = await context.newPage()

  console.log('\nEstablishing Gate.com session...')
  await page.goto('https://www.gate.com/copytrading', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  await sleep(3000)
  console.log('Session ready')

  const numericResults = new Map() // leaderId -> { wr, mdd } (cycle-agnostic best value)
  const ctaResults = new Map()     // cta_id -> { wr, mdd }

  // ════════════════════════════════════════════════════════════
  // PHASE 1: Numeric traders — Full leader/list pagination
  // ════════════════════════════════════════════════════════════
  console.log('\n── Phase 1: Numeric traders via leader/list ──')

  const cycles = ['week', 'month', 'quarter']
  const orderBys = ['profit_rate', 'win_rate', 'max_drawdown', 'aum', 'follow_profit', 'follow_num', 'sharp_ratio']

  const numericSet = new Set(numericIds)

  for (const cycle of cycles) {
    let foundNew = 0
    for (const orderBy of orderBys) {
      for (let pg = 1; pg <= 50; pg++) {
        const batch = await page.evaluate(async ({ pg, cycle, orderBy }) => {
          try {
            const url = `/apiw/v2/copy/leader/list?page=${pg}&page_size=100&cycle=${cycle}&order_by=${orderBy}&sort_by=desc&status=running`
            const r = await fetch(url, { credentials: 'include' })
            const j = await r.json()
            if (j?.code !== 0 || !j?.data?.list) return []
            return j.data.list
          } catch { return [] }
        }, { pg, cycle, orderBy }).catch(() => [])

        if (!batch || batch.length === 0) break

        for (const t of batch) {
          const id = String(t.leader_id || '')
          if (!id || !numericSet.has(id)) continue
          const wr = t.win_rate != null ? parseFloat(t.win_rate) : null
          const mdd = t.max_drawdown != null ? Math.abs(parseFloat(t.max_drawdown)) : null
          const existing = numericResults.get(id)
          // Keep entry with non-null MDD; normalize 0-1 to percentage
          const wrf = wr != null && wr <= 1 ? wr * 100 : wr
          const mddf = mdd != null && mdd <= 1 ? mdd * 100 : mdd
          if (!existing || (mddf != null && existing.mdd == null)) {
            numericResults.set(id, { wr: wrf, mdd: mddf })
            foundNew++
            console.log(`  ✓ Found ${id} in list (${cycle}/${orderBy}/pg${pg}): wr=${wrf?.toFixed(1)} mdd=${mddf?.toFixed(2)}`)
          }
        }

        if (batch.length < 100) break
        await sleep(150)
      }
      await sleep(100)
    }
    console.log(`  After cycle=${cycle}: ${numericResults.size}/${numericIds.length} numeric found (+${foundNew} new)`)
  }

  // Also try without status filter (might reveal different traders)
  console.log('\n── Phase 1b: No status filter ──')
  for (const cycle of cycles) {
    for (const orderBy of ['profit_rate', 'max_drawdown']) {
      for (let pg = 1; pg <= 50; pg++) {
        const batch = await page.evaluate(async ({ pg, cycle, orderBy }) => {
          try {
            const url = `/apiw/v2/copy/leader/list?page=${pg}&page_size=100&cycle=${cycle}&order_by=${orderBy}&sort_by=desc`
            const r = await fetch(url, { credentials: 'include' })
            const j = await r.json()
            if (j?.code !== 0 || !j?.data?.list) return []
            return j.data.list
          } catch { return [] }
        }, { pg, cycle, orderBy }).catch(() => [])

        if (!batch || batch.length === 0) break

        for (const t of batch) {
          const id = String(t.leader_id || '')
          if (!id || !numericSet.has(id)) continue
          const wr = t.win_rate != null ? parseFloat(t.win_rate) : null
          const mdd = t.max_drawdown != null ? Math.abs(parseFloat(t.max_drawdown)) : null
          const wrf = wr != null && wr <= 1 ? wr * 100 : wr
          const mddf = mdd != null && mdd <= 1 ? mdd * 100 : mdd
          if (!numericResults.has(id) || (mddf != null && numericResults.get(id).mdd == null)) {
            numericResults.set(id, { wr: wrf, mdd: mddf })
            console.log(`  ✓ Found ${id} (no-status ${cycle}/${orderBy}/pg${pg}): wr=${wrf?.toFixed(1)} mdd=${mddf?.toFixed(2)}`)
          }
        }
        if (batch.length < 100) break
        await sleep(100)
      }
    }
  }
  console.log(`Phase 1 total: ${numericResults.size}/${numericIds.length} numeric traders found`)

  // ════════════════════════════════════════════════════════════
  // PHASE 2: Numeric traders — Individual detail page intercept
  // ════════════════════════════════════════════════════════════
  const missingNumerics = numericIds.filter(id => !numericResults.has(id) || numericResults.get(id).mdd == null)
  console.log(`\n── Phase 2: Individual page intercept for ${missingNumerics.length} missing numeric traders ──`)

  for (let i = 0; i < missingNumerics.length; i++) {
    const traderId = missingNumerics[i]
    if (i % 10 === 0) console.log(`  Progress: ${i}/${missingNumerics.length}`)

    const detailPage = await context.newPage()
    let bestData = null

    detailPage.on('response', async (res) => {
      const url = res.url()
      if (res.status() !== 200) return
      if (!url.includes('gate')) return
      try {
        const ct = res.headers()['content-type'] || ''
        if (!ct.includes('json')) return
        const j = await res.json()
        if (!j || j.code !== 0 || !j.data) return

        const str = JSON.stringify(j)

        // Look for this trader's leader_id in the response
        if (!str.includes(`"leader_id":${traderId}`) && !str.includes(`"leader_id":"${traderId}"`)) return

        const list = Array.isArray(j.data.list) ? j.data.list : [j.data]
        for (const t of list) {
          if (String(t.leader_id) !== traderId) continue
          const wr = t.win_rate != null ? parseFloat(t.win_rate) : null
          const mdd = t.max_drawdown != null ? Math.abs(parseFloat(t.max_drawdown)) : null
          const wrf = wr != null && wr <= 1 ? wr * 100 : wr
          const mddf = mdd != null && mdd <= 1 ? mdd * 100 : mdd
          if (mddf != null) {
            bestData = { wr: wrf, mdd: mddf }
          }
        }
      } catch {}
    })

    try {
      await detailPage.goto(`https://www.gate.com/copytrading/trader/${traderId}`, {
        waitUntil: 'networkidle', timeout: 20000
      }).catch(() => {})
      await sleep(3000)
    } catch {}
    await detailPage.close()

    if (bestData) {
      numericResults.set(traderId, bestData)
      console.log(`  ✓ Found via detail page: ${traderId} wr=${bestData.wr?.toFixed(1)} mdd=${bestData.mdd?.toFixed(2)}`)
    }
    await sleep(500)
  }

  const stillMissingNumerics = numericIds.filter(id => !numericResults.has(id) || numericResults.get(id).mdd == null)
  console.log(`After Phase 2: ${numericIds.length - stillMissingNumerics.length}/${numericIds.length} numeric found`)
  if (stillMissingNumerics.length) console.log(`Still missing: ${stillMissingNumerics.join(', ')}`)

  // ════════════════════════════════════════════════════════════
  // PHASE 3: CTA traders — exhaustive query_cta_trader pagination
  // ════════════════════════════════════════════════════════════
  console.log(`\n── Phase 3: CTA traders (${ctaIds.length} needed) ──`)

  // Build target set: username -> cta_id
  const ctaTargets = new Map()
  for (const ctaId of ctaIds) {
    ctaTargets.set(ctaId.replace(/^cta_/, ''), ctaId)
  }

  // Get total page count first
  const ctaMeta = await page.evaluate(async () => {
    try {
      const r = await fetch('/apiw/v2/copy/leader/query_cta_trader?page_num=1&page_size=20&sort_field=NINETY_PROFIT_RATE_SORT')
      const j = await r.json()
      return { pagecount: j?.data?.pagecount, totalcount: j?.data?.totalcount }
    } catch { return { pagecount: 200, totalcount: 0 } }
  }).catch(() => ({ pagecount: 200, totalcount: 0 }))

  console.log(`  CTA total: ${ctaMeta.totalcount} traders, ${ctaMeta.pagecount} pages`)

  const sortFields = [
    'NINETY_PROFIT_RATE_SORT',
    'THIRTY_PROFIT_RATE_SORT',
    'SEVEN_PROFIT_RATE_SORT',
    'COPY_USER_COUNT_SORT',
    'TOTAL_PROFIT_RATE_SORT',
    'NINETY_PROFIT_SORT',
  ]

  for (const sortField of sortFields) {
    if (ctaResults.size === ctaIds.length) break
    let foundInSort = 0
    const maxPages = ctaMeta.pagecount || 200

    for (let pg = 1; pg <= maxPages; pg++) {
      const batch = await page.evaluate(async ({ pg, sortField }) => {
        try {
          const r = await fetch(`/apiw/v2/copy/leader/query_cta_trader?page_num=${pg}&page_size=20&sort_field=${sortField}`)
          const j = await r.json()
          if (j?.code !== 0 || !j?.data?.list) return []
          return j.data.list
        } catch { return [] }
      }, { pg, sortField }).catch(() => [])

      if (!batch || batch.length === 0) break

      for (const t of batch) {
        const nick = t.nickname || t.nick || ''
        if (!nick) continue

        // Try computeCtaId matching
        const computedId = computeCtaId(nick)
        let matchedCtaId = null

        if (ctaIds.includes(computedId)) {
          matchedCtaId = computedId
        } else {
          // Broader match: check if any target username is a substring or vice versa
          for (const [username, ctaId] of ctaTargets) {
            const nickLower = nick.toLowerCase().replace(/[^a-z0-9]/g, '')
            const userLower = username.toLowerCase()
            if (nickLower === userLower || nickLower.startsWith(userLower) || userLower.startsWith(nickLower)) {
              matchedCtaId = ctaId
              break
            }
          }
        }

        if (!matchedCtaId || ctaResults.has(matchedCtaId)) continue

        const profitList = t.strategy_profit_list || []
        const stats = computeCtaStats(profitList)

        if (stats.wr != null || stats.mdd != null) {
          ctaResults.set(matchedCtaId, stats)
          foundInSort++
          console.log(`  ✓ CTA ${matchedCtaId} (nick="${nick}") page=${pg} sort=${sortField}: wr=${stats.wr} mdd=${stats.mdd}`)
        }
      }

      // Stop early if all found
      if (ctaResults.size === ctaIds.length) break

      if (pg % 30 === 0) {
        console.log(`  ${sortField} page ${pg}/${maxPages}: ${ctaResults.size}/${ctaIds.length} CTA found`)
      }
      await sleep(100)
    }
    console.log(`  After ${sortField}: ${ctaResults.size}/${ctaIds.length} CTA found (+${foundInSort} new)`)
  }

  // ════════════════════════════════════════════════════════════
  // PHASE 4: CTA — individual profile page intercept for misses
  // ════════════════════════════════════════════════════════════
  const missingCtas = ctaIds.filter(id => !ctaResults.has(id))
  console.log(`\n── Phase 4: CTA detail pages for ${missingCtas.length} missing ──`)

  for (const ctaId of missingCtas) {
    const username = ctaId.replace(/^cta_/, '')
    console.log(`  Trying: ${ctaId} (username: ${username})`)

    const ctaPage = await context.newPage()
    let capturedStats = null
    let foundLongest = 0

    ctaPage.on('response', async (res) => {
      const url = res.url()
      if (res.status() !== 200) return
      if (!url.includes('gate')) return
      try {
        const ct = res.headers()['content-type'] || ''
        if (!ct.includes('json')) return
        const j = await res.json()
        if (!j?.data) return

        // Look for CTA trader data with strategy_profit_list
        const list = Array.isArray(j.data.list) ? j.data.list : (Array.isArray(j.data) ? j.data : null)
        if (!list) return

        for (const t of list) {
          const nick = t.nickname || t.nick || ''
          const nickLower = nick.toLowerCase().replace(/[^a-z0-9]/g, '')
          const userLower = username.toLowerCase()

          if (nickLower === userLower || computeCtaId(nick) === ctaId) {
            const profitList = t.strategy_profit_list || []
            if (profitList.length > foundLongest) {
              foundLongest = profitList.length
              const stats = computeCtaStats(profitList)
              capturedStats = stats
            }
          }
        }
      } catch {}
    })

    try {
      await ctaPage.goto(`https://www.gate.com/copytrading/trader/${username}`, {
        waitUntil: 'networkidle', timeout: 20000
      }).catch(() => {})
      await sleep(3000)
    } catch {}
    await ctaPage.close()

    if (capturedStats && (capturedStats.wr != null || capturedStats.mdd != null)) {
      ctaResults.set(ctaId, capturedStats)
      console.log(`  ✓ Found via page intercept: ${ctaId} wr=${capturedStats.wr} mdd=${capturedStats.mdd}`)
    } else {
      console.log(`  ✗ Not found: ${ctaId}`)
    }
    await sleep(500)
  }

  await browser.close()

  // ════════════════════════════════════════════════════════════
  // PHASE 5: Update DB
  // ════════════════════════════════════════════════════════════
  console.log('\n── Phase 5: Updating DB ──')
  let updated = 0, skipped = 0

  // Update numeric traders
  for (const [traderId, rows] of byTrader) {
    if (!(/^\d+$/.test(traderId))) continue
    const data = numericResults.get(traderId)
    if (!data) { skipped += rows.length; continue }

    for (const row of rows) {
      const updates = {}
      // Only fill MDD (numeric traders already have WR)
      if (row.max_drawdown == null && data.mdd != null && !isNaN(data.mdd)) {
        updates.max_drawdown = parseFloat(data.mdd.toFixed(2))
      }
      // Also fill WR if missing (just in case)
      if (row.win_rate == null && data.wr != null && !isNaN(data.wr)) {
        updates.win_rate = parseFloat(data.wr.toFixed(2))
      }
      if (Object.keys(updates).length === 0) { skipped++; continue }

      const { error } = await supabase.from('leaderboard_ranks').update(updates).eq('id', row.id)
      if (!error) {
        updated++
        console.log(`  ✓ ${traderId} ${row.season_id}: mdd=${updates.max_drawdown}`)
      } else {
        console.error(`  ✗ ${traderId}: ${error.message}`)
      }
    }
  }

  // Update CTA traders
  for (const [ctaId, rows] of byTrader) {
    if (!ctaId.startsWith('cta_')) continue
    const data = ctaResults.get(ctaId)
    if (!data) { skipped += rows.length; continue }

    for (const row of rows) {
      const updates = {}
      if (row.win_rate == null && data.wr != null && !isNaN(data.wr)) {
        updates.win_rate = parseFloat(data.wr.toFixed(2))
      }
      if (row.max_drawdown == null && data.mdd != null && !isNaN(data.mdd)) {
        updates.max_drawdown = parseFloat(data.mdd.toFixed(2))
      }
      if (Object.keys(updates).length === 0) { skipped++; continue }

      const { error } = await supabase.from('leaderboard_ranks').update(updates).eq('id', row.id)
      if (!error) {
        updated++
        console.log(`  ✓ ${ctaId} ${row.season_id}: wr=${updates.win_rate} mdd=${updates.max_drawdown}`)
      } else {
        console.error(`  ✗ ${ctaId}: ${error.message}`)
      }
    }
  }

  console.log(`\n✅ Updated: ${updated}, Skipped: ${skipped}`)

  // ── Verify ──
  const { count: total } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE)
  const { count: mddNull } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('max_drawdown', null)
  const { count: wrNull } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('win_rate', null)
  console.log(`\nFinal DB: total=${total} mdd_null=${mddNull} wr_null=${wrNull}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
