/**
 * @jest-environment node
 */
/**
 * reconcileSchedulers against real BullMQ on a disposable Redis (2026-11
 * audit TEST-5). scheduler.test.ts mocks the queue, so it cannot show how the
 * orphan dedupe and the revive pass treat real scheduler iteration jobs.
 *
 * Runs in CI (unit-tests job, its own Redis service: the worker-ownership test
 * requires an empty server, so the two cannot share one under parallel jest
 * workers). Skipped when INGEST_SCHEDULER_REDIS_TEST_URL is absent.
 */
import IORedis from 'ioredis'
import type { Job, Queue } from 'bullmq'

function disposableRedisUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('INGEST_SCHEDULER_REDIS_TEST_URL must be a disposable loopback Redis URL')
  }
  const port = Number(parsed.port)
  if (
    parsed.protocol !== 'redis:' ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/15' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error(
      'INGEST_SCHEDULER_REDIS_TEST_URL must be redis://127.0.0.1:<port>/15 without credentials'
    )
  }
  return parsed.toString()
}

const REDIS_URL = disposableRedisUrl(process.env.INGEST_SCHEDULER_REDIS_TEST_URL)
const describeRedis = REDIS_URL ? describe : describe.skip

let mockRedis: IORedis | undefined
jest.mock('../../connection', () => ({
  getConnection: () => {
    if (!mockRedis) throw new Error('test Redis not connected')
    return mockRedis
  },
}))
jest.mock('@/lib/ingest/v1-execution-publication', () => ({
  isV1IngestExecutionPublished: () => true,
}))
jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
}))
jest.mock('@/lib/ingest/alerting', () => ({ alert: async () => undefined }))
jest.mock('@/lib/ingest/sources', () => ({
  getActiveSources: async () => [
    {
      slug: 'srcx',
      adapter_slug: 'srcx',
      phase: 1,
      fetch_region: 'local',
      expected_count: null,
      cadence_tier_a_seconds: 3600,
      cadence_tier_b_seconds: 86_400,
      cadence_tier_d_seconds: 1800,
      deep_profile_topn: 100,
      timeframes_derived: [],
      meta: {},
    },
  ],
  getServingSourceNames: async () => [],
}))

import { reconcileSchedulers } from '../scheduler'
import { getFastQueue, getIngestQueue, getRegionQueue, INGEST_JOB, INGEST_REGIONS } from '../queues'

const HOUR = 3600_000
const PENDING = ['prioritized', 'waiting', 'delayed'] as const

async function schedulerOf(q: Queue, key: string) {
  const schedulers = await q.getJobSchedulers()
  const found = schedulers.find((s) => s.key === key)
  if (!found?.next) throw new Error(`scheduler ${key} missing`)
  return found
}

async function pendingIds(q: Queue, prefix: string): Promise<string[]> {
  const jobs = await q.getJobs([...PENDING], 0, 1000)
  return jobs
    .map((j: Job) => j.id ?? '')
    .filter((id) => id.startsWith(prefix))
    .sort()
}

describeRedis('reconcileSchedulers against real BullMQ', () => {
  jest.setTimeout(30_000)
  let nowSpy: jest.SpyInstance<number, []> | undefined

  beforeAll(async () => {
    mockRedis = new IORedis(REDIS_URL!, {
      connectionName: 'ingest-scheduler-test',
      maxRetriesPerRequest: null,
    })
    await expect(mockRedis.ping()).resolves.toBe('PONG')
    if ((await mockRedis.dbsize()) !== 0) {
      throw new Error('scheduler integration tests require an empty disposable Redis database')
    }
    jest.spyOn(console, 'log').mockImplementation(() => {})
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(async () => {
    nowSpy?.mockRestore()
    nowSpy = undefined
    await mockRedis!.flushdb()
  })

  afterAll(async () => {
    const queues = [
      getIngestQueue(),
      ...INGEST_REGIONS.flatMap((r) => [getRegionQueue(r), getFastQueue(r)]),
    ]
    await Promise.all(queues.map((q) => q.close()))
    await mockRedis?.quit()
    jest.restoreAllMocks()
  })

  it('dedupes orphan copies but keeps every scheduler iteration', async () => {
    const q = getRegionQueue('local')
    await reconcileSchedulers()
    const tierB = await schedulerOf(q, 'tierb:srcx')
    const iterationsBefore = await pendingIds(q, 'repeat:')
    expect(iterationsBefore).toContain(`repeat:tierb:srcx:${tierB.next}`)

    const data = { sourceSlug: 'srcx' }
    const old = Date.now() - HOUR
    await q.add(INGEST_JOB.TIER_B, data, { jobId: 'orphan-old', priority: 6, timestamp: old })
    await q.add(INGEST_JOB.TIER_B, data, { jobId: 'orphan-new', priority: 6 })

    await reconcileSchedulers()

    expect(await q.getJob('orphan-old')).toBeUndefined()
    expect(await q.getJob('orphan-new')).toBeDefined()
    // The newer orphan is not allowed to displace the scheduler's own iteration.
    expect(await pendingIds(q, 'repeat:')).toEqual(iterationsBefore)
  })

  it('revives a broken chain and replaces a stuck iteration without leaving the old one', async () => {
    const q = getRegionQueue('local')
    await reconcileSchedulers()
    const tierA = await schedulerOf(q, 'tiera:srcx')
    const tierD = await schedulerOf(q, 'tierd:srcx')
    const stuckTierD = `repeat:tierd:srcx:${tierD.next}`
    expect(await pendingIds(q, 'repeat:tierd:srcx:')).toEqual([stuckTierD])

    // Broken chain: the Tier-A iteration is gone.
    await (await q.getJob(`repeat:tiera:srcx:${tierA.next}`))!.remove()

    // Two hours later: Tier-A (1h) has no iteration, Tier-D (30min) has sat
    // queued for more than twice its cadence.
    const later = Date.now() + 2 * HOUR
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(later)
    await reconcileSchedulers()

    const revivedA = await schedulerOf(q, 'tiera:srcx')
    expect(await pendingIds(q, 'repeat:tiera:srcx:')).toEqual([
      `repeat:tiera:srcx:${revivedA.next}`,
    ])
    const kickA = await q.getJob('revive-kick-tiera-srcx')
    expect(kickA?.opts.priority).toBe(1)

    const revivedD = await schedulerOf(q, 'tierd:srcx')
    const tierDIterations = await pendingIds(q, 'repeat:tierd:srcx:')
    expect(tierDIterations).toEqual([`repeat:tierd:srcx:${revivedD.next}`])
    expect(tierDIterations).not.toContain(stuckTierD)
    expect(await q.getJob('revive-kick-tierd-srcx')).toBeDefined()
  })
})
