export interface OpenInterestRow {
  platform: string
  symbol: string
  open_interest_usd: number
  open_interest_contracts: number | null
  timestamp: string
}

const OPEN_INTEREST_ROW_KEYS = [
  'platform',
  'symbol',
  'open_interest_usd',
  'open_interest_contracts',
  'timestamp',
] as const

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && keys.every((key) => expected.includes(key))
}

function isNonnegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function readOpenInterestRows(value: unknown): OpenInterestRow[] | null {
  if (!Array.isArray(value) || value.length > 5_000) return null

  const rows: OpenInterestRow[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
    const row = candidate as Record<string, unknown>
    if (
      !hasExactKeys(row, OPEN_INTEREST_ROW_KEYS) ||
      typeof row.platform !== 'string' ||
      row.platform.length === 0 ||
      row.platform !== row.platform.trim() ||
      typeof row.symbol !== 'string' ||
      row.symbol.length === 0 ||
      row.symbol !== row.symbol.trim() ||
      !isNonnegativeFiniteNumber(row.open_interest_usd) ||
      (row.open_interest_contracts !== null &&
        !isNonnegativeFiniteNumber(row.open_interest_contracts)) ||
      typeof row.timestamp !== 'string' ||
      !Number.isFinite(Date.parse(row.timestamp))
    ) {
      return null
    }

    rows.push({
      platform: row.platform,
      symbol: row.symbol,
      open_interest_usd: row.open_interest_usd,
      open_interest_contracts: row.open_interest_contracts,
      timestamp: row.timestamp,
    })
  }
  return rows
}

export function openInterestIdentity(row: OpenInterestRow): string {
  return `${row.platform}\u0000${row.symbol}`
}

export function hasUniqueOpenInterestIdentities(rows: readonly OpenInterestRow[]): boolean {
  return new Set(rows.map(openInterestIdentity)).size === rows.length
}

export function dedupeLatestOpenInterest(rows: readonly OpenInterestRow[]): OpenInterestRow[] {
  const seen = new Set<string>()
  return rows.filter((row) => {
    const identity = openInterestIdentity(row)
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}
