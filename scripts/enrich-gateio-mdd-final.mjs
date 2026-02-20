#!/usr/bin/env node
/**
 * Gate.io MDD enrichment — FINAL
 *
 * Key discovery: POST /apiw/v2/copy/api/leader/yield_curve
 *   with body {"leader_ids":[...], "data_type":"month"} works for stopped traders!
 *
 * yield_curve entries: {profit, profit_rate, current_profit, total_invest, create_time}
 *   - profit_rate is daily rate as decimal fraction (0.1151 = 0.1151%)
 *   - We compute MDD from cumulative return series
 *
 * For CTA: exhaustive query_cta_trader pagination + profile page for misses
 */
import { chromium } from 'playwright'
import { getSupabaseClient, sleep } from './lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'gateio'

function computeCtaId(nickname) {
  return 'cta_' + (nickname || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20)
}

/**
 * Compute MDD from yield_curve data (daily profit_rate in decimal fraction form)
 * e.g. profit_rate = "0.1151" means daily return of 0.1151%
 * Builds cumulative return index and computes max drawdown
 */
function computeMddFromYieldCurve(curves) {
  if (!curves || curves.length < 2) return null
  // Sort ascending by create_time
  const sorted = [...curves].sort((a, b) => a.create_time - b.create_time)

  // Build cumulative value index starting at 100
  let cumValue = 100
  const values = [cumValue]
  for (const entry of sorted) {
    const dailyRate = parseFloat(entry.profit_rate || 0) / 100 // convert % to fraction (0.001151)
    cumValue = cumValue * (1 + dailyRate)
    values.push(cumValue)
  }

  let peak = -Infinity, mdd = 0
  for (const v of values) {
    if (v > peak) peak = v
    const dd = (peak - v) / peak * 100
    if (dd > mdd) mdd = dd
  }
  return mdd > 0 ? parseFloat(mdd.toFixed(4)) : 0
}

/**
 * Compute MDD from CTA strategy_profit_list (cumulative profit_rate in % form)
 * e.g. profit_rate = "8.73..." means total return to date is 8.73%
 */
function computeMddFromCumulative(profitList) {
  if (!profitList || profitList.length < 2) return null
  const sorted = [...profitList].sort((a, b) => a.trade_date - b.trade_date)
  const rates = sorted.map(d => parseFloat(d.profit_rate || 0))

  let peak = -Infinity, mdd = 0
  for (const r of rates) {
    if (r > peak) peak = r
    if (peak > -100) {
      const dd = ((peak - r) / (100 + peak)) * 100
      if (dd > mdd) mdd = dd
    }
  }
  return mdd > 0 ? parseFloat(mdd.toFixed(4)) : 0
}

function computeWrFromCumulative(profitList) {
  if (!profitList || profitList.length < 2) return null
  const sorted = [...profitList].sort((a, b) => a.trade_date - b.trade_date)
  let wins = 0, total = 0
  for (let i = 1; i < sorted.length; i++) {
    const prev = parseFloat(sorted[i - 1].profit_rate || 0)
    const cur = parseFloat(sorted[i].profit_rate || 0)
    total++
    if (cur > prev) wins++
  }
  return total > 0 ? parseFloat(((wins / total) * 100).toFixed(2)) : null
}

async function main() {
  console.log(`\n${'='.repeat(60)}`)
  console.log('Gate.io MDD Enricher — FINAL (yield_curve POST method)')
  console.log(`${'='.repeat(60)}`)

  const { data: allRows } = await supabase
    .from('leaderboard_ranks')
    .select('id, source_trader_id, season_id, win_rate, max_drawdown')
    .eq('source', SOURCE)
    .is('max_drawdown', null)

  if (!allRows?.length) {
    console.log('✅ No rows need MDD enrichment!')
    return
  }

  const byTrader = new Map()
  for (const r of allRows) {
    if (!byTrader.has(r.source_trader_id)) byTrader.set(r.source_trader_id, [])
    byTrader.get(r.source_trader_id).push(r)
  }

  const numericIds = [...byTrader.keys()].filter(id => /^\d+$/.test(id))
  const ctaIds = [...byTrader.keys()].filter(id => id.startsWith('cta_'))

  console.log(`Rows with null MDD: ${allRows.length}`)
  console.log(`Numeric traders: ${numericIds.length} (${numericIds.join(', ')})`)
  console.log(`CTA traders: ${ctaIds.length} (${ctaIds.join(', ')})`)

  // Launch browser
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()

  console.log('\nEstablishing session...')
  await page.goto('https://www.gate.com/copytrading', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
  await sleep(5000)
  console.log('Session ready')

  const numericResults = new Map()
  const ctaResults = new Map()

  // ════════════════════════════════════════════════════════════
  // PHASE 1: Numeric traders — yield_curve POST API (works for stopped!)
  // ════════════════════════════════════════════════════════════
  console.log(`\n── Phase 1: Numeric traders via yield_curve POST (${numericIds.length} traders) ──`)

  // Batch up to 10 traders per request
  const BATCH_SIZE = 10
  const intIds = numericIds.map(id => parseInt(id, 10))

  for (let start = 0; start < intIds.length; start += BATCH_SIZE) {
    const batch = intIds.slice(start, start + BATCH_SIZE)
    const batchStr = batch.join(', ')
    console.log(`  Batch [${start}..${start + batch.length - 1}]: ${batchStr}`)

    // Try month and seven data types
    for (const data_type of ['month', 'seven']) {
      const result = await page.evaluate(async ({ ids, dt }) => {
        try {
          const r = await fetch('/apiw/v2/copy/api/leader/yield_curve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ leader_ids: ids, data_type: dt }),
            credentials: 'include'
          })
          const j = await r.json()
          if (j?.code === 0 && j?.data?.list) {
            return j.data.list.map(item => ({
              leader_id: item.leader_id,
              curves: item.leader_yield_curves || []
            }))
          }
          return null
        } catch { return null }
      }, { ids: batch, dt: data_type })

      if (result && Array.isArray(result)) {
        for (const item of result) {
          const id = String(item.leader_id)
          if (!numericIds.includes(id)) continue
          if (numericResults.has(id)) continue

          if (item.curves?.length >= 2) {
            const mdd = computeMddFromYieldCurve(item.curves)
            if (mdd !== null) {
              numericResults.set(id, { mdd })
              console.log(`  ✓ ${id} (${data_type}): mdd=${mdd} from ${item.curves.length} points`)
            }
          }
        }
      }
      await sleep(200)
    }
  }

  console.log(`Phase 1: ${numericResults.size}/${numericIds.length} numeric found via yield_curve`)

  // ════════════════════════════════════════════════════════════
  // PHASE 2: Numeric — individual detail pages for any remaining
  // ════════════════════════════════════════════════════════════
  const stillMissingNumeric = numericIds.filter(id => !numericResults.has(id))
  if (stillMissingNumeric.length > 0) {
    console.log(`\n── Phase 2: ${stillMissingNumeric.length} numeric traders via individual page ──`)

    for (let i = 0; i < stillMissingNumeric.length; i++) {
      const traderId = stillMissingNumeric[i]
      if (i % 5 === 0) console.log(`  [${i}/${stillMissingNumeric.length}] Trying ${traderId}`)

      // Try fetching from within page context (with session)
      const yieldData = await page.evaluate(async (id) => {
        const intId = parseInt(id, 10)
        for (const dt of ['month', 'seven']) {
          try {
            const r = await fetch('/apiw/v2/copy/api/leader/yield_curve', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
              body: JSON.stringify({ leader_ids: [intId], data_type: dt }),
              credentials: 'include'
            })
            const j = await r.json()
            if (j?.code === 0 && j?.data?.list?.[0]?.leader_yield_curves?.length >= 2) {
              return { dt, curves: j.data.list[0].leader_yield_curves }
            }
          } catch {}
        }
        return null
      }, traderId)

      if (yieldData?.curves?.length >= 2) {
        const mdd = computeMddFromYieldCurve(yieldData.curves)
        if (mdd !== null) {
          numericResults.set(traderId, { mdd })
          console.log(`  ✓ ${traderId} (${yieldData.dt}): mdd=${mdd}`)
        }
      }
      await sleep(200)
    }
    console.log(`After Phase 2: ${numericResults.size}/${numericIds.length} numeric found`)
  }

  // ════════════════════════════════════════════════════════════
  // PHASE 3: CTA traders — exhaustive query_cta_trader pagination
  // ════════════════════════════════════════════════════════════
  console.log(`\n── Phase 3: CTA traders exhaustive pagination (${ctaIds.length} targets) ──`)

  const ctaUsernames = new Map()
  for (const ctaId of ctaIds) {
    ctaUsernames.set(ctaId.replace(/^cta_/, ''), ctaId)
  }

  const ctaMeta = await page.evaluate(async () => {
    try {
      const r = await fetch('/apiw/v2/copy/leader/query_cta_trader?page_num=1&page_size=20&sort_field=NINETY_PROFIT_RATE_SORT')
      const j = await r.json()
      return { pagecount: j?.data?.pagecount || 200, totalcount: j?.data?.totalcount || 0 }
    } catch { return { pagecount: 200, totalcount: 0 } }
  })
  console.log(`  CTA API: ${ctaMeta.totalcount} total, ${ctaMeta.pagecount} pages`)

  const sortFields = [
    'NINETY_PROFIT_RATE_SORT',
    'THIRTY_PROFIT_RATE_SORT',
    'SEVEN_PROFIT_RATE_SORT',
    'COPY_USER_COUNT_SORT',
    'TOTAL_PROFIT_RATE_SORT',
    'NINETY_PROFIT_SORT',
    'TOTAL_PROFIT_SORT',
    'SEVEN_PROFIT_SORT',
    'THIRTY_PROFIT_SORT',
  ]

  for (const sortField of sortFields) {
    if (ctaResults.size >= ctaIds.length) break
    let newFound = 0

    for (let pg = 1; pg <= ctaMeta.pagecount; pg++) {
      const batch = await page.evaluate(async ({ pg, sf }) => {
        try {
          const r = await fetch(`/apiw/v2/copy/leader/query_cta_trader?page_num=${pg}&page_size=20&sort_field=${sf}`)
          const j = await r.json()
          if (j?.code !== 0 || !j?.data?.list) return []
          return j.data.list.map(t => ({
            nickname: t.nickname || '',
            nick_en: t.nick_en || '',
            nick: t.nick || '',
            profit_list: t.strategy_profit_list || []
          }))
        } catch { return [] }
      }, { pg, sf: sortField }).catch(() => [])

      if (!batch?.length) {
        if (pg === 1) console.log(`  ${sortField}: empty on pg1`)
        break
      }

      for (const t of batch) {
        const id1 = computeCtaId(t.nickname)
        const id2 = computeCtaId(t.nick_en)

        let matchedCtaId = null
        if (ctaIds.includes(id1) && !ctaResults.has(id1)) matchedCtaId = id1
        else if (ctaIds.includes(id2) && !ctaResults.has(id2)) matchedCtaId = id2

        if (!matchedCtaId) {
          const nick1 = t.nickname.toLowerCase().replace(/[^a-z0-9]/g, '')
          const nick2 = t.nick_en.toLowerCase().replace(/[^a-z0-9]/g, '')
          for (const [username, ctaId] of ctaUsernames) {
            if (ctaResults.has(ctaId)) continue
            if (username.length >= 4) {
              if (nick1 === username || nick2 === username ||
                  nick1.startsWith(username) || nick2.startsWith(username)) {
                matchedCtaId = ctaId
                break
              }
              if (nick1.length >= 6 && username.startsWith(nick1)) { matchedCtaId = ctaId; break }
              if (nick2.length >= 6 && username.startsWith(nick2)) { matchedCtaId = ctaId; break }
            }
          }
        }

        if (!matchedCtaId) continue

        const mdd = computeMddFromCumulative(t.profit_list)
        const wr = computeWrFromCumulative(t.profit_list)
        ctaResults.set(matchedCtaId, { wr, mdd })
        newFound++
        console.log(`  ✓ CTA ${matchedCtaId} (nick="${t.nickname}") pg=${pg}: wr=${wr} mdd=${mdd} list=${t.profit_list.length}`)
      }

      if (pg % 50 === 0) console.log(`  ${sortField} pg${pg}: ${ctaResults.size}/${ctaIds.length}`)
      await sleep(80)
    }
    console.log(`  After ${sortField}: ${ctaResults.size}/${ctaIds.length} (+${newFound})`)
  }

  // ════════════════════════════════════════════════════════════
  // PHASE 4: CTA — direct profile page + name search for misses
  // ════════════════════════════════════════════════════════════
  const missingCtas = ctaIds.filter(id => !ctaResults.has(id))
  if (missingCtas.length > 0) {
    console.log(`\n── Phase 4: Direct profile pages for ${missingCtas.length} missing CTA ──`)
    console.log('  Missing:', missingCtas.join(', '))

    for (const ctaId of missingCtas) {
      const username = ctaId.replace(/^cta_/, '')
      console.log(`  → ${ctaId} (username="${username}")`)

      const ctaPage = await context.newPage()
      let best = null
      let profitListFound = []

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
            if (!matched && username.length >= 4) {
              matched = nick1 === username || nick2 === username ||
                        nick1.startsWith(username) || nick2.startsWith(username)
              if (!matched && nick1.length >= 6) matched = username.startsWith(nick1)
              if (!matched && nick2.length >= 6) matched = username.startsWith(nick2)
            }
            if (!matched) continue

            const pl = t.strategy_profit_list || []
            if (pl.length > 0) profitListFound.push(pl)
          }
        } catch {}
      })

      try {
        await ctaPage.goto(`https://www.gate.com/copytrading/trader/${username}`, {
          waitUntil: 'networkidle', timeout: 20000
        }).catch(() => {})
        await sleep(3000)

        // Also try in-page search
        const searchResult = await ctaPage.evaluate(async (nick) => {
          const results = []
          // Try different approaches
          for (const sf of ['NINETY_PROFIT_RATE_SORT', 'COPY_USER_COUNT_SORT', 'TOTAL_PROFIT_RATE_SORT']) {
            for (let pg = 1; pg <= 3; pg++) {
              try {
                // Search might use trader_name or keyword param
                const r = await fetch(`/apiw/v2/copy/leader/query_cta_trader?page_num=${pg}&page_size=20&sort_field=${sf}&keyword=${encodeURIComponent(nick)}`)
                const j = await r.json()
                if (j?.data?.list?.length > 0) {
                  for (const t of j.data.list) {
                    if (t.strategy_profit_list?.length > 0) {
                      results.push({ nick: t.nickname, list: t.strategy_profit_list })
                    }
                  }
                }
              } catch {}
            }
          }
          return results
        }, username)

        for (const item of searchResult || []) {
          const profitList = item.list
          const n1 = computeCtaId(item.nick)
          const nick1 = item.nick.toLowerCase().replace(/[^a-z0-9]/g, '')
          let matched = n1 === ctaId || nick1 === username || nick1.startsWith(username)
          if (!matched && username.length >= 4 && nick1.length >= 6) matched = username.startsWith(nick1)
          if (matched && profitList.length > 0) {
            profitListFound.push(profitList)
          }
        }
      } catch (e) {
        console.log(`    ✗ Error: ${e.message}`)
      }

      await ctaPage.close()

      // Use the longest profit list we found
      if (profitListFound.length > 0) {
        const longestList = profitListFound.sort((a, b) => b.length - a.length)[0]
        const mdd = computeMddFromCumulative(longestList)
        const wr = computeWrFromCumulative(longestList)
        ctaResults.set(ctaId, { wr, mdd })
        console.log(`  ✓ ${ctaId}: wr=${wr} mdd=${mdd} (${longestList.length} data points)`)
      } else {
        console.log(`  ✗ ${ctaId}: no data found`)
      }
      await sleep(500)
    }
  }

  await browser.close()

  // ════════════════════════════════════════════════════════════
  // PHASE 5: Update DB
  // ════════════════════════════════════════════════════════════
  console.log('\n── Phase 5: Updating DB ──')
  console.log(`Numeric found: ${numericResults.size}/${numericIds.length}`)
  console.log(`CTA found: ${ctaResults.size}/${ctaIds.length}`)

  let updated = 0, skipped = 0

  for (const [traderId, rows] of byTrader) {
    const isNumeric = /^\d+$/.test(traderId)
    const isCta = traderId.startsWith('cta_')

    const data = isNumeric ? numericResults.get(traderId) : ctaResults.get(traderId)
    if (!data) {
      console.log(`  - ${traderId}: no data found, skipping ${rows.length} rows`)
      skipped += rows.length
      continue
    }

    for (const row of rows) {
      const updates = {}
      if (row.max_drawdown == null && data.mdd != null && !isNaN(data.mdd)) {
        updates.max_drawdown = parseFloat(data.mdd.toFixed(4))
      }
      if (row.win_rate == null && data.wr != null && !isNaN(data.wr)) {
        updates.win_rate = parseFloat(data.wr.toFixed(2))
      }
      if (Object.keys(updates).length === 0) { skipped++; continue }

      const { error } = await supabase.from('leaderboard_ranks').update(updates).eq('id', row.id)
      if (!error) {
        updated++
        console.log(`  ✓ ${traderId} ${row.season_id}: mdd=${updates.max_drawdown ?? '-'} wr=${updates.win_rate ?? '-'}`)
      } else {
        console.error(`  ✗ ${traderId} ${row.id}: ${error.message}`)
      }
    }
  }

  console.log(`\n✅ Updated: ${updated}, Skipped: ${skipped}`)

  // Final verification
  const { count: total } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE)
  const { count: mddNull } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('max_drawdown', null)
  const { count: wrNull } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('win_rate', null)
  console.log(`\nFinal DB: total=${total} mdd_null=${mddNull} wr_null=${wrNull}`)

  if (mddNull > 0) {
    const { data: remaining } = await supabase.from('leaderboard_ranks')
      .select('source_trader_id')
      .eq('source', SOURCE)
      .is('max_drawdown', null)
    const remainingIds = [...new Set(remaining.map(r => r.source_trader_id))]
    console.log(`\nStill missing MDD (${remainingIds.length} traders): ${remainingIds.join(', ')}`)
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
