import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const { INLINE_FETCHERS } = await import('../lib/cron/fetchers/index.ts')

const WORKING = ['okx_futures', 'okx_web3', 'htx', 'gains', 'hyperliquid', 'gmx', 'xt']
const ALL_PERIODS = ['7D', '30D', '90D']

let totalSaved = 0

for (const p of WORKING) {
  console.log(`\n🔄 ${p} (7D+30D+90D)...`)
  try {
    const r = await INLINE_FETCHERS[p](sb, ALL_PERIODS)
    for (const [period, res] of Object.entries(r.periods)) {
      console.log(`   ${period}: ${res.saved}/${res.total} saved ${res.error ? '⚠️ ' + res.error : ''}`)
      totalSaved += res.saved || 0
    }
    console.log(`   ⏱ ${(r.duration / 1000).toFixed(1)}s`)
  } catch (e) {
    console.log(`   ❌ ${e.message}`)
  }
}

console.log(`\n✅ Done — ${totalSaved} total records saved`)
