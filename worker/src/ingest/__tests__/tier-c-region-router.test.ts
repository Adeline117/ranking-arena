import type { Job } from 'bullmq'
import { tierCJobId, tierCResultKey } from '@/lib/ingest/core/tier-c-keys'
import { tierCQueueName } from '@/lib/ingest/core/tier-c-routing'
import { getSourceBySlug } from '@/lib/ingest/sources'
import { getTierCQueue } from '../queues'
import type { TierCJobData } from '../queues'
import {
  MAX_TIER_C_REROUTE_HOPS,
  ensureTierCRerouteTarget,
  routeTierCJobRegion,
  tierCRerouteJobId,
  type TierCRegionRouterDeps,
} from '../tier-c-region-router'

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

const mockGetSourceBySlug = getSourceBySlug as jest.MockedFunction<typeof getSourceBySlug>
const mockGetTierCQueue = getTierCQueue as jest.MockedFunction<typeof getTierCQueue>

const data: TierCJobData = {
  sourceSlug: 'binance_futures',
  exchangeTraderId: 'trader-42',
  timeframe: 30,
  surface: 'profile',
}

interface JobOverrides {
  id?: string
  timestamp?: number
  queueName?: string
}

function job(jobData: TierCJobData = data, overrides: JobOverrides = {}): Job<TierCJobData> {
  return {
    id: overrides.id ?? tierCJobId(jobData),
    name: 'tierc:profile',
    data: jobData,
    timestamp: overrides.timestamp ?? 1_000,
    queueName: overrides.queueName ?? tierCQueueName('local'),
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
  beforeEach(() => {
    jest.clearAllMocks()
  })

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
    const sourceJob = job()
    const rerouteId = tierCRerouteJobId(sourceJob, 'local', 'vps_sg')

    await expect(routeTierCJobRegion(sourceJob, 'local', deps('vps_sg', enqueue))).resolves.toEqual(
      {
        action: 'rerouted',
        from: 'local',
        to: 'vps_sg',
        jobId: rerouteId,
      }
    )
    expect(enqueue).toHaveBeenCalledWith(
      'vps_sg',
      {
        ...data,
        fetchRegion: 'vps_sg',
        tierCRouteToken: rerouteId,
        tierCRouteHop: 1,
      },
      rerouteId
    )
    expect(rerouteId).not.toBe(tierCJobId(data))
    expect(rerouteId).not.toContain(':')
    expect(
      JSON.parse(
        Buffer.from(rerouteId.replace('tierc-reroute-v1--', ''), 'base64url').toString('utf8')
      )
    ).toEqual([tierCQueueName('local'), tierCJobId(data), sourceJob.timestamp, 'local', 'vps_sg'])
    expect(
      tierCResultKey({
        ...data,
        fetchRegion: 'vps_sg',
        tierCRouteToken: rerouteId,
        tierCRouteHop: 1,
      })
    ).toBe(tierCResultKey(data))
  })

  it('fails closed instead of bouncing a stale producer-directed job', async () => {
    const enqueue = jest.fn(async () => undefined)
    const staleHint = { ...data, fetchRegion: 'local' as const }
    const sourceJob = job(staleHint)

    await expect(routeTierCJobRegion(sourceJob, 'local', deps('vps_sg', enqueue))).rejects.toThrow(
      'no longer matches source region vps_sg'
    )

    expect(enqueue).not.toHaveBeenCalled()
  })

  it('keeps one source-flight ID stable across retries but separates later flights', () => {
    const first = job(data, { timestamp: 10_000 })
    const sameRetry = job(data, { timestamp: 10_000 })
    const laterFlight = job(data, { timestamp: 10_001 })

    expect(tierCRerouteJobId(first, 'local', 'vps_sg')).toBe(
      tierCRerouteJobId(sameRetry, 'local', 'vps_sg')
    )
    expect(tierCRerouteJobId(laterFlight, 'local', 'vps_sg')).not.toBe(
      tierCRerouteJobId(first, 'local', 'vps_sg')
    )
  })

  it('refuses a reverse move instead of hitting the still-active source flight', async () => {
    const enqueue = jest.fn(async () => undefined)
    const baseJob = job(data, { timestamp: 20_000 })
    const outboundId = tierCRerouteJobId(baseJob, 'local', 'vps_sg')
    const activeOutbound = job(
      {
        ...data,
        fetchRegion: 'vps_sg',
        tierCRouteToken: outboundId,
        tierCRouteHop: 1,
      },
      {
        id: outboundId,
        timestamp: 20_100,
        queueName: tierCQueueName('vps_sg'),
      }
    )

    await expect(
      routeTierCJobRegion(activeOutbound, 'vps_sg', deps('local', enqueue))
    ).rejects.toThrow('no longer matches source region local')
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('runs a one-hop target only when its token, hop, queue, and DB region agree', async () => {
    const baseJob = job(data, { timestamp: 30_000 })
    const rerouteId = tierCRerouteJobId(baseJob, 'local', 'vps_sg')
    const target = job(
      {
        ...data,
        fetchRegion: 'vps_sg',
        tierCRouteToken: rerouteId,
        tierCRouteHop: MAX_TIER_C_REROUTE_HOPS,
      },
      {
        id: rerouteId,
        timestamp: 30_100,
        queueName: tierCQueueName('vps_sg'),
      }
    )

    await expect(routeTierCJobRegion(target, 'vps_sg', deps('vps_sg'))).resolves.toEqual({
      action: 'run',
      region: 'vps_sg',
    })
  })

  it('rejects a second handoff hop before enqueueing', async () => {
    const enqueue = jest.fn(async () => undefined)
    const forgedId = 'tierc-reroute-v1--forged'
    const overLimit = job(
      {
        ...data,
        fetchRegion: 'vps_sg',
        tierCRouteToken: forgedId,
        tierCRouteHop: MAX_TIER_C_REROUTE_HOPS + 1,
      },
      {
        id: forgedId,
        queueName: tierCQueueName('vps_sg'),
      }
    )

    await expect(routeTierCJobRegion(overLimit, 'vps_sg', deps('vps_sg', enqueue))).rejects.toThrow(
      `exceeds hop limit ${MAX_TIER_C_REROUTE_HOPS}`
    )
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('rejects a routing token that is not the target job identity', async () => {
    const enqueue = jest.fn(async () => undefined)
    const target = job(
      {
        ...data,
        fetchRegion: 'vps_sg',
        tierCRouteToken: 'tierc-reroute-v1--other-flight',
        tierCRouteHop: 1,
      },
      {
        id: 'tierc-reroute-v1--this-flight',
        queueName: tierCQueueName('vps_sg'),
      }
    )

    await expect(routeTierCJobRegion(target, 'vps_sg', deps('vps_sg', enqueue))).rejects.toThrow(
      'invalid routing token'
    )
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('revives a failed existing target before acknowledging the source flight', async () => {
    mockGetSourceBySlug.mockResolvedValue({
      fetch_region: 'vps_sg',
    } as Awaited<ReturnType<typeof getSourceBySlug>>)
    const getState = jest
      .fn<Promise<string>, []>()
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('waiting')
    const retry = jest.fn(async () => undefined)
    const target = { getState, retry }
    const add = jest.fn(async () => target)
    mockGetTierCQueue.mockReturnValue({ add } as unknown as ReturnType<typeof getTierCQueue>)

    await expect(routeTierCJobRegion(job(), 'local')).resolves.toMatchObject({
      action: 'rerouted',
      from: 'local',
      to: 'vps_sg',
    })

    expect(retry).toHaveBeenCalledWith('failed')
    expect(getState).toHaveBeenCalledTimes(2)
  })

  it('rejects Queue.add success when the returned target is not runnable', async () => {
    const target = {
      getState: jest.fn(async () => 'unknown'),
      retry: jest.fn(async () => undefined),
    }

    await expect(
      ensureTierCRerouteTarget(
        target as unknown as Parameters<typeof ensureTierCRerouteTarget>[0],
        'tierc-reroute-v1--missing'
      )
    ).rejects.toThrow('is not runnable (unknown)')
    expect(target.retry).not.toHaveBeenCalled()
  })

  it('keeps the source flight retryable when a failed target cannot be revived', async () => {
    const target = {
      getState: jest
        .fn<Promise<string>, []>()
        .mockResolvedValueOnce('failed')
        .mockResolvedValueOnce('failed'),
      retry: jest.fn(async () => {
        throw new Error('retry rejected')
      }),
    }

    await expect(
      ensureTierCRerouteTarget(
        target as unknown as Parameters<typeof ensureTierCRerouteTarget>[0],
        'tierc-reroute-v1--failed'
      )
    ).rejects.toThrow('could not leave failed state (failed)')
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
