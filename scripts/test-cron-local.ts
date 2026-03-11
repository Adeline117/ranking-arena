/**
 * Local test: run a batch-fetch-traders group inline
 * Usage: npx tsx scripts/test-cron-local.ts [group]
 * Example: npx tsx scripts/test-cron-local.ts h
 */

import { getInlineFetcher } from '../lib/cron/fetchers'
import { createClient } from '@supabase/supabase-js'

const GROUPS: Record<string, string[]> = {
  a: ['binance_futures', 'binance_spot'],
  a2: ['bybit', 'bitget_futures', 'okx_futures'],
  b: ['hyperliquid', 'gmx', 'jupiter_perps'],
  c: ['okx_web3', 'aevo', 'xt'],
  d1: ['gains', 'htx_futures'],
  d2: ['dydx', 'bybit_spot'],
  e: ['coinex', 'binance_web3', 'bitfinex'],
  f: ['mexc', 'bingx'],
  h: ['gateio', 'btcc'],
  g1: ['drift', 'bitunix'],
  g2: ['web3_bot', 'kwenta', 'toobit', 'blofin'],
  i: ['etoro'],
}

async function main() {
  const group = process.argv[2] || 'h'
  const platforms = GROUPS[group]
  if (!platforms) {
    console.error(`Unknown group: ${group}. Available: ${Object.keys(GROUPS).join(', ')}`)
    process.exit(1)
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  console.log(`\n=== Testing group ${group}: ${platforms.join(', ')} ===\n`)

  for (const platform of platforms) {
    const fetcher = getInlineFetcher(platform)
    if (!fetcher) {
      console.log(`❌ ${platform}: No fetcher found`)
      continue
    }

    const start = Date.now()
    try {
      console.log(`⏳ ${platform}: fetching...`)
      const result = await Promise.race([
        fetcher(supabase, ['7D', '30D', '90D']),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Timeout 180s')), 180_000)
        ),
      ])

      const totalSaved = Object.values(result.periods).reduce((sum, p) => sum + (p.saved || 0), 0)
      const hasErrors = Object.values(result.periods).some(p => p.error)
      const elapsed = Math.round((Date.now() - start) / 1000)

      console.log(`${hasErrors ? '⚠️' : '✅'} ${platform}: saved=${totalSaved} duration=${elapsed}s`)
      for (const [period, p] of Object.entries(result.periods)) {
        console.log(`   ${period}: total=${p.total} saved=${p.saved}${p.error ? ` error=${p.error}` : ''}`)
      }
    } catch (err) {
      const elapsed = Math.round((Date.now() - start) / 1000)
      console.log(`❌ ${platform}: ${err instanceof Error ? err.message : String(err)} (${elapsed}s)`)
    }
    console.log()
  }

  // Verify snapshots_v2 was updated
  console.log('=== Verifying snapshots_v2 freshness ===')
  for (const platform of platforms) {
    const { data } = await supabase
      .from('trader_snapshots_v2')
      .select('updated_at')
      .eq('platform', platform)
      .order('updated_at', { ascending: false })
      .limit(1)

    if (data && data.length > 0) {
      const age = Math.round((Date.now() - new Date(data[0].updated_at).getTime()) / (1000 * 60))
      console.log(`${age <= 5 ? '✅' : '🟡'} ${platform}: ${age}min ago`)
    } else {
      console.log(`⚫ ${platform}: no snapshots`)
    }
  }
}

main().catch(console.error)
