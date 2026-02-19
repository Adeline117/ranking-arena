#!/usr/bin/env node
/**
 * Compute roi_7d/roi_30d from pnl_7d/pnl_30d + aum
 * 
 * Formula: roi = (pnl / aum) * 100
 * This is an approximation since aum is current, not start-of-period.
 * Only applied where both pnl and aum exist but roi is null.
 * 
 * Usage:
 *   node scripts/compute-roi-from-pnl.mjs
 *   node scripts/compute-roi-from-pnl.mjs --dry-run
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const DRY_RUN = process.argv.includes('--dry-run')

async function main() {
  console.log('Computing roi_7d/roi_30d from pnl + aum')
  if (DRY_RUN) console.log('[DRY RUN]')

  let total = 0, updated = 0

  for (const [period, roiCol, pnlCol] of [['7d', 'roi_7d', 'pnl_7d'], ['30d', 'roi_30d', 'pnl_30d']]) {
    let offset = 0
    while (true) {
      const { data, error } = await supabase.from('trader_snapshots')
        .select(`id, source, ${pnlCol}, ${roiCol}, aum`)
        .is(roiCol, null)
        .not(pnlCol, 'is', null)
        .not('aum', 'is', null)
        .gt('aum', 0)
        .range(offset, offset + 999)
      
      if (error) { console.error('DB error:', error.message); break }
      if (!data?.length) break

      for (const row of data) {
        const pnl = row[pnlCol]
        const aum = row.aum
        if (aum <= 0) continue

        const roi = parseFloat(((pnl / aum) * 100).toFixed(2))
        
        // Sanity check: skip extreme values (> 10000% or < -100%)
        if (roi > 10000 || roi < -100) {
          if (DRY_RUN) console.log(`  [SKIP] ${row.source} id=${row.id} roi=${roi}% (extreme)`)
          continue
        }

        total++
        if (DRY_RUN) {
          console.log(`  ${row.source} id=${row.id}: ${roiCol}=${roi}% (pnl=${pnl}, aum=${aum})`)
        } else {
          const { error: e } = await supabase.from('trader_snapshots')
            .update({ [roiCol]: roi })
            .eq('id', row.id)
          if (!e) updated++
        }
      }

      if (data.length < 1000) break
      offset += 1000
    }
  }

  console.log(`\nDONE: processed=${total} updated=${updated}`)
}

main().catch(console.error)
