import { INGEST_REGIONS, isIngestRegion } from '../regions'
import { LEGACY_TIER_C_QUEUE_NAME, assertIngestRegion, tierCQueueName } from '../tier-c-routing'

describe('Tier-C regional queue contract', () => {
  it('keeps the historical queue as local and isolates every remote region', () => {
    expect(tierCQueueName('local')).toBe(LEGACY_TIER_C_QUEUE_NAME)
    expect(tierCQueueName('vps_sg')).toBe('arena-ingest-tierc-vps_sg')
    expect(tierCQueueName('vps_jp')).toBe('arena-ingest-tierc-vps_jp')
    expect(new Set(INGEST_REGIONS.map(tierCQueueName)).size).toBe(INGEST_REGIONS.length)
  })

  it('fails closed instead of inventing an unconsumed queue', () => {
    expect(isIngestRegion('unknown')).toBe(false)
    expect(() => assertIngestRegion('unknown')).toThrow('unsupported fetch region')
    expect(() => tierCQueueName(undefined)).toThrow('unsupported fetch region')
  })
})
