import type { Job } from 'bullmq'
import { tierCJobId } from '@/lib/ingest/core/tier-c-keys'
import { tierCQueueName } from '@/lib/ingest/core/tier-c-routing'
import { getSourceBySlug } from '@/lib/ingest/sources'
import { getTierCQueue } from '../queues'
import type { TierCJobData } from '../queues'
import {
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
    expect(enqueue).toHaveBeenCalledWith('vps_sg', { ...data, fetchRegion: 'vps_sg' }, rerouteId)
    expect(rerouteId).not.toBe(tierCJobId(data))
    expect(rerouteId).not.toContain(':')
    expect(
      JSON.parse(
        Buffer.from(rerouteId.replace('tierc-reroute-v1--', ''), 'base64url').toString('utf8')
      )
    ).toEqual([tierCQueueName('local'), tierCJobId(data), sourceJob.timestamp, 'local', 'vps_sg'])
  })

  it('uses the database region instead of trusting a stale producer hint', async () => {
    const enqueue = jest.fn(async () => undefined)
    const staleHint = { ...data, fetchRegion: 'local' as const }
    const sourceJob = job(staleHint)
    const rerouteId = tierCRerouteJobId(sourceJob, 'local', 'vps_sg')

    await routeTierCJobRegion(sourceJob, 'local', deps('vps_sg', enqueue))

    expect(enqueue).toHaveBeenCalledWith('vps_sg', { ...data, fetchRegion: 'vps_sg' }, rerouteId)
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

  it('gives a reverse move a new ID instead of hitting the active source flight', () => {
    const baseJob = job(data, { timestamp: 20_000 })
    const outboundId = tierCRerouteJobId(baseJob, 'local', 'vps_sg')
    const activeOutbound = job(
      { ...data, fetchRegion: 'vps_sg' },
      {
        id: outboundId,
        timestamp: 20_100,
        queueName: tierCQueueName('vps_sg'),
      }
    )
    const reverseId = tierCRerouteJobId(activeOutbound, 'vps_sg', 'local')

    expect(reverseId).not.toBe(outboundId)
    expect(reverseId).not.toBe(tierCJobId(data))
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
