#!/usr/bin/env node
/**
 * Gate.io MDD enrichment v3 - new approaches for stopped traders
 *
 * For numeric traders: use yield_curve API (works for stopped traders)
 * For CTA traders: direct profile page + all sort fields exhaustive search
 */
import { chromium } from 'playwright'
import { getSupabaseClient, sleep } from './lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'gateio'

function computeCtaId(nickname) {
  return 'cta_' + (nickname || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20)
}

// Compute MDD from cumulative profit_rate series (values in %, e.g. "8.73" = 8.73%)
function computeMddFromRates(profitList) {
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

function computeWrFromRates(profitList) {
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
  console.log('Gate.io MDD Enricher v3 - yield_curve + profile scraping')
  console.log(`${'='.repeat(60)}`)

  // Get current state
  const { data: allRows } = await supabase
    .from('leaderboard_ranks')
    .select('id, source_trader_id, season_id, win_rate, max_drawdown')
    .eq('source', SOURCE)
    .is('max_drawdown', null)

  if (!allRows?.length) {
    console.log('No rows need MDD enrichment!')
    return
  }

  const byTrader = new Map()
  for (const r of allRows) {
    if (!byTrader.has(r.source_trader_id)) byTrader.set(r.source_trader_id, [])
    byTrader.get(r.source_trader_id).push(r)
  }

  const numericIds = [...byTrader.keys()].filter(id => /^\d+$/.test(id))
  const ctaIds = [...byTrader.keys()].filter(id => id.startsWith('cta_'))

  console.log(`Total rows with null MDD: ${allRows.length}`)
  console.log(`Numeric traders needing MDD: ${numericIds.length}`)
  console.log(`CTA traders needing MDD: ${ctaIds.length}`)
  console.log(`CTA targets: ${ctaIds.join(', ')}`)

  // Launch browser
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()

  console.log('\nEstablishing session...')
  await page.goto('https://www.gate.com/copytrading', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  await sleep(3000)
  console.log('Session ready')

  const numericResults = new Map() // leaderId -> { mdd }
  const ctaResults = new Map()     // cta_id -> { wr, mdd }

  // ════════════════════════════════════════════════════════════
  // PHASE 1: Numeric traders — yield_curve approach
  // The yield_curve endpoint works even for stopped traders!
  // ════════════════════════════════════════════════════════════
  console.log(`\n── Phase 1: Numeric traders via yield_curve (${numericIds.length} traders) ──`)

  const cycles = ['quarter', 'month', 'week']

  for (let i = 0; i < numericIds.length; i++) {
    const traderId = numericIds[i]
    if (i % 10 === 0) console.log(`  [${i}/${numericIds.length}]`)

    let bestMdd = null

    for (const cycle of cycles) {
      if (bestMdd !== null) break

      const result = await page.evaluate(async ({ id, cycle }) => {
        try {
          const r = await fetch(`/apiw/v2/copy/api/leader/yield_curve?leader_id=${id}&cycle=${cycle}`, {
            credentials: 'include'
          })
          const j = await r.json()
          if (j?.code !== 0 || !j?.data) return null
          // The list contains cumulative yield curve data
          const list = j.data.list || j.data
          if (!Array.isArray(list) || list.length < 2) return null
          return list
        } catch { return null }
      }, { id: traderId, cycle })

      if (result && result.length >= 2) {
        // yield_curve data format - compute MDD
        // The list usually has { date, profit_rate } or similar
        const mdd = computeMddFromRates(result)
        if (mdd !== null) {
          bestMdd = mdd
          console.log(`  ✓ ${traderId} (${cycle}): mdd=${mdd} from ${result.length} points`)
        }
      }
      await sleep(100)
    }

    if (bestMdd !== null) {
      numericResults.set(traderId, { mdd: bestMdd })
    }
    await sleep(200)
  }

  console.log(`Phase 1 yield_curve: ${numericResults.size}/${numericIds.length} found`)

  // ════════════════════════════════════════════════════════════
  // PHASE 2: Numeric traders — individual detail page + API intercept
  // For traders not found via yield_curve
  // ════════════════════════════════════════════════════════════
  const stillMissingNumeric = numericIds.filter(id => !numericResults.has(id))
  if (stillMissingNumeric.length > 0) {
    console.log(`\n── Phase 2: ${stillMissingNumeric.length} numeric traders via profile page intercept ──`)

    for (let i = 0; i < stillMissingNumeric.length; i++) {
      const traderId = stillMissingNumeric[i]
      if (i % 5 === 0) console.log(`  [${i}/${stillMissingNumeric.length}]`)

      const detailPage = await context.newPage()
      let foundMdd = null

      const apiCalls = []
      detailPage.on('response', async (res) => {
        if (res.status() !== 200) return
        const url = res.url()
        if (!url.includes('gate')) return
        try {
          const ct = res.headers()['content-type'] || ''
          if (!ct.includes('json')) return
          const text = await res.text()
          if (!text.includes('max_drawdown') && !text.includes('yield_curve') && !text.includes('profit_rate')) return
          const j = JSON.parse(text)
          apiCalls.push({ url, data: j })
        } catch {}
      })

      try {
        // Try both gate.io and gate.com
        await detailPage.goto(`https://www.gate.com/copytrading/trader/${traderId}`, {
          waitUntil: 'networkidle', timeout: 20000
        }).catch(() => {})
        await sleep(2000)

        // Also trigger yield_curve from within the page context
        const yieldData = await detailPage.evaluate(async (id) => {
          const results = {}
          for (const cycle of ['quarter', 'month', 'week']) {
            try {
              const r = await fetch(`/apiw/v2/copy/api/leader/yield_curve?leader_id=${id}&cycle=${cycle}`, {credentials: 'include'})
              const j = await r.json()
              if (j?.code === 0 && j?.data) {
                results[cycle] = j.data
              }
            } catch {}
          }
          // Also try the detail endpoint
          try {
            const r2 = await fetch(`/apiw/v2/copy/leader/detail?leader_id=${id}`, {credentials: 'include'})
            const j2 = await r2.json()
            if (j2?.code === 0 && j2?.data) {
              results.detail = j2.data
            }
          } catch {}
          return results
        }, traderId)

        // Process yield data
        for (const [key, data] of Object.entries(yieldData || {})) {
          if (key === 'detail') {
            const t = data
            if (t.max_drawdown != null) {
              const mdd = Math.abs(parseFloat(t.max_drawdown))
              const mddf = mdd <= 1 ? mdd * 100 : mdd
              if (mddf > 0 || mddf === 0) {
                foundMdd = mddf
                console.log(`  ✓ ${traderId} detail: mdd=${mddf}`)
              }
            }
          } else {
            const list = Array.isArray(data) ? data : data.list
            if (list && list.length >= 2) {
              const mdd = computeMddFromRates(list)
              if (mdd !== null && foundMdd === null) {
                foundMdd = mdd
                console.log(`  ✓ ${traderId} yield_curve(${key}): mdd=${mdd} from ${list.length} pts`)
              }
            }
          }
        }
      } catch (e) {
        console.log(`  ✗ ${traderId}: ${e.message}`)
      }

      await detailPage.close()

      if (foundMdd !== null) {
        numericResults.set(traderId, { mdd: foundMdd })
      }
      await sleep(300)
    }

    const afterPhase2 = numericIds.filter(id => numericResults.has(id)).length
    console.log(`After Phase 2: ${afterPhase2}/${numericIds.length} numeric found`)
  }

  // ════════════════════════════════════════════════════════════
  // PHASE 3: CTA traders — Exhaustive pagination all sort fields
  // ════════════════════════════════════════════════════════════
  console.log(`\n── Phase 3: CTA traders exhaustive search ──`)

  const ctaUsernames = new Map()
  for (const ctaId of ctaIds) {
    ctaUsernames.set(ctaId.replace(/^cta_/, ''), ctaId)
  }

  // Get total pages
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
  ]

  for (const sortField of sortFields) {
    if (ctaResults.size >= ctaIds.length) break

    let newFound = 0
    console.log(`  ${sortField}...`)

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

      if (!batch?.length) break

      for (const t of batch) {
        const id1 = computeCtaId(t.nickname)
        const id2 = computeCtaId(t.nick_en)

        let matchedCtaId = null
        if (ctaIds.includes(id1) && !ctaResults.has(id1)) matchedCtaId = id1
        else if (ctaIds.includes(id2) && !ctaResults.has(id2)) matchedCtaId = id2

        // Also check substrings for fuzzy matching
        if (!matchedCtaId) {
          const nick1 = t.nickname.toLowerCase().replace(/[^a-z0-9]/g, '')
          const nick2 = t.nick_en.toLowerCase().replace(/[^a-z0-9]/g, '')
          for (const [username, ctaId] of ctaUsernames) {
            if (ctaResults.has(ctaId)) continue
            if (username.length >= 4) {
              if (nick1 === username || nick2 === username ||
                  nick1.startsWith(username) || nick2.startsWith(username) ||
                  username.startsWith(nick1.slice(0, 8)) || username.startsWith(nick2.slice(0, 8))) {
                matchedCtaId = ctaId
                break
              }
            }
          }
        }

        if (!matchedCtaId) continue

        const mdd = computeMddFromRates(t.profit_list)
        const wr = computeWrFromRates(t.profit_list)
        ctaResults.set(matchedCtaId, { wr, mdd })
        newFound++
        console.log(`  ✓ CTA ${matchedCtaId} (nick="${t.nickname}") pg=${pg}: wr=${wr} mdd=${mdd} list=${t.profit_list.length}`)
      }

      if (pg % 50 === 0) {
        console.log(`  ${sortField} pg${pg}: ${ctaResults.size}/${ctaIds.length} found`)
      }

      await sleep(80)
    }
    console.log(`  After ${sortField}: ${ctaResults.size}/${ctaIds.length} CTA found (+${newFound})`)
  }

  // ════════════════════════════════════════════════════════════
  // PHASE 4: CTA — direct profile page scraping for misses
  // ════════════════════════════════════════════════════════════
  const missingCtas = ctaIds.filter(id => !ctaResults.has(id))
  if (missingCtas.length > 0) {
    console.log(`\n── Phase 4: Direct profile pages for ${missingCtas.length} missing CTA traders ──`)

    for (const ctaId of missingCtas) {
      const username = ctaId.replace(/^cta_/, '')
      console.log(`  Trying: ${ctaId}`)

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
            if (!matched && username.length >= 4) {
              matched = nick1 === username || nick2 === username ||
                        nick1.startsWith(username) || nick2.startsWith(username) ||
                        username.startsWith(nick1.slice(0, 8)) || username.startsWith(nick2.slice(0, 8))
            }
            if (!matched) continue

            const profitList = t.strategy_profit_list || []
            const mdd = computeMddFromRates(profitList)
            const wr = computeWrFromRates(profitList)
            if (mdd !== null) best = { wr, mdd }
          }
        } catch {}
      })

      try {
        await ctaPage.goto(`https://www.gate.com/copytrading/trader/${username}`, {
          waitUntil: 'networkidle', timeout: 20000
        }).catch(() => {})
        await sleep(3000)

        // Also try fetching directly from within the page
        const directResult = await ctaPage.evaluate(async (nick) => {
          const results = []
          // Try searching with trader name
          for (const sf of ['NINETY_PROFIT_RATE_SORT', 'COPY_USER_COUNT_SORT']) {
            try {
              const r = await fetch(`/apiw/v2/copy/leader/query_cta_trader?page_num=1&page_size=20&sort_field=${sf}&trader_name=${nick}`)
              const j = await r.json()
              if (j?.data?.list?.length > 0) {
                for (const t of j.data.list) {
                  if (t.strategy_profit_list?.length > 0) {
                    results.push(t.strategy_profit_list)
                  }
                }
              }
            } catch {}
          }
          
          // Try gate.io (not gate.com) API
          try {
            const r = await fetch(`https://www.gate.io/apiw/v2/copy/leader/query_cta_trader?page_num=1&page_size=5&trader_name=${nick}&sort_field=TOTAL_PROFIT_RATE_SORT`)
            const j = await r.json()
            if (j?.data?.list?.length > 0) {
              for (const t of j.data.list) {
                if (t.strategy_profit_list?.length > 0) {
                  results.push(t.strategy_profit_list)
                }
              }
            }
          } catch {}

          return results
        }, username)

        if (directResult?.length > 0) {
          for (const profitList of directResult) {
            const mdd = computeMddFromRates(profitList)
            const wr = computeWrFromRates(profitList)
            if (mdd !== null && !best) best = { wr, mdd }
          }
        }
      } catch (e) {
        console.log(`  ✗ ${ctaId}: ${e.message}`)
      }

      await ctaPage.close()

      if (best) {
        ctaResults.set(ctaId, best)
        console.log(`  ✓ Found: ${ctaId} wr=${best.wr} mdd=${best.mdd}`)
      } else {
        console.log(`  ✗ Not found: ${ctaId}`)
      }
      await sleep(500)
    }
  }

  await browser.close()

  // ════════════════════════════════════════════════════════════
  // PHASE 5: Update DB
  // ════════════════════════════════════════════════════════════
  console.log('\n── Phase 5: Updating DB ──')
  console.log(`Results: numeric=${numericResults.size}/${numericIds.length}, CTA=${ctaResults.size}/${ctaIds.length}`)

  let updated = 0, skipped = 0

  for (const [traderId, rows] of byTrader) {
    const isNumeric = /^\d+$/.test(traderId)
    const isCta = traderId.startsWith('cta_')

    const data = isNumeric ? numericResults.get(traderId) : ctaResults.get(traderId)
    if (!data) { skipped += rows.length; continue }

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
        console.error(`  ✗ ${traderId}: ${error.message}`)
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
    const remaining_ids = [...new Set(remaining.map(r => r.source_trader_id))]
    console.log(`Still missing (${remaining_ids.length} traders): ${remaining_ids.join(', ')}`)
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
