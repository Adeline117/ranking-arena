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
