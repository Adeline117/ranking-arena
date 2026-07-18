import type { Job } from 'bullmq'
import { tierCJobId } from '@/lib/ingest/core/tier-c-keys'
import type { TierCJobData } from '../queues'
import { routeTierCJobRegion, type TierCRegionRouterDeps } from '../tier-c-region-router'

jest.mock('../queues', () => ({
  INGEST_JOB: { TIER_C: 'tierc:profile' },
  getTierCQueue: jest.fn(),
  tierCJobId: (value: {
    sourceSlug: string
    exchangeTraderId: string
    timeframe: number
    surface: string
  }) =>
    ['tierc', value.sourceSlug, value.exchangeTraderId, value.timeframe, value.surface].join('--'),
}))

jest.mock('@/lib/ingest/sources', () => ({
  getSourceBySlug: jest.fn(),
}))

const data: TierCJobData = {
  sourceSlug: 'binance_futures',
  exchangeTraderId: 'trader-42',
  timeframe: 30,
  surface: 'profile',
}

function job(jobData: TierCJobData = data): Job<TierCJobData> {
  return {
    id: tierCJobId(jobData),
    name: 'tierc:profile',
    data: jobData,
  } as Job<TierCJobData>
}

function deps(
  region: unknown,
  enqueue: TierCRegionRouterDeps['enqueue'] = jest.fn(async () => undefined)
): TierCRegionRouterDeps {
  return {
    sourceRegion: jest.fn(async () => region),
    enqueue,
  }
}

describe('routeTierCJobRegion', () => {
  it('runs only when the consumed queue matches the authoritative source region', async () => {
    const routing = deps('vps_sg')

    await expect(routeTierCJobRegion(job(), 'vps_sg', routing)).resolves.toEqual({
      action: 'run',
      region: 'vps_sg',
    })
    expect(routing.sourceRegion).toHaveBeenCalledWith('binance_futures')
    expect(routing.enqueue).not.toHaveBeenCalled()
  })

  it('moves a legacy global-queue job before acknowledging it', async () => {
    const enqueue = jest.fn(async () => undefined)

    await expect(routeTierCJobRegion(job(), 'local', deps('vps_sg', enqueue))).resolves.toEqual({
      action: 'rerouted',
      from: 'local',
      to: 'vps_sg',
      jobId: tierCJobId(data),
    })
    expect(enqueue).toHaveBeenCalledWith(
      'vps_sg',
      { ...data, fetchRegion: 'vps_sg' },
      tierCJobId(data)
    )
  })

  it('uses the database region instead of trusting a stale producer hint', async () => {
    const enqueue = jest.fn(async () => undefined)
    const staleHint = { ...data, fetchRegion: 'local' as const }

    await routeTierCJobRegion(job(staleHint), 'local', deps('vps_sg', enqueue))

    expect(enqueue).toHaveBeenCalledWith(
      'vps_sg',
      { ...data, fetchRegion: 'vps_sg' },
      tierCJobId(data)
    )
  })

  it('leaves the original job failed/retryable when target enqueue fails', async () => {
    const enqueue = jest.fn(async () => {
      throw new Error('redis unavailable')
    })

    await expect(routeTierCJobRegion(job(), 'local', deps('vps_sg', enqueue))).rejects.toThrow(
      'redis unavailable'
    )
  })

  it('fails closed for unknown source regions and malformed jobs', async () => {
    const unknown = deps('moon')
    await expect(routeTierCJobRegion(job(), 'local', unknown)).rejects.toThrow(
      'unsupported fetch region'
    )
    expect(unknown.enqueue).not.toHaveBeenCalled()

    const missingSource = job({ ...data, sourceSlug: '' })
    const routing = deps('local')
    await expect(routeTierCJobRegion(missingSource, 'local', routing)).rejects.toThrow(
      'missing sourceSlug'
    )
    expect(routing.sourceRegion).not.toHaveBeenCalled()
  })
})
