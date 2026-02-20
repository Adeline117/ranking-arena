#!/usr/bin/env node
/**
 * Gate.io leaderboard_ranks — MDD/WR Fix v2
 *
 * Findings from investigation:
 * - 53 numeric traders: stopped/historical. Gate.io returns 404 for detail,
 *   0 results for stopped status. Not in running list. MDD unavailable via API.
 * - 19 CTA traders: need exhaustive pagination across ALL sort fields (2686 total).
 *   Matching must use nickname/nick_en fields only (not nick which can be Chinese).
 *   computeCtaId = 'cta_' + nickname.lower().replace(/[^a-z0-9]/g,'').slice(0,20)
 *
 * Strategy:
 * 1. CTA: paginate ALL pages of query_cta_trader with ALL sort fields
 * 2. Numeric: try one more broad pagination pass to find any that appear
 */
import { chromium } from 'playwright'
import { getSupabaseClient, sleep } from './lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'gateio'

function computeCtaId(nickname) {
  return 'cta_' + (nickname || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20)
}

function computeCtaStats(profitList) {
  if (!profitList || profitList.length < 2) return { wr: null, mdd: null }
  const sorted = [...profitList].sort((a, b) => a.trade_date - b.trade_date)
  const rates = sorted.map(d => parseFloat(d.profit_rate || 0))

  // MDD from cumulative profit_rate series (values are in percentage form like "8.73...")
  let peak = rates[0], mdd = 0
  for (const r of rates) {
    if (r > peak) peak = r
    // peak and r are in %, e.g. 8.73 = 8.73%
    // dd as a % of (100 + peak) normalized back to %
    if (peak > -100) {
      const dd = ((peak - r) / (100 + peak)) * 100
      if (dd > mdd) mdd = dd
    }
  }

  // Win rate: % of days where portfolio increased
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
  console.log(`Gate.io — MDD/WR Fix v2`)
  console.log(`${'='.repeat(60)}`)

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
  console.log(`Numeric (need MDD): ${numericIds.length} traders`)
  console.log(`CTA (need WR+MDD): ${ctaIds.length} traders`)
  console.log(`CTA targets: ${ctaIds.join(', ')}`)

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()

  console.log('\nEstablishing session...')
  await page.goto('https://www.gate.com/copytrading', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  await sleep(3000)

  const numericResults = new Map()
  const ctaResults = new Map()

  // ════════════════════════════════════════════════════════════
  // PHASE 1: Numeric — one final broad pass (with all orderBys/cycles)
  // ════════════════════════════════════════════════════════════
  console.log('\n── Phase 1: Numeric traders — final broad pass ──')
  const numericSet = new Set(numericIds)

  for (const cycle of ['week', 'month', 'quarter']) {
    for (const orderBy of ['profit_rate', 'win_rate', 'max_drawdown', 'aum', 'follow_profit', 'follow_num', 'sharp_ratio']) {
      for (let pg = 1; pg <= 10; pg++) {
        const batch = await page.evaluate(async ({ pg, cycle, orderBy }) => {
          try {
            const r = await fetch(`/apiw/v2/copy/leader/list?page=${pg}&page_size=100&cycle=${cycle}&order_by=${orderBy}&sort_by=desc`)
            const j = await r.json()
            return j?.data?.list || []
          } catch { return [] }
        }, { pg, cycle, orderBy }).catch(() => [])

        if (!batch?.length) break
        for (const t of batch) {
          const id = String(t.leader_id || '')
          if (!id || !numericSet.has(id) || numericResults.has(id)) continue
          const wr = t.win_rate != null ? parseFloat(t.win_rate) : null
          const mdd = t.max_drawdown != null ? Math.abs(parseFloat(t.max_drawdown)) : null
          const wrf = wr != null && wr <= 1 ? wr * 100 : wr
          const mddf = mdd != null && mdd <= 1 ? mdd * 100 : mdd
          numericResults.set(id, { wr: wrf, mdd: mddf })
          console.log(`  ✓ numeric ${id} (${cycle}/${orderBy}/p${pg}): mdd=${mddf?.toFixed(2)} wr=${wrf?.toFixed(1)}`)
        }
        if (batch.length < 100) break
        await sleep(100)
      }
    }
  }
  console.log(`Phase 1: ${numericResults.size}/${numericIds.length} numeric found`)

  // ════════════════════════════════════════════════════════════
  // PHASE 2: CTA — exhaustive ALL pages ALL sort fields
  // ════════════════════════════════════════════════════════════
  console.log(`\n── Phase 2: CTA exhaustive pagination ──`)

  // Get pagination metadata
  const meta = await page.evaluate(async () => {
    try {
      const r = await fetch('/apiw/v2/copy/leader/query_cta_trader?page_num=1&page_size=20&sort_field=NINETY_PROFIT_RATE_SORT')
      const j = await r.json()
      return { pagecount: j?.data?.pagecount || 200, totalcount: j?.data?.totalcount || 0 }
    } catch { return { pagecount: 200, totalcount: 0 } }
  })
  console.log(`  CTA API: totalcount=${meta.totalcount}, pagecount=${meta.pagecount}`)

  // Build a lookup: computed_id -> ctaId for ALL targets
  const ctaLookup = new Map()     // computedId -> ctaId
  const ctaUsernames = new Map()  // username -> ctaId

  for (const ctaId of ctaIds) {
    const username = ctaId.replace(/^cta_/, '')
    ctaUsernames.set(username, ctaId)
    // Pre-compute various forms
    ctaLookup.set(username, ctaId)  // direct username match
  }

  const sortFields = [
    'NINETY_PROFIT_RATE_SORT',
    'THIRTY_PROFIT_RATE_SORT',
    'SEVEN_PROFIT_RATE_SORT',
    'COPY_USER_COUNT_SORT',
    'TOTAL_PROFIT_RATE_SORT',
    'NINETY_PROFIT_SORT',
    'THIRTY_PROFIT_SORT',
    'SEVEN_PROFIT_SORT',
  ]

  for (const sortField of sortFields) {
    if (ctaResults.size >= ctaIds.length) {
      console.log(`  All CTA found, stopping`)
      break
    }

    let newFound = 0
    const maxPages = meta.pagecount

    for (let pg = 1; pg <= maxPages; pg++) {
      const batch = await page.evaluate(async ({ pg, sf }) => {
        try {
          const r = await fetch(`/apiw/v2/copy/leader/query_cta_trader?page_num=${pg}&page_size=20&sort_field=${sf}`)
          const j = await r.json()
          if (j?.code !== 0 || !j?.data?.list) return []
          return j.data.list.map(t => ({
            nickname: t.nickname || '',
            nick: t.nick || '',
            nick_en: t.nick_en || '',
            profit_list: t.strategy_profit_list || []
          }))
        } catch { return [] }
      }, { pg, sf: sortField }).catch(() => [])

      if (!batch?.length) {
        console.log(`  ${sortField} page ${pg}: empty, stop`)
        break
      }

      for (const t of batch) {
        // Use nickname and nick_en for ID computation (NOT nick which can be Chinese)
        const id1 = computeCtaId(t.nickname)
        const id2 = computeCtaId(t.nick_en)

        let matchedCtaId = null

        // Check exact computed ID match
        if (ctaIds.includes(id1)) matchedCtaId = id1
        else if (ctaIds.includes(id2)) matchedCtaId = id2

        // Also check with broader matching: handle cases where trader changed nickname
        // e.g. "studen" → "StudentInProgress" (nick_en)
        if (!matchedCtaId) {
          const nick1 = t.nickname.toLowerCase().replace(/[^a-z0-9]/g, '')
          const nick2 = t.nick_en.toLowerCase().replace(/[^a-z0-9]/g, '')
          const nick3 = t.nick.toLowerCase().replace(/[^a-z0-9]/g, '')

          for (const [username, ctaId] of ctaUsernames) {
            if (ctaResults.has(ctaId)) continue
            // nick starts with username (e.g., studentinprogress.startsWith(studen))
            // require username to be at least 5 chars to avoid false positives
            if (username.length >= 5) {
              if (nick1.startsWith(username) || nick2.startsWith(username) || nick3.startsWith(username)) {
                matchedCtaId = ctaId
                break
              }
              // username starts with nick (truncated nickname case)
              if (nick1.length >= 5 && username.startsWith(nick1)) { matchedCtaId = ctaId; break }
              if (nick2.length >= 5 && username.startsWith(nick2)) { matchedCtaId = ctaId; break }
            }
          }
        }

        if (!matchedCtaId || ctaResults.has(matchedCtaId)) continue

        const stats = computeCtaStats(t.profit_list)
        ctaResults.set(matchedCtaId, stats)
        newFound++
        console.log(`  ✓ CTA ${matchedCtaId} (nick="${t.nickname}" / nick_en="${t.nick_en}") pg=${pg} sf=${sortField}: wr=${stats.wr} mdd=${stats.mdd} list_len=${t.profit_list.length}`)
      }

      if (pg % 40 === 0) {
        console.log(`  ${sortField} page ${pg}/${maxPages}: ${ctaResults.size}/${ctaIds.length} CTA found`)
      }

      await sleep(80)
    }
    console.log(`  After ${sortField}: ${ctaResults.size}/${ctaIds.length} CTA found (+${newFound} new)`)
  }

  // ════════════════════════════════════════════════════════════
  // PHASE 3: Any remaining CTA — check via individual profile page
  // ════════════════════════════════════════════════════════════
  const missingCtas = ctaIds.filter(id => !ctaResults.has(id))
  if (missingCtas.length > 0) {
    console.log(`\n── Phase 3: Individual pages for ${missingCtas.length} missing CTA ──`)

    for (const ctaId of missingCtas) {
      const username = ctaId.replace(/^cta_/, '')
      const ctaPage = await context.newPage()
      let best = null

      ctaPage.on('response', async (res) => {
        if (res.status() !== 200) return
        if (!res.url().includes('gate')) return
        try {
          const ct = res.headers()['content-type'] || ''
          if (!ct.includes('json')) return
          const j = await res.json()
          const list = j?.data?.list
          if (!Array.isArray(list)) return

          for (const t of list) {
            const n1 = computeCtaId(t.nickname || '')
            const n2 = computeCtaId(t.nick_en || '')
            const nick1 = (t.nickname || '').toLowerCase().replace(/[^a-z0-9]/g, '')
            const nick2 = (t.nick_en || '').toLowerCase().replace(/[^a-z0-9]/g, '')

            let matched = (n1 === ctaId || n2 === ctaId)
            if (!matched && username.length >= 5) {
              matched = nick1.startsWith(username) || nick2.startsWith(username)
              if (!matched && nick1.length >= 5) matched = username.startsWith(nick1)
            }
            if (!matched) continue

            const stats = computeCtaStats(t.strategy_profit_list || [])
            if (stats.wr != null || stats.mdd != null) best = stats
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

      if (best) {
        ctaResults.set(ctaId, best)
        console.log(`  ✓ Via page: ${ctaId} wr=${best.wr} mdd=${best.mdd}`)
      } else {
        console.log(`  ✗ Not found: ${ctaId}`)
      }
      await sleep(500)
    }
  }

  await browser.close()

  // Summary before DB update
  console.log(`\n── Results Summary ──`)
  console.log(`Numeric found: ${numericResults.size}/${numericIds.length}`)
  console.log(`CTA found: ${ctaResults.size}/${ctaIds.length}`)
  const missingCta2 = ctaIds.filter(id => !ctaResults.has(id))
  if (missingCta2.length) console.log(`Still missing CTA: ${missingCta2.join(', ')}`)

  // ════════════════════════════════════════════════════════════
  // PHASE 4: Update DB
  // ════════════════════════════════════════════════════════════
  console.log('\n── Updating DB ──')
  let updated = 0, skipped = 0

  for (const [traderId, rows] of byTrader) {
    const isNumeric = /^\d+$/.test(traderId)
    const isCta = traderId.startsWith('cta_')

    const data = isNumeric ? numericResults.get(traderId) : ctaResults.get(traderId)
    if (!data) { skipped += rows.length; continue }

    for (const row of rows) {
      const updates = {}
      if (row.max_drawdown == null && data.mdd != null && !isNaN(data.mdd)) {
        updates.max_drawdown = parseFloat(data.mdd.toFixed(2))
      }
      if (row.win_rate == null && data.wr != null && !isNaN(data.wr)) {
        updates.win_rate = parseFloat(data.wr.toFixed(2))
      }
      if (Object.keys(updates).length === 0) { skipped++; continue }

      const { error } = await supabase.from('leaderboard_ranks').update(updates).eq('id', row.id)
      if (!error) {
        updated++
        console.log(`  ✓ ${traderId} ${row.season_id}: wr=${updates.win_rate ?? '-'} mdd=${updates.max_drawdown ?? '-'}`)
      } else {
        console.error(`  ✗ ${traderId} ${row.id}: ${error.message}`)
      }
    }
  }

  console.log(`\n✅ Updated: ${updated}, Skipped: ${skipped}`)

  // Verification
  const { count: total } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE)
  const { count: mddNull } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('max_drawdown', null)
  const { count: wrNull } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('win_rate', null)
  console.log(`\nFinal DB: total=${total} mdd_null=${mddNull} wr_null=${wrNull}`)
  console.log(`Remaining nulls: mdd=${mddNull} wr=${wrNull}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
