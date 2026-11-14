/**
 * Map one publication alert onto the shared ingest alert interface
 * (lib/ingest/alerting `alert(redis, …)`), whose page cooldown is keyed by
 * (sourceSlug, tier). Keys are chosen so unrelated problems never suppress
 * each other: every isolated source pages under its own season×source key, a
 * season refusal has its own key, and digest-only notices never take a page
 * cooldown slot.
 */

import type { RankPublicationAlert } from './publish-season'

export interface RoutedIngestAlert {
  sourceSlug: string
  phase: number
  tier: 'A' | 'B'
  message: string
}

export function routeRankPublicationAlert(alert: RankPublicationAlert): RoutedIngestAlert[] {
  const base = `rank-publication:${alert.season}`
  const message = `[${alert.code}] ${alert.message}`
  if (alert.code === 'sources_isolated' && alert.sources && alert.sources.length > 0) {
    return alert.sources.map((source) => ({
      sourceSlug: `${base}:isolated:${source}`,
      phase: 0,
      tier: 'A',
      message: `[${alert.code}] ${source} isolated from ${alert.season}: ${alert.message}`,
    }))
  }
  if (alert.code === 'season_publication_refused') {
    return [{ sourceSlug: `${base}:refused`, phase: 0, tier: 'A', message }]
  }
  // Exclusion warnings and restorations go to the daily digest only.
  return [{ sourceSlug: `${base}:${alert.code}`, phase: 0, tier: 'B', message }]
}
