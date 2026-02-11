#!/usr/bin/env node
/**
 * VPS Data Freshness Health Check + Auto-Recovery
 * 
 * Checks if any platform data is stale (>4h) and re-runs the import.
 * Designed to run via cron every 2 hours on VPS.
 * 
 * Usage: node scripts/vps-health-check.mjs
 */
import { createClient } from '@supabase/supabase-js'
import { execSync } from 'child_process'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const STALE_THRESHOLD_HOURS = 4

// VPS-managed platforms and their import scripts
const VPS_PLATFORMS = {
  binance_futures: 'import_binance_futures_v2.mjs',
  binance_spot: 'import_binance_spot_v2.mjs',
  binance_web3: 'import_binance_web3_v2.mjs',
  bybit: 'import_bybit_v2.mjs',
  bybit_spot: 'import_bybit_spot.mjs',
  bitget_futures: 'import_bitget_futures_v2.mjs',
  bitget_spot: 'import_bitget_spot_v2.mjs',
  htx_futures: 'import_htx_futures.mjs',
}

async function checkFreshness() {
  const stale = []
  
  for (const [source, script] of Object.entries(VPS_PLATFORMS)) {
    const { data } = await supabase
      .from('trader_snapshots')
      .select('captured_at')
      .eq('source', source)
      .order('captured_at', { ascending: false })
      .limit(1)
    
    if (!data?.[0]) {
      console.log(`  ${source}: NO DATA — needs recovery`)
      stale.push({ source, script, age: Infinity })
      continue
    }
    
    const ageHours = (Date.now() - new Date(data[0].captured_at).getTime()) / 3600000
    if (ageHours > STALE_THRESHOLD_HOURS) {
      console.log(`  ${source}: ${ageHours.toFixed(1)}h stale — needs recovery`)
      stale.push({ source, script, age: ageHours })
    } else {
      console.log(`  ${source}: ${ageHours.toFixed(1)}h — OK`)
    }
  }
  
  return stale
}

async function recover(stale) {
  if (!stale.length) {
    console.log('\n✅ All platforms fresh, no recovery needed')
    return
  }
  
  console.log(`\n🔄 Recovering ${stale.length} stale platforms...`)
  
  for (const { source, script } of stale) {
    const scriptPath = `/opt/ranking-arena/scripts/import/${script}`
    console.log(`  Running ${script}...`)
    try {
      execSync(`timeout 600 node ${scriptPath} ALL`, {
        cwd: '/opt/ranking-arena',
        stdio: 'pipe',
        timeout: 620000,
      })
      console.log(`  ✅ ${source} recovered`)
    } catch (e) {
      console.log(`  ❌ ${source} recovery failed: ${e.message?.slice(0, 100)}`)
    }
  }
  
  // Also recompute leaderboard after recovery
  console.log('\n  Recomputing leaderboard...')
  try {
    execSync('timeout 300 node /opt/ranking-arena/scripts/compute-leaderboard-local.mjs', {
      cwd: '/opt/ranking-arena',
      stdio: 'pipe',
      timeout: 310000,
    })
    console.log('  ✅ Leaderboard recomputed')
  } catch (e) {
    console.log(`  ❌ Leaderboard recompute failed: ${e.message?.slice(0, 100)}`)
  }
}

async function main() {
  console.log(`=== VPS Health Check at ${new Date().toISOString()} ===\n`)
  const stale = await checkFreshness()
  await recover(stale)
  console.log('\n=== Done ===')
}

main().catch(e => { console.error(e); process.exit(1) })
