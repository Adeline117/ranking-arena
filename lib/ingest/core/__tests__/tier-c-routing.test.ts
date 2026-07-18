import { INGEST_REGIONS, isIngestRegion, parseIngestRegionsEnv } from '../regions'
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

describe('INGEST_REGIONS startup contract', () => {
  it('keeps the all-region default only when the variable is truly unset', () => {
    expect(parseIngestRegionsEnv(undefined)).toEqual(INGEST_REGIONS)
  })

  it('accepts an explicit, fully valid region assignment', () => {
    expect(parseIngestRegionsEnv('local,vps_sg')).toEqual(['local', 'vps_sg'])
    expect(parseIngestRegionsEnv(' vps_jp ')).toEqual(['vps_jp'])
  })

  it.each(['', '   ', 'unknown', 'local,unknown', 'local,,vps_sg'])(
    'rejects explicit empty or unknown configuration %p',
    (raw) => {
      expect(() => parseIngestRegionsEnv(raw)).toThrow('INGEST_REGIONS')
    }
  )

  it('rejects duplicate consumers instead of silently normalizing them', () => {
    expect(() => parseIngestRegionsEnv('local,local')).toThrow('duplicates')
  })
})
