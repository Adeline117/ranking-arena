import { SOURCE_TYPE_MAP } from '@/lib/constants/exchanges'

// DEX sources where 0x addresses may be bots
const DEX_SOURCES = new Set([
  'hyperliquid',
  'gmx',
  'dydx',
  'drift',
  'aevo',
  'gains',
  'jupiter_perps',
])

// ROOT CAUSE FIX (2026-04-09): Was 48h/72h → queried ALL 55K rows per platform.
// Reduced to 6h/12h — data is fetched every 2-6h, so 6h covers a full cycle.
// This drops query result set from 55K to ~5K per platform → 10x faster.
// The stale check inside computeSeason still uses 48h threshold for correctness.
const DATA_FRESHNESS_HOURS_CEX = 6
const DATA_FRESHNESS_HOURS_DEX = 12

// Bot detection — only 100%-certain sources can label 'bot'.
// Everything else is 'suspected_bot'.
//
// 'bot' sources (100% accurate):
//   - web3_bot platform (hardcoded known bots)
//   - manual/admin override (existingType === 'bot')
//
// 'suspected_bot' sources (high confidence but not 100%):
//   - on-chain contract detection (could be complex smart wallet)
//   - heuristic patterns (could be active human scalper)
export function detectTraderType(
  source: string,
  sourceId: string,
  tradesCount: number | null,
  existingType: string | null,
  avgHoldingHours?: number | null,
  winRate?: number | null,
  isContract?: boolean | null
): 'human' | 'bot' | 'suspected_bot' | null {
  // Explicit type always wins (manual override or claim-verified)
  if (existingType === 'human' || existingType === 'bot') return existingType
  // web3_bot source is always bot (hardcoded known bots — 100% accurate)
  if (source === 'web3_bot') return 'bot'

  // On-chain contract detection → suspected_bot (could be smart wallet)
  if (isContract === true) return 'suspected_bot'

  // Heuristic patterns → suspected_bot (could be active human)
  if (DEX_SOURCES.has(source) && sourceId.startsWith('0x')) {
    if (tradesCount != null && tradesCount > 500) return 'suspected_bot'
    if (
      avgHoldingHours != null &&
      avgHoldingHours < 0.5 &&
      tradesCount != null &&
      tradesCount > 100
    )
      return 'suspected_bot'
    if (winRate != null && winRate >= 95 && tradesCount != null && tradesCount > 50)
      return 'suspected_bot'
  }

  return null
}

export function getFreshnessHours(source: string): number {
  const sourceType = SOURCE_TYPE_MAP[source]
  return sourceType === 'web3' ? DATA_FRESHNESS_HOURS_DEX : DATA_FRESHNESS_HOURS_CEX
}
