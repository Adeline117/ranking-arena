export function watchedRankingChangeLink(traderId: string, source: string): string {
  return `/trader/${encodeURIComponent(traderId)}?platform=${encodeURIComponent(source)}`
}

export function watchedRankingChangeReference(
  traderId: string,
  source: string,
  snapshotDate: string,
  oldRank: number,
  newRank: number
): string {
  return [
    'watched_rank_change',
    encodeURIComponent(source),
    encodeURIComponent(traderId),
    snapshotDate,
    oldRank,
    newRank,
  ].join(':')
}
