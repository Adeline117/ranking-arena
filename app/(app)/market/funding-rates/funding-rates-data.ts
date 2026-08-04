export interface FundingRateRow {
  platform: string
  symbol: string
  funding_rate: number
  funding_time: string
}

const FUNDING_RATE_ROW_KEYS = ['platform', 'symbol', 'funding_rate', 'funding_time'] as const

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && keys.every((key) => expected.includes(key))
}

export function readFundingRateRows(value: unknown): FundingRateRow[] | null {
  if (!Array.isArray(value) || value.length > 5_000) return null

  const rows: FundingRateRow[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
    const row = candidate as Record<string, unknown>
    if (
      !hasExactKeys(row, FUNDING_RATE_ROW_KEYS) ||
      typeof row.platform !== 'string' ||
      row.platform.length === 0 ||
      row.platform !== row.platform.trim() ||
      typeof row.symbol !== 'string' ||
      row.symbol.length === 0 ||
      row.symbol !== row.symbol.trim() ||
      typeof row.funding_rate !== 'number' ||
      !Number.isFinite(row.funding_rate) ||
      typeof row.funding_time !== 'string' ||
      !Number.isFinite(Date.parse(row.funding_time))
    ) {
      return null
    }

    rows.push({
      platform: row.platform,
      symbol: row.symbol,
      funding_rate: row.funding_rate,
      funding_time: row.funding_time,
    })
  }

  return rows
}

export function fundingRateIdentity(row: FundingRateRow): string {
  return `${row.platform}\u0000${row.symbol}`
}

export function hasUniqueFundingRateIdentities(rows: readonly FundingRateRow[]): boolean {
  return new Set(rows.map(fundingRateIdentity)).size === rows.length
}

export function dedupeLatestFundingRates(rows: readonly FundingRateRow[]): FundingRateRow[] {
  const seen = new Set<string>()
  return rows.filter((row) => {
    const identity = fundingRateIdentity(row)
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}
