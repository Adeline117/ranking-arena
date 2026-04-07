import { getSupabaseAdmin } from '@/lib/api'
import { SOURCE_TYPE_MAP } from '@/lib/constants/exchanges'
import { createLogger } from '@/lib/utils/logger'

const _logger = createLogger('compute-leaderboard')

// DEX sources where 0x addresses may be bots
const DEX_SOURCES = new Set(['hyperliquid', 'gmx', 'dydx', 'drift', 'aevo', 'gains', 'jupiter_perps'])

/** Per-platform freshness thresholds: CEX=48h, DEX=72h
 *  Tightened from 168h (7d) now that all fetcher groups run every 3-6h.
 *  If a platform's data is >2-3 days old, it's genuinely stale. */
const DATA_FRESHNESS_HOURS_CEX = 48
const DATA_FRESHNESS_HOURS_DEX = 72

// Heuristic bot detection for DEX traders
// Enhanced bot detection (freqtrade 47.8K★ trading frequency patterns)
export function detectTraderType(
  source: string,
  sourceId: string,
  tradesCount: number | null,
  existingType: string | null,
  avgHoldingHours?: number | null,
  winRate?: number | null,
): 'human' | 'bot' | null {
  // Explicit type always wins
  if (existingType === 'human' || existingType === 'bot') return existingType
  // web3_bot source is always bot
  if (source === 'web3_bot') return 'bot'

  if (DEX_SOURCES.has(source) && sourceId.startsWith('0x')) {
    // High trade count → likely bot
    if (tradesCount != null && tradesCount > 500) return 'bot'
    // Extremely short hold times + high trade count → algorithmic trading
    if (avgHoldingHours != null && avgHoldingHours < 0.5 && tradesCount != null && tradesCount > 100) return 'bot'
    // Suspiciously perfect win rate with many trades → likely bot
    if (winRate != null && winRate >= 95 && tradesCount != null && tradesCount > 50) return 'bot'
  }

  return null
}

export function getFreshnessHours(source: string): number {
  const sourceType = SOURCE_TYPE_MAP[source]
  return sourceType === 'web3' ? DATA_FRESHNESS_HOURS_DEX : DATA_FRESHNESS_HOURS_CEX
}

/**
 * Derive WR and MDD from historical ROI snapshots for traders missing these metrics.
 * Runs after leaderboard computation to fill gaps in platforms that don't provide WR/MDD natively.
 * WR = percentage of days where ROI increased (from v2 snapshots)
 * MDD = maximum peak-to-trough decline in equity curve
 */
export async function deriveWinRateMDD(supabase: ReturnType<typeof getSupabaseAdmin>): Promise<number> {
  const { data: missing } = await supabase.from('leaderboard_ranks')
    .select('source, source_trader_id, win_rate, max_drawdown, season_id')
    .or('win_rate.is.null,max_drawdown.is.null')
    .limit(2000) // Process up to 2000 per run to stay within timeout

  if (!missing?.length) return 0

  // Group by trader (source + source_trader_id)
  const traderMap = new Map<string, typeof missing>()
  for (const row of missing) {
    const key = `${row.source}:${row.source_trader_id}`
    if (!traderMap.has(key)) traderMap.set(key, [])
    traderMap.get(key)!.push(row)
  }

  // Batch fetch ALL needed trader_snapshots_v2 rows in one query
  const allTraderKeys = [...traderMap.keys()].map(k => {
    const [platform, ...parts] = k.split(':')
    return { platform, trader_key: parts.join(':') }
  })

  // Fetch snapshots for all traders at once, grouped by platform
  const platformGroups = new Map<string, string[]>()
  for (const t of allTraderKeys) {
    if (!platformGroups.has(t.platform)) platformGroups.set(t.platform, [])
    platformGroups.get(t.platform)!.push(t.trader_key)
  }

  // Single batch fetch per platform (much fewer queries than per-trader)
  const allSnapshots: Array<{ platform: string; trader_key: string; roi_pct: number; created_at: string }> = []
  await Promise.all(
    Array.from(platformGroups.entries()).map(async ([platform, traderKeys]) => {
      for (let i = 0; i < traderKeys.length; i += 500) {
        const chunk = traderKeys.slice(i, i + 500)
        const { data: snaps } = await supabase.from('trader_snapshots_v2')
          .select('platform, trader_key, roi_pct, created_at')
          .eq('platform', platform)
          .in('trader_key', chunk)
          .not('roi_pct', 'is', null)
          .order('created_at', { ascending: true })
          .limit(50000)

        if (snaps) allSnapshots.push(...(snaps as typeof allSnapshots))
      }
    })
  )

  // Group snapshots by trader key
  const snapshotsByTrader = new Map<string, Array<{ roi_pct: number; created_at: string }>>()
  for (const snap of allSnapshots) {
    const key = `${snap.platform}:${snap.trader_key}`
    if (!snapshotsByTrader.has(key)) snapshotsByTrader.set(key, [])
    snapshotsByTrader.get(key)!.push(snap)
  }

  // Compute WR/MDD in memory and collect all updates
  const leaderboardUpdates: Array<{
    source: string; source_trader_id: string; season_id: string;
    win_rate?: number; max_drawdown?: number;
  }> = []

  for (const [compositeKey, rows] of traderMap) {
    const snapshots = snapshotsByTrader.get(compositeKey) || []
    if (snapshots.length < 2) continue

    // Deduplicate by day, keep latest per day
    const daily = new Map<string, number>()
    for (const snap of snapshots) {
      const day = snap.created_at?.slice(0, 10)
      if (day) daily.set(day, snap.roi_pct)
    }
    const rois = [...daily.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(e => e[1])
    if (rois.length < 2) continue

    // Win Rate: days where ROI increased
    let wins = 0, days = 0
    for (let j = 1; j < rois.length; j++) { if (rois[j] > rois[j - 1]) wins++; days++ }
    const wr = days > 0 ? parseFloat(((wins / days) * 100).toFixed(2)) : null

    // MDD from equity curve
    const eq = rois.map(r => 1 + r / 100)
    let peak = eq[0], maxDD = 0
    for (const e of eq) { if (e > peak) peak = e; const dd = peak > 0 ? (peak - e) / peak : 0; if (dd > maxDD) maxDD = dd }
    const mdd = parseFloat((maxDD * 100).toFixed(2))

    for (const row of rows) {
      const upd: Record<string, number> = {}
      if (row.win_rate == null && wr != null) upd.win_rate = wr
      if (row.max_drawdown == null && mdd > 0) upd.max_drawdown = Math.min(mdd, 100)
      if (Object.keys(upd).length > 0) {
        leaderboardUpdates.push({
          source: rows[0].source,
          source_trader_id: rows[0].source_trader_id,
          season_id: row.season_id,
          ...upd,
        })
      }
    }
  }

  // Batch upsert all leaderboard_ranks updates (single query per batch of 500)
  let derived = 0
  const UPSERT_BATCH = 500
  for (let i = 0; i < leaderboardUpdates.length; i += UPSERT_BATCH) {
    const batch = leaderboardUpdates.slice(i, i + UPSERT_BATCH)
    // Use individual updates grouped in Promise.all with larger batches
    // (leaderboard_ranks has composite PK so we need per-row updates, but we batch them)
    const results = await Promise.all(
      batch.map(upd => {
        const updateFields: Record<string, number> = {}
        // Validate against VALIDATION_BOUNDS before write
        if (upd.win_rate != null && upd.win_rate >= 0 && upd.win_rate <= 100) updateFields.win_rate = upd.win_rate
        if (upd.max_drawdown != null && upd.max_drawdown >= 0 && upd.max_drawdown <= 100) updateFields.max_drawdown = upd.max_drawdown
        if (Object.keys(updateFields).length === 0) return Promise.resolve({ error: null })
        return supabase.from('leaderboard_ranks').update(updateFields)
          .eq('source', upd.source).eq('source_trader_id', upd.source_trader_id).eq('season_id', upd.season_id)
      })
    )
    derived += results.filter(r => !r.error).length
  }

  return derived
}
