export type LeaderboardTimeRange = '7D' | '30D' | '90D'

export interface VisibleLeaderboardSource {
  registrySlug: string
  filterSource: string
  exchangeSlug: string
  exchangeName: string
  productType: string
  traderCount: number
  cacheUpdatedAt: string
}

function requiredString(row: Record<string, unknown>, key: string, index: number): string {
  const value = row[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`visible leaderboard source row ${index} has invalid ${key}`)
  }
  return value
}

/** Strictly validate the security-definer RPC boundary before serving clients. */
export function parseVisibleLeaderboardSources(data: unknown): VisibleLeaderboardSource[] {
  if (!Array.isArray(data)) throw new Error('visible leaderboard sources RPC returned non-array')

  return data.map((value, index) => {
    if (!value || typeof value !== 'object') {
      throw new Error(`visible leaderboard source row ${index} is not an object`)
    }
    const row = value as Record<string, unknown>
    const traderCount = row.trader_count
    if (typeof traderCount !== 'number' || !Number.isInteger(traderCount) || traderCount <= 0) {
      throw new Error(`visible leaderboard source row ${index} has invalid trader_count`)
    }

    return {
      registrySlug: requiredString(row, 'registry_slug', index),
      filterSource: requiredString(row, 'filter_source', index),
      exchangeSlug: requiredString(row, 'exchange_slug', index),
      exchangeName: requiredString(row, 'exchange_name', index),
      productType: requiredString(row, 'product_type', index),
      traderCount,
      cacheUpdatedAt: requiredString(row, 'cache_updated_at', index),
    }
  })
}
