/**
 * OKX Futures MDD Enrichment - 从API重新计算MDD
 * 修复238个NULL MDD记录
 */

import {
  getSupabaseClient,
  sleep,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'okx_futures'
const API_URL = 'https://www.okx.com/api/v5/copytrading/public-lead-traders'

const WINDOW_DAYS = { '30D': 30, '90D': 90 }

/**
 * 从 pnlRatios 计算 MDD
 */
function computeMDD(pnlRatios, period) {
  if (!Array.isArray(pnlRatios) || pnlRatios.length < 2) {
    return null
  }

  const sorted = [...pnlRatios].sort((a, b) => parseInt(a.beginTs) - parseInt(b.beginTs))
  const days = WINDOW_DAYS[period] || 90
  const relevant = sorted.slice(-days)

  if (relevant.length < 2) return null

  const equityCurve = relevant.map(r => 1 + parseFloat(r.pnlRatio))
  let peak = equityCurve[0]
  let maxDrawdown = 0
  
  for (const eq of equityCurve) {
    if (eq > peak) peak = eq
    if (peak > 0) {
      const dd = ((peak - eq) / peak) * 100
      if (dd > maxDrawdown) maxDrawdown = dd
    }
  }

  return maxDrawdown > 0 && maxDrawdown < 100 ? maxDrawdown : null
}

/**
 * 从API获取trader详情
 */
async function fetchTraderDetails(uniqueCode) {
  try {
    const url = `${API_URL}?instType=SWAP&uniqueName=${uniqueCode}`
    const response = await fetch(url, {
      headers: { 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9' }
    })

    if (!response.ok) return null

    const json = await response.json()
    if (json.code !== '0' || !json.data?.[0]?.ranks?.[0]) return null

    return json.data[0].ranks[0]
  } catch {
    return null
  }
}

async function main() {
  const period = process.argv[2] || '30D'
  
  console.log(`\n${'='.repeat(60)}`)
  console.log(`OKX Futures MDD Enrichment — ${period}`)
  console.log(`${'='.repeat(60)}`)

  // 1. Get all OKX traders with NULL MDD
  const { data: nullRecords } = await supabase
    .from('leaderboard_ranks')
    .select('id, source_trader_id, roi, win_rate, max_drawdown')
    .eq('source', SOURCE)
    .is('max_drawdown', null)

  console.log(`Found ${nullRecords?.length || 0} records with NULL MDD`)
  
  if (!nullRecords || nullRecords.length === 0) {
    console.log('✅ No records to enrich')
    return
  }

  let updated = 0
  let noData = 0
  let errors = 0

  for (let i = 0; i < nullRecords.length; i++) {
    const record = nullRecords[i]
    
    if ((i + 1) % 50 === 0) {
      console.log(`  [${i + 1}/${nullRecords.length}] updated=${updated} noData=${noData} errors=${errors}`)
    }

    try {
      await sleep(600) // Rate limit
      
      const details = await fetchTraderDetails(record.source_trader_id)
      
      if (!details || !details.pnlRatios) {
        noData++
        continue
      }

      const mdd = computeMDD(details.pnlRatios, period)
      
      if (mdd === null || mdd === 0) {
        noData++
        continue
      }

      // Update database
      const { error } = await supabase
        .from('leaderboard_ranks')
        .update({ max_drawdown: mdd })
        .eq('id', record.id)

      if (error) {
        console.error(`  ❌ Update error for ${record.source_trader_id}:`, error.message)
        errors++
      } else {
        updated++
      }

    } catch (err) {
      console.error(`  ❌ Error processing ${record.source_trader_id}:`, err.message)
      errors++
    }
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ OKX Futures MDD enrichment done`)
  console.log(`   Updated: ${updated}`)
  console.log(`   No data: ${noData}`)
  console.log(`   Errors: ${errors}`)
  console.log(`${'='.repeat(60)}`)

  // Verify results
  const { count: remaining } = await supabase
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', SOURCE)
    .is('max_drawdown', null)

  console.log(`\nRemaining NULL MDD: ${remaining}`)
}

main().catch(console.error)
