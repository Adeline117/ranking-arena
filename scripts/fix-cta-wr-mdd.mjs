#!/usr/bin/env node
/**
 * Gate.io CTA trader WR/MDD enricher
 * Target: 14 unique CTA traders in leaderboard_ranks with null win_rate
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function computeCtaId(nickname) {
  return 'cta_' + nickname.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20)
}

function computeCtaStats(profitList) {
  if (!profitList || profitList.length < 2) return { wr: null, mdd: null }
  const sorted = [...profitList].sort((a, b) => Number(a.trade_date) - Number(b.trade_date))
  const rates = sorted.map(d => parseFloat(d.profit_rate || 0))

  // MDD
  let peak = rates[0], mdd = 0
  for (const r of rates) {
    if (r > peak) peak = r
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
  console.log('='.repeat(60))
  console.log('Gate.io CTA WR/MDD Enricher')
  console.log('='.repeat(60))

  // Get all rows needing enrichment
  const { data: rows, error } = await supabase
    .from('leaderboard_ranks')
    .select('id, source_trader_id, season_id, win_rate, max_drawdown')
    .eq('source', 'gateio')
    .is('win_rate', null)

  if (error) { console.error('DB error:', error.message); process.exit(1) }
  console.log(`Rows needing WR: ${rows.length}`)

  const byTrader = new Map()
  for (const r of rows) {
    if (!byTrader.has(r.source_trader_id)) byTrader.set(r.source_trader_id, [])
    byTrader.get(r.source_trader_id).push(r)
  }
  const ctaIds = [...byTrader.keys()]
  console.log(`Unique CTA traders: ${ctaIds.length}`)
  console.log('Targets:', ctaIds)

  // Build username -> ctaId map
  const usernameToCtaId = new Map()
  for (const ctaId of ctaIds) {
    const username = ctaId.replace(/^cta_/, '')
    usernameToCtaId.set(username, ctaId)
  }

  const results = new Map() // ctaId -> { wr, mdd }

  // Launch browser
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
  })
  const page = await context.newPage()

  // ── Establish session ──
  console.log('\nEstablishing Gate.io session...')
  await page.goto('https://www.gate.io/copytrading', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  await sleep(4000)
  console.log('Session ready. Title:', await page.title().catch(() => '?'))

  // ── Phase 1: Test what CTA API returns ──
  console.log('\n── Phase 1: Testing query_cta_trader API ──')

  const testResult = await page.evaluate(async () => {
    const urls = [
      '/apiw/v2/copy/leader/query_cta_trader?page_num=1&page_size=20&sort_field=NINETY_PROFIT_RATE_SORT',
      '/apiw/v2/copy/leader/query_cta_trader?page_num=1&page_size=100&sort_field=NINETY_PROFIT_RATE_SORT',
    ]
    const out = []
    for (const url of urls) {
      try {
        const r = await fetch(url, { credentials: 'include' })
        const text = await r.text()
        let j
        try { j = JSON.parse(text) } catch { j = text.slice(0, 200) }
        out.push({ url, status: r.status, data: j })
      } catch (e) {
        out.push({ url, error: String(e) })
      }
    }
    return out
  })

  for (const t of testResult) {
    console.log(`URL: ${t.url}`)
    console.log(`  Status: ${t.status || 'error'}`)
    if (t.error) console.log(`  Error: ${t.error}`)
    else {
      const d = t.data
      console.log(`  Code: ${d?.code}, Total: ${d?.data?.totalcount}, Pages: ${d?.data?.pagecount}`)
      const sample = d?.data?.list?.[0]
      if (sample) {
        console.log(`  Sample fields: ${Object.keys(sample).join(', ')}`)
        console.log(`  Sample nickname: ${sample.nickname || sample.nick || 'n/a'}`)
        console.log(`  Sample has profit_list: ${!!(sample.strategy_profit_list || sample.profit_list)}`)
      } else {
        console.log(`  Raw: ${JSON.stringify(d).slice(0, 300)}`)
      }
    }
  }

  // ── Phase 2: Paginate through ALL CTA traders ──
  console.log('\n── Phase 2: Full CTA pagination ──')

  const ctaMeta = await page.evaluate(async () => {
    try {
      const r = await fetch('/apiw/v2/copy/leader/query_cta_trader?page_num=1&page_size=20&sort_field=NINETY_PROFIT_RATE_SORT', { credentials: 'include' })
      const j = await r.json()
      return { pagecount: j?.data?.pagecount || 0, totalcount: j?.data?.totalcount || 0, code: j?.code }
    } catch (e) { return { error: String(e) } }
  }).catch(() => ({}))

  console.log(`CTA total: ${ctaMeta.totalcount} traders, ${ctaMeta.pagecount} pages, code=${ctaMeta.code}`)

  const sortFields = [
    'NINETY_PROFIT_RATE_SORT',
    'THIRTY_PROFIT_RATE_SORT',
    'SEVEN_PROFIT_RATE_SORT',
    'COPY_USER_COUNT_SORT',
    'TOTAL_PROFIT_RATE_SORT',
  ]

  for (const sortField of sortFields) {
    if (results.size >= ctaIds.length) break
    let foundNew = 0
    const maxPages = Math.max(ctaMeta.pagecount || 10, 50) // try at least 50 pages

    for (let pg = 1; pg <= maxPages; pg++) {
      const batch = await page.evaluate(async ({ pg, sortField }) => {
        try {
          const url = `/apiw/v2/copy/leader/query_cta_trader?page_num=${pg}&page_size=20&sort_field=${sortField}`
          const r = await fetch(url, { credentials: 'include' })
          if (!r.ok) return { error: r.status }
          const j = await r.json()
          if (j?.code !== 0) return { error: `code=${j?.code}`, msg: j?.message }
          return { list: j.data?.list || [], total: j.data?.totalcount }
        } catch (e) { return { error: String(e) } }
      }, { pg, sortField }).catch(() => ({ error: 'evaluate failed' }))

      if (batch.error) {
        if (pg === 1) console.log(`  ${sortField}: API error: ${batch.error} ${batch.msg || ''}`)
        break
      }

      const list = batch.list || []
      if (list.length === 0) break

      for (const t of list) {
        const nick = t.nickname || t.nick || ''
        if (!nick) continue

        // Direct computed match
        const computedId = computeCtaId(nick)
        let matchedCtaId = results.has(computedId) ? null : ctaIds.includes(computedId) ? computedId : null

        // Fallback: substring/prefix match
        if (!matchedCtaId) {
          const nickLower = nick.toLowerCase().replace(/[^a-z0-9]/g, '')
          for (const [username, ctaId] of usernameToCtaId) {
            if (results.has(ctaId)) continue
            if (nickLower === username || nickLower.startsWith(username) || username.startsWith(nickLower)) {
              matchedCtaId = ctaId
              break
            }
          }
        }

        if (!matchedCtaId) continue

        const profitList = t.strategy_profit_list || t.profit_list || []
        const stats = computeCtaStats(profitList)

        if (stats.wr != null || stats.mdd != null) {
          results.set(matchedCtaId, stats)
          foundNew++
          console.log(`  ✓ ${matchedCtaId} (nick="${nick}") pg=${pg}: wr=${stats.wr} mdd=${stats.mdd} (${profitList.length} data points)`)
        } else {
          // Even without a profit list, maybe there are direct fields
          const wr = t.win_rate != null ? parseFloat(t.win_rate) : null
          const mdd = t.max_drawdown != null ? Math.abs(parseFloat(t.max_drawdown)) : null
          const wrf = wr != null && wr <= 1 ? wr * 100 : wr
          const mddf = mdd != null && mdd <= 1 ? mdd * 100 : mdd
          if (wrf != null || mddf != null) {
            results.set(matchedCtaId, { wr: wrf, mdd: mddf })
            foundNew++
            console.log(`  ✓ ${matchedCtaId} (nick="${nick}") direct fields: wr=${wrf} mdd=${mddf}`)
          }
        }
      }

      if (results.size >= ctaIds.length) break
      if (batch.total && pg * 20 >= batch.total) break // past end
      await sleep(200)
    }
    console.log(`  After ${sortField}: ${results.size}/${ctaIds.length} found (+${foundNew} new)`)
  }

  // ── Phase 3: Direct profile page intercept for remaining ──
  const missing = ctaIds.filter(id => !results.has(id))
  console.log(`\n── Phase 3: Direct profile pages for ${missing.length} missing ──`)

  // First let's see what fields the CTA trader page has
  if (missing.length > 0) {
    console.log('\nFirst, checking what CTA profile page returns...')
    const testUsername = missing[0].replace(/^cta_/, '')
    const testPage = await context.newPage()
    const capturedApis = []

    testPage.on('response', async (res) => {
      const url = res.url()
      if (res.status() !== 200) return
      if (!url.includes('gate')) return
      try {
        const ct = res.headers()['content-type'] || ''
        if (!ct.includes('json')) return
        const j = await res.json()
        if (!j?.data) return
        capturedApis.push({ url: url.slice(0, 150), preview: JSON.stringify(j).slice(0, 400) })
      } catch {}
    })

    // Try fund-manager/detail URL
    const testUrls = [
      `https://www.gate.io/en/fund-manager/detail/${testUsername}`,
      `https://www.gate.io/fund-manager/detail/${testUsername}`,
      `https://www.gate.io/copytrading/trader/${testUsername}`,
      `https://www.gate.com/fund-manager/detail/${testUsername}`,
    ]

    for (const url of testUrls) {
      capturedApis.length = 0
      await testPage.goto(url, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {})
      await sleep(3000)
      if (capturedApis.length > 0) {
        console.log(`\n  URLs captured at ${url}:`)
        for (const a of capturedApis.slice(0, 10)) {
          console.log(`    ${a.url}`)
          console.log(`    ${a.preview.slice(0, 200)}`)
        }
        break
      } else {
        console.log(`  No JSON APIs at: ${url}`)
      }
    }
    await testPage.close()
  }

  // Now try each missing trader via profile page intercept
  for (const ctaId of missing) {
    const username = ctaId.replace(/^cta_/, '')
    console.log(`\n  Trying ${ctaId} (username: ${username})`)

    const ctaPage = await context.newPage()
    let bestStats = null
    let foundLongest = 0

    ctaPage.on('response', async (res) => {
      const url = res.url()
      if (res.status() !== 200) return
      try {
        const ct = res.headers()['content-type'] || ''
        if (!ct.includes('json')) return
        const j = await res.json()
        if (!j?.data) return

        const list = Array.isArray(j.data.list) ? j.data.list : Array.isArray(j.data) ? j.data : [j.data]

        for (const t of list) {
          const nick = t.nickname || t.nick || ''
          const nickLower = nick.toLowerCase().replace(/[^a-z0-9]/g, '')
          const computedId = computeCtaId(nick)

          const isMatch = computedId === ctaId || nickLower === username ||
            nickLower.startsWith(username) || username.startsWith(nickLower)

          if (!isMatch) continue

          const profitList = t.strategy_profit_list || t.profit_list || []
          if (profitList.length > foundLongest) {
            foundLongest = profitList.length
            const stats = computeCtaStats(profitList)
            bestStats = stats
            console.log(`    Captured from ${url.slice(0, 100)}: ${profitList.length} profit points`)
          }

          // Also check direct fields
          const wr = t.win_rate != null ? parseFloat(t.win_rate) : null
          const mdd = t.max_drawdown != null ? Math.abs(parseFloat(t.max_drawdown)) : null
          const wrf = wr != null && wr <= 1 ? wr * 100 : wr
          const mddf = mdd != null && mdd <= 1 ? mdd * 100 : mdd
          if ((wrf != null || mddf != null) && bestStats == null) {
            bestStats = { wr: wrf, mdd: mddf }
            console.log(`    Direct fields from ${url.slice(0, 100)}: wr=${wrf} mdd=${mddf}`)
          }
        }
      } catch {}
    })

    // Try multiple URL patterns
    const urlsToTry = [
      `https://www.gate.com/copytrading/trader/${username}`,
      `https://www.gate.io/fund-manager/detail/${username}`,
      `https://www.gate.io/en/fund-manager/detail/${username}`,
    ]

    for (const url of urlsToTry) {
      await ctaPage.goto(url, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {})
      await sleep(2000)
      if (bestStats) break
    }

    await ctaPage.close()

    if (bestStats && (bestStats.wr != null || bestStats.mdd != null)) {
      results.set(ctaId, bestStats)
      console.log(`  ✓ Found via profile page: ${ctaId} wr=${bestStats.wr} mdd=${bestStats.mdd}`)
    } else {
      console.log(`  ✗ Not found: ${ctaId}`)
    }
    await sleep(500)
  }

  await browser.close()

  // ── Phase 4: Update DB ──
  console.log('\n── Phase 4: Updating DB ──')
  let updated = 0, skipped = 0

  for (const [ctaId, ctaRows] of byTrader) {
    const data = results.get(ctaId)
    if (!data) {
      console.log(`  ✗ No data for ${ctaId} — skipping ${ctaRows.length} rows`)
      skipped += ctaRows.length
      continue
    }

    for (const row of ctaRows) {
      const updates = {}
      if (row.win_rate == null && data.wr != null && !isNaN(data.wr)) {
        updates.win_rate = parseFloat(data.wr.toFixed(2))
      }
      if (row.max_drawdown == null && data.mdd != null && !isNaN(data.mdd)) {
        updates.max_drawdown = parseFloat(data.mdd.toFixed(2))
      }
      if (Object.keys(updates).length === 0) {
        skipped++
        continue
      }

      const { error } = await supabase.from('leaderboard_ranks').update(updates).eq('id', row.id)
      if (!error) {
        updated++
        console.log(`  ✓ ${ctaId} ${row.season_id}: wr=${updates.win_rate} mdd=${updates.max_drawdown}`)
      } else {
        console.error(`  ✗ DB error for ${ctaId}: ${error.message}`)
      }
    }
  }

  console.log(`\n✅ Updated: ${updated} rows, Skipped: ${skipped} rows`)

  // ── Verify ──
  const { count: wrNull } = await supabase
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'gateio')
    .is('win_rate', null)
  console.log(`\nRemaining win_rate=NULL for gateio: ${wrNull}`)

  if (results.size === 0 && updated === 0) {
    console.log('\n⚠️  ZERO results found. Summary of what was tried:')
    console.log('  - query_cta_trader API (multiple sort fields, all pages)')
    console.log('  - Individual profile page intercept (gate.io/gate.com)')
    console.log('  - Nicknames tried:', ctaIds.map(id => id.replace('cta_','')).join(', '))
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
