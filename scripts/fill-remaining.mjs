import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
const sb = createClient(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const { INLINE_FETCHERS } = await import('../lib/cron/fetchers/index.ts')

for (const p of ['gmx', 'xt']) {
  console.log(`🔄 ${p}`)
  try {
    const r = await INLINE_FETCHERS[p](sb, ['7D', '30D', '90D'])
    for (const [period, res] of Object.entries(r.periods)) {
      console.log(`   ${period}: ${res.saved}/${res.total} ${res.error || ''}`)
    }
  } catch (e) { console.log(`   ❌ ${e.message}`) }
}
console.log('Done')
