#!/usr/bin/env node
/**
 * Gate.io WR/MDD完整enrichment（重启版）
 * 
 * 数据来源：
 * 1. Futures traders（数字ID）：已有100%覆盖率，跳过
 * 2. CTA traders（cta_前缀）：从strategy_profit_list计算WR/MDD
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

/**
 * Calculate Win Rate and Max Drawdown from daily profit history
 */
function computeCtaStats(profitList) {
  if (!profitList || profitList.length < 2) return { wr: null, mdd: null }
  
  const sorted = [...profitList].sort((a, b) => Number(a.trade_date) - Number(b.trade_date))
  const rates = sorted.map(d => parseFloat(d.profit_rate || 0))

  // Max Drawdown
  let peak = rates[0], mdd = 0
  for (const r of rates) {
    if (r > peak) peak = r
    const dd = peak > -100 ? ((peak - r) / (1 + peak / 100)) : 0
    if (dd > mdd) mdd = dd
  }

  // Win Rate: % of trading days where portfolio value increased
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

/**
 * Compute CTA ID from nickname (must match database format)
 */
function computeCtaId(nickname) {
  return 'cta_' + nickname.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20)
}

async function main() {
  console.log('='.repeat(70))
  console.log('Gate.io WR/MDD Complete Enrichment')
  console.log('='.repeat(70))

  // Get all CTA IDs needing enrichment
  const { data: rows, error } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, season_id, win_rate, max_drawdown')
    .eq('source', 'gateio')
    .like('source_trader_id', 'cta_%')
    .is('win_rate', null)

  if (error) {
    console.error('❌ Database error:', error.message)
    process.exit(1)
  }

  console.log(`\n📊 Found ${rows.length} CTA records needing WR/MDD`)

  if (rows.length === 0) {
    console.log('✅ All CTA traders already have WR/MDD data!')
    process.exit(0)
  }

  // Group by trader ID
  const byTrader = new Map()
  for (const r of rows) {
    if (!byTrader.has(r.source_trader_id)) {
      byTrader.set(r.source_trader_id, [])
    }
    byTrader.get(r.source_trader_id).push(r)
  }

  const ctaIds = [...byTrader.keys()]
  console.log(`📋 Unique CTA traders: ${ctaIds.length}`)
  console.log(`   Sample IDs: ${ctaIds.slice(0, 3).join(', ')}`)

  // Build username map for matching
  const usernameToCtaId = new Map()
  for (const ctaId of ctaIds) {
    const username = ctaId.replace(/^cta_/, '')
    usernameToCtaId.set(username, ctaId)
  }

  const results = new Map() // ctaId -> { wr, mdd }

  // Launch browser
  console.log('\n🌐 Launching browser...')
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
  })

  const page = await context.newPage()

  try {
    console.log('📡 Establishing Gate.io session...')
    await page.goto('https://www.gate.io/copytrading', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    }).catch(() => {})

    await sleep(5000)
    console.log('✅ Session ready')

    // Fetch CTA traders and match with our database
    console.log('\n🔍 Fetching CTA trader data...')

    const sortFields = [
      'NINETY_PROFIT_RATE_SORT',
      'THIRTY_PROFIT_RATE_SORT',
      'SEVEN_PROFIT_RATE_SORT',
      'COPY_USER_COUNT_SORT',
    ]

    let totalFetched = 0

    for (const sortField of sortFields) {
      if (results.size >= ctaIds.length) break

      console.log(`\n  Fetching ${sortField}...`)
      let pageNum = 1
      let consecutiveEmpty = 0

      while (pageNum <= 50 && consecutiveEmpty < 3) {
        const batch = await page.evaluate(async ({ pageNum, sortField }) => {
          try {
            const url = `/apiw/v2/copy/leader/query_cta_trader?page_num=${pageNum}&page_size=50&sort_field=${sortField}`
            const r = await fetch(url, { credentials: 'include' })
            if (!r.ok) return { error: r.status }
            const j = await r.json()
            if (j?.code !== 0) return { error: `code=${j?.code}` }
            return { list: j.data?.list || [] }
          } catch (e) {
            return { error: String(e) }
          }
        }, { pageNum, sortField }).catch(() => ({ error: 'evaluate failed' }))

        if (batch.error) {
          console.log(`    ⚠️  Page ${pageNum} error: ${batch.error}`)
          break
        }

        const list = batch.list || []
        if (list.length === 0) {
          consecutiveEmpty++
          pageNum++
          continue
        }

        consecutiveEmpty = 0
        let foundInPage = 0

        for (const t of list) {
          const nick = t.nickname || t.nick || ''
          if (!nick) continue

          totalFetched++

          // Try exact match
          const computedId = computeCtaId(nick)
          let matchedCtaId = results.has(computedId) ? null : ctaIds.includes(computedId) ? computedId : null

          // Fallback: fuzzy match
          if (!matchedCtaId) {
            const nickLower = nick.toLowerCase().replace(/[^a-z0-9]/g, '')
            for (const [username, ctaId] of usernameToCtaId) {
              if (results.has(ctaId)) continue
              if (nickLower === username || 
                  nickLower.startsWith(username) || 
                  username.startsWith(nickLower)) {
                matchedCtaId = ctaId
                break
              }
            }
          }

          if (matchedCtaId && t.strategy_profit_list) {
            const stats = computeCtaStats(t.strategy_profit_list)
            if (stats.wr !== null || stats.mdd !== null) {
              results.set(matchedCtaId, stats)
              foundInPage++
            }
          }
        }

        console.log(`    Page ${pageNum}: ${list.length} traders, found ${foundInPage} matches (total: ${results.size}/${ctaIds.length})`)

        pageNum++
        await sleep(500)
      }
    }

    console.log(`\n📊 Fetch complete: ${totalFetched} total traders scanned`)
    console.log(`   Matched: ${results.size}/${ctaIds.length}`)

    // Update database
    console.log('\n💾 Updating database...')

    let updated = 0
    let skipped = 0

    for (const [ctaId, stats] of results) {
      const rows = byTrader.get(ctaId) || []
      
      for (const row of rows) {
        const updates = {}
        if (stats.wr !== null) updates.win_rate = stats.wr
        if (stats.mdd !== null) updates.max_drawdown = stats.mdd

        if (Object.keys(updates).length > 0) {
          const { error: updateError } = await sb
            .from('leaderboard_ranks')
            .update(updates)
            .eq('id', row.id)

          if (updateError) {
            console.log(`  ❌ Failed to update ID ${row.id}: ${updateError.message}`)
          } else {
            updated++
          }
        }
      }

      if (rows.length > 0) {
        console.log(`  ✅ ${ctaId}: WR=${stats.wr}, MDD=${stats.mdd} (${rows.length} records)`)
      }
    }

    // Report unmatched
    const unmatched = ctaIds.filter(id => !results.has(id))
    if (unmatched.length > 0) {
      console.log(`\n⚠️  Unmatched CTA IDs (${unmatched.length}):`)
      unmatched.slice(0, 10).forEach(id => console.log(`     ${id}`))
      if (unmatched.length > 10) {
        console.log(`     ... and ${unmatched.length - 10} more`)
      }
    }

    // Final stats
    console.log('\n' + '='.repeat(70))
    console.log('✅ Enrichment complete!')
    console.log(`   Updated: ${updated} records`)
    console.log(`   Unmatched: ${unmatched.length} CTA IDs`)
    console.log(`   Coverage: ${((results.size / ctaIds.length) * 100).toFixed(2)}%`)
    console.log('='.repeat(70))

  } catch (error) {
    console.error('\n❌ Fatal error:', error)
    throw error
  } finally {
    await browser.close()
  }
}

main().catch(error => {
  console.error('Fatal error:', error)
  process.exit(1)
})
