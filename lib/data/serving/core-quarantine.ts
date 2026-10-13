import type { ServingTimeframe, TraderCoreModules } from './types'

/**
 * The legacy core module has raw value trajectories and unsealed performance
 * extras. Until those fields have a public publication chain, every public
 * transport must use this structural empty projection rather than a blacklist.
 */
export function quarantinedPublicCoreModules(timeframe: ServingTimeframe): TraderCoreModules {
  return {
    timeframe,
    stats: {},
    // This is a type-level currency placeholder only: no monetary value is
    // paired with it while the public core projection is quarantined.
    currency: 'USDT',
    series: {},
    extras: {},
    provenance: {
      source: 'historical_core_publication_unavailable',
      asOf: '1970-01-01T00:00:00.000Z',
    },
    cacheState: 'quarantined',
  }
}
