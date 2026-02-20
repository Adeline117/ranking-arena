import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

for (const src of ['bingx', 'bingx_spot']) {
  for (const tbl of ['leaderboard_ranks', 'trader_snapshots']) {
    const { count: total } = await sb.from(tbl).select('*', { count: 'exact', head: true }).eq('source', src)
    const { count: mddNull } = await sb.from(tbl).select('*', { count: 'exact', head: true }).eq('source', src).is('max_drawdown', null)
    const { count: wrNull } = await sb.from(tbl).select('*', { count: 'exact', head: true }).eq('source', src).is('win_rate', null)
    console.log(`${tbl} source='${src}': total=${total} mdd_null=${mddNull} wr_null=${wrNull}`)
  }
}
