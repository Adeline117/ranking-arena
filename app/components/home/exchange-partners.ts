import type { VisibleLeaderboardSource } from '@/lib/data/visible-leaderboard-sources'

export type SourceProductVariant =
  | 'bots-futures'
  | 'bots-spot'
  | 'mt5'
  | 'cfd'
  | 'futures'
  | 'spot'
  | 'onchain'
  | 'other'

export function sourceProductVariant(source: VisibleLeaderboardSource): SourceProductVariant {
  if (source.registrySlug.includes('_bots_futures')) return 'bots-futures'
  if (source.registrySlug.includes('_bots_spot')) return 'bots-spot'
  if (source.registrySlug.endsWith('_mt5')) return 'mt5'
  if (source.productType === 'cfd') return 'cfd'
  if (source.productType === 'futures') return 'futures'
  if (source.productType === 'spot') return 'spot'
  if (source.productType === 'onchain') return 'onchain'
  return 'other'
}

/** Highest-coverage sources first; one clickable item per actual filter source. */
export function orderedVisiblePartners(
  sources: readonly VisibleLeaderboardSource[]
): VisibleLeaderboardSource[] {
  const byFilterSource = new Map<string, VisibleLeaderboardSource>()
  for (const source of sources) {
    if (!source.filterSource || source.traderCount <= 0) continue
    const current = byFilterSource.get(source.filterSource)
    if (!current || source.traderCount > current.traderCount) {
      byFilterSource.set(source.filterSource, source)
    }
  }

  return [...byFilterSource.values()].sort(
    (a, b) =>
      b.traderCount - a.traderCount ||
      a.exchangeName.localeCompare(b.exchangeName) ||
      a.registrySlug.localeCompare(b.registrySlug)
  )
}
