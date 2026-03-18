#!/usr/bin/env npx tsx
/**
 * Generate AI bios for all traders missing bios in trader_profiles_v2.
 *
 * Uses metrics from trader_snapshots_v2 (falling back to v1) to produce
 * factual, 1-2 sentence bios describing the trader's style and performance.
 *
 * Usage:
 *   npx tsx scripts/generate-trader-bios.ts              # process all
 *   npx tsx scripts/generate-trader-bios.ts --limit 100  # first 100
 *   npx tsx scripts/generate-trader-bios.ts --dry-run    # preview only
 *   npx tsx scripts/generate-trader-bios.ts --dry-run --limit 10
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ─── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const limitIdx = args.indexOf('--limit')
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 0 // 0 = all
const BATCH_SIZE = 200

// ─── Exchange config (inlined to avoid @/ imports) ───────────────────────────

const EXCHANGE_NAMES: Record<string, string> = {
  binance_futures: 'Binance', bybit: 'Bybit', bitget_futures: 'Bitget',
  okx_futures: 'OKX', mexc: 'MEXC', kucoin: 'KuCoin', coinex: 'CoinEx',
  htx_futures: 'HTX', weex: 'WEEX', phemex: 'Phemex', bingx: 'BingX',
  gateio: 'Gate.io', xt: 'XT.COM', lbank: 'LBank', blofin: 'BloFin',
  bitmart: 'BitMart', binance_spot: 'Binance Spot', bitget_spot: 'Bitget Spot',
  bybit_spot: 'Bybit Spot', okx_spot: 'OKX Spot',
  binance_web3: 'Binance Web3', okx_web3: 'OKX Web3', okx_wallet: 'OKX Wallet',
  gmx: 'GMX', dydx: 'dYdX', hyperliquid: 'Hyperliquid', drift: 'Drift',
  paradex: 'Paradex', gains: 'Gains Network', jupiter_perps: 'Jupiter Perps',
  aevo: 'Aevo', perpetual_protocol: 'Perpetual Protocol',
  dune_gmx: 'GMX (Dune)', dune_hyperliquid: 'Hyperliquid (Dune)',
  dune_uniswap: 'Uniswap (Dune)', dune_defi: 'DeFi (Dune)',
  bitunix: 'Bitunix', btcc: 'BTCC', bitfinex: 'Bitfinex', toobit: 'Toobit',
  crypto_com: 'Crypto.com', etoro: 'eToro', web3_bot: 'Web3 Bot',
  kwenta: 'Kwenta', synthetix: 'Synthetix', mux: 'MUX Protocol',
}

const WEB3_PLATFORMS = new Set([
  'gmx', 'dydx', 'hyperliquid', 'drift', 'paradex', 'gains', 'jupiter_perps',
  'aevo', 'perpetual_protocol', 'dune_gmx', 'dune_hyperliquid', 'dune_uniswap',
  'dune_defi', 'binance_web3', 'okx_web3', 'okx_wallet', 'web3_bot', 'kwenta',
])

const SPOT_PLATFORMS = new Set([
  'binance_spot', 'bitget_spot', 'bybit_spot', 'okx_spot', 'dune_uniswap', 'etoro',
])

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getPlatName(platform: string): string {
  return EXCHANGE_NAMES[platform] ?? platform.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function getMarketLabel(platform: string): string {
  if (SPOT_PLATFORMS.has(platform)) return 'spot'
  if (WEB3_PLATFORMS.has(platform)) return 'perpetual'
  return 'futures'
}

function fmtRoi(roi: number): string {
  const sign = roi >= 0 ? '+' : ''
  if (Math.abs(roi) >= 1000) return `${sign}${(roi / 1000).toFixed(1)}K%`
  return `${sign}${roi.toFixed(Math.abs(roi) >= 100 ? 0 : 1)}%`
}

function fmtPnl(pnl: number): string {
  const abs = Math.abs(pnl)
  const sign = pnl >= 0 ? '+' : '-'
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`
  return `${sign}$${abs.toFixed(0)}`
}

// ─── Snapshot type ───────────────────────────────────────────────────────────

interface Metrics {
  roi: number | null
  pnl: number | null
  win_rate: number | null
  max_drawdown: number | null
  trades_count: number | null
  arena_score: number | null
  followers: number | null
  copiers: number | null
  avg_holding_hours?: number | null
  trading_style?: string | null
  rank: number | null
}

// ─── Bio generation ──────────────────────────────────────────────────────────

const STYLE_LABELS: Record<string, string> = {
  scalper: 'scalping', hft: 'scalping', scalping: 'scalping',
  swing: 'swing trading', day_trader: 'day trading',
  trend: 'trend following', position: 'position trading',
}

function inferStyleFromHours(hours: number | null | undefined): string | null {
  if (hours == null) return null
  if (hours < 4) return 'scalper'
  if (hours < 48) return 'swing'
  if (hours < 336) return 'trend'
  return 'position'
}

function generateBio(
  platform: string,
  metrics: Metrics | null,
  window: string | null,
  totalOnPlatform: number | null,
  isBot: boolean,
): string {
  const platName = getPlatName(platform)
  const market = getMarketLabel(platform)

  if (!metrics || !window) {
    if (isBot) return `Automated trading bot on ${platName}.`
    return `${platName} ${market} trader.`
  }

  const parts: string[] = []

  // Part 1: Intro with optional percentile
  const pct = (metrics.rank != null && totalOnPlatform && totalOnPlatform > 0)
    ? (metrics.rank / totalOnPlatform) * 100
    : null

  if (pct != null && pct <= 25) {
    const pctLabel = pct <= 1 ? '1' : pct <= 5 ? '5' : pct <= 10 ? '10' : '25'
    if (isBot) {
      parts.push(`Top ${pctLabel}% automated bot on ${platName}.`)
    } else {
      parts.push(`Top ${pctLabel}% ${platName} ${market} trader.`)
    }
  } else {
    if (isBot) {
      parts.push(`Automated trading bot on ${platName}.`)
    } else {
      parts.push(`${platName} ${market} trader.`)
    }
  }

  // Part 2: Performance metrics
  const perfParts: string[] = []

  perfParts.push(`${window} ROI ${fmtRoi(metrics.roi ?? 0)}`)

  if (metrics.pnl != null && Math.abs(metrics.pnl) >= 10) {
    perfParts.push(`${fmtPnl(metrics.pnl)} PnL`)
  }

  if (metrics.win_rate != null) {
    perfParts.push(`${metrics.win_rate.toFixed(0)}% win rate`)
  }

  if (metrics.max_drawdown != null && Math.abs(metrics.max_drawdown) > 0) {
    perfParts.push(`${Math.abs(metrics.max_drawdown).toFixed(0)}% max drawdown`)
  }

  if (perfParts.length > 0) {
    parts.push(perfParts.join(', ') + '.')
  }

  // Part 3: Trading style
  const style = metrics.trading_style || inferStyleFromHours(metrics.avg_holding_hours)
  if (style && STYLE_LABELS[style]) {
    parts.push(`Specializes in ${STYLE_LABELS[style]}.`)
  }

  // Part 4: Social proof (followers/copiers)
  if (metrics.copiers != null && metrics.copiers >= 50) {
    parts.push(`${metrics.copiers.toLocaleString()} active copiers.`)
  } else if (metrics.followers != null && metrics.followers >= 100) {
    parts.push(`${metrics.followers.toLocaleString()} followers.`)
  }

  return parts.join(' ')
}

// ─── Tags generation ─────────────────────────────────────────────────────────

function generateTags(
  platform: string,
  metrics: Metrics | null,
  totalOnPlatform: number | null,
  isBot: boolean,
): string[] {
  const tags: string[] = []

  if (WEB3_PLATFORMS.has(platform)) tags.push('defi')
  if (isBot) tags.push('bot')
  if (!metrics) return tags

  // Percentile
  const pct = (metrics.rank != null && totalOnPlatform && totalOnPlatform > 0)
    ? (metrics.rank / totalOnPlatform) * 100
    : null
  if (pct != null) {
    if (pct <= 1) tags.push('top-1%')
    else if (pct <= 5) tags.push('top-5%')
    else if (pct <= 10) tags.push('top-10%')
    else if (pct <= 25) tags.push('top-25%')
  }

  // Style
  const style = metrics.trading_style || inferStyleFromHours(metrics.avg_holding_hours)
  if (style) {
    const canonMap: Record<string, string> = {
      scalper: 'scalper', hft: 'scalper', scalping: 'scalper',
      day_trader: 'swing', swing: 'swing', trend: 'trend', position: 'position',
    }
    const c = canonMap[style] || style
    if (c !== 'unknown') tags.push(c)
  }

  // Risk
  if (metrics.max_drawdown != null) {
    const mdd = Math.abs(metrics.max_drawdown)
    if (mdd <= 10) tags.push('low-risk')
    else if (mdd <= 30) tags.push('moderate-risk')
    else tags.push('high-risk')
  }

  // Performance
  if (metrics.pnl != null && Math.abs(metrics.pnl) >= 100_000) tags.push('whale')
  if (metrics.trades_count != null && metrics.trades_count >= 1000) tags.push('active')
  if (metrics.win_rate != null && metrics.win_rate >= 70) tags.push('high-winrate')
  if ((metrics.roi ?? 0) > 100) tags.push('high-roi')
  if (metrics.arena_score != null && metrics.arena_score >= 80) tags.push('elite')

  return [...new Set(tags)]
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Generate Trader Bios ===`)
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`)
  console.log(`Limit: ${LIMIT || 'all'}`)
  console.log(`Batch size: ${BATCH_SIZE}\n`)

  // Step 1: Count profiles needing bios
  const { count: totalNull } = await supabase
    .from('trader_profiles_v2')
    .select('*', { count: 'exact', head: true })
    .is('bio', null)

  console.log(`Profiles with NULL bio: ${totalNull}`)

  const maxToProcess = LIMIT > 0 ? Math.min(LIMIT, totalNull ?? 0) : (totalNull ?? 0)
  console.log(`Will process: ${maxToProcess}\n`)

  if (maxToProcess === 0) {
    console.log('Nothing to do.')
    return
  }

  // Step 2: Get platform trader counts for percentile calculation
  const platformCounts: Record<string, number> = {}
  const { data: platformCountRows } = await supabase
    .rpc('get_platform_counts_v2')
    .select('*')
    .throwOnError()
    .then(() => ({ data: null as unknown }))
    .catch(() => ({ data: null }))

  // Fallback: count per platform manually if RPC doesn't exist
  if (!platformCountRows) {
    const { data: platforms } = await supabase
      .from('trader_profiles_v2')
      .select('platform')

    if (platforms) {
      for (const p of platforms) {
        platformCounts[p.platform] = (platformCounts[p.platform] || 0) + 1
      }
    }
    console.log(`Loaded trader counts for ${Object.keys(platformCounts).length} platforms`)
  }

  // Step 3: Process in batches
  let processed = 0
  let updated = 0
  let noMetrics = 0
  let errors = 0
  let offset = 0

  while (processed < maxToProcess) {
    const batchLimit = Math.min(BATCH_SIZE, maxToProcess - processed)

    // Fetch profiles without bios
    const { data: profiles, error: fetchErr } = await supabase
      .from('trader_profiles_v2')
      .select('platform, market_type, trader_key, display_name, is_bot')
      .is('bio', null)
      .order('platform', { ascending: true })
      .order('trader_key', { ascending: true })
      .range(offset, offset + batchLimit - 1)

    if (fetchErr) {
      console.error(`Fetch error at offset ${offset}: ${fetchErr.message}`)
      errors++
      break
    }

    if (!profiles || profiles.length === 0) {
      console.log('No more profiles to process.')
      break
    }

    // Fetch best snapshot for each trader (90D > 30D > 7D)
    const updates: Array<{
      platform: string
      market_type: string
      trader_key: string
      bio: string
      bio_source: string
      tags: string[]
      updated_at: string
    }> = []

    for (const profile of profiles) {
      let metrics: Metrics | null = null
      let bestWindow: string | null = null

      // Try v2 snapshots first
      for (const w of ['90D', '30D', '7D']) {
        const { data: snap } = await supabase
          .from('trader_snapshots_v2')
          .select('window, metrics')
          .eq('platform', profile.platform)
          .eq('trader_key', profile.trader_key)
          .eq('window', w)
          .order('as_of_ts', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (snap?.metrics) {
          const m = snap.metrics as Record<string, unknown>
          metrics = {
            roi: (m.roi as number) ?? null,
            pnl: (m.pnl as number) ?? null,
            win_rate: (m.win_rate as number) ?? null,
            max_drawdown: (m.max_drawdown as number) ?? null,
            trades_count: (m.trades_count as number) ?? null,
            arena_score: (m.arena_score as number) ?? null,
            followers: (m.followers as number) ?? null,
            copiers: (m.copiers as number) ?? null,
            avg_holding_hours: (m.avg_holding_hours as number) ?? null,
            trading_style: (m.trading_style as string) ?? null,
            rank: (m.rank as number) ?? null,
          }
          bestWindow = w
          break
        }
      }

      // Fallback to v1
      if (!metrics) {
        for (const seasonId of ['90D', '30D', '7D']) {
          const { data: snap } = await supabase
            .from('trader_snapshots')
            .select('roi, pnl, win_rate, max_drawdown, trades_count, arena_score, followers')
            .eq('source', profile.platform)
            .eq('source_trader_id', profile.trader_key)
            .eq('season_id', seasonId)
            .order('captured_at', { ascending: false })
            .limit(1)
            .maybeSingle()

          if (snap) {
            metrics = {
              roi: snap.roi ?? null,
              pnl: snap.pnl ?? null,
              win_rate: snap.win_rate ?? null,
              max_drawdown: snap.max_drawdown ?? null,
              trades_count: snap.trades_count ?? null,
              arena_score: snap.arena_score ?? null,
              followers: snap.followers ?? null,
              copiers: null,
              avg_holding_hours: null,
              trading_style: null,
              rank: null,
            }
            bestWindow = seasonId
            break
          }
        }
      }

      if (!metrics) {
        noMetrics++
      }

      const isBot = profile.is_bot === true || profile.platform === 'web3_bot'
      const totalOnPlatform = platformCounts[profile.platform] || null

      const bio = generateBio(profile.platform, metrics, bestWindow, totalOnPlatform, isBot)
      const tags = generateTags(profile.platform, metrics, totalOnPlatform, isBot)

      updates.push({
        platform: profile.platform,
        market_type: profile.market_type,
        trader_key: profile.trader_key,
        bio,
        bio_source: 'auto',
        tags,
        updated_at: new Date().toISOString(),
      })
    }

    // Write batch
    if (!DRY_RUN && updates.length > 0) {
      const { error: upsertErr } = await supabase
        .from('trader_profiles_v2')
        .upsert(updates, { onConflict: 'platform,market_type,trader_key' })

      if (upsertErr) {
        console.error(`Upsert error: ${upsertErr.message}`)
        errors++
      } else {
        updated += updates.length
      }
    }

    processed += profiles.length

    // Preview samples
    if (DRY_RUN && updates.length > 0) {
      const samples = updates.slice(0, 3)
      for (const s of samples) {
        console.log(`  [${s.platform}] ${s.trader_key.slice(0, 20)}...`)
        console.log(`    Bio: ${s.bio}`)
        console.log(`    Tags: [${s.tags.join(', ')}]`)
      }
      if (updates.length > 3) {
        console.log(`    ... and ${updates.length - 3} more in this batch`)
      }
    }

    console.log(`Batch done: ${processed}/${maxToProcess} processed` +
      (DRY_RUN ? ' (dry run)' : `, ${updated} updated`) +
      `, ${noMetrics} without metrics, ${errors} errors`)

    // Don't increment offset for live mode — processed rows no longer have NULL bio
    // For dry-run we need to paginate since rows are unchanged
    if (DRY_RUN) {
      offset += batchLimit
    }
  }

  console.log(`\n=== Summary ===`)
  console.log(`Processed: ${processed}`)
  console.log(`Updated: ${DRY_RUN ? '0 (dry run)' : updated}`)
  console.log(`No metrics (minimal bio): ${noMetrics}`)
  console.log(`Errors: ${errors}`)
  console.log(`Done.\n`)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
