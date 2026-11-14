/** @jest-environment node */
import type IORedis from 'ioredis'
import { evaluateWorkerHeartbeatTopology } from '@/lib/ingest/worker-heartbeat-topology'
import { evaluateWorkerReleaseReadiness } from '@/lib/ingest/worker-release-readiness'
import { scoringHeartbeatNodeId, startScoringHeartbeat } from '../scoring-heartbeat'
import { startHeartbeat } from '../ingest/heartbeat'

const ORIGINAL_ENV = process.env

afterEach(() => {
  process.env = ORIGINAL_ENV
  jest.restoreAllMocks()
})

describe('scoring heartbeat', () => {
  it('uses a roster field distinct from the ingest worker on the same host', () => {
    process.env = { ...ORIGINAL_ENV, WORKER_NODE_ID: 'mac-mini' }
    delete process.env.SCORING_WORKER_NODE_ID
    expect(scoringHeartbeatNodeId()).toBe('scoring@mac-mini')
  })

  it('writes through the shared heartbeat mechanism with the scoring pseudo-region', async () => {
    process.env = { ...ORIGINAL_ENV, SCORING_WORKER_NODE_ID: 'scoring-test' }
    const start = jest.fn().mockResolvedValue('timer')
    const redis = {} as IORedis
    await startScoringHeartbeat(redis, start as unknown as typeof startHeartbeat)
    expect(start).toHaveBeenCalledWith(
      redis,
      ['scoring'],
      expect.objectContaining({ node: 'scoring-test', attempt_bound_capture: false })
    )
  })

  it('commits a roster entry that the ingest release gates ignore but the topology reports', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {})
    process.env = { ...ORIGINAL_ENV, SCORING_WORKER_NODE_ID: 'scoring-test' }
    const roster: Record<string, string> = {}
    const redis = {
      hset: jest.fn(async (_key: string, field: string, value: string) => {
        roster[field] = value
        return 1
      }),
    } as unknown as IORedis
    const timer = await startScoringHeartbeat(redis)
    clearInterval(timer)

    expect(JSON.parse(roster['scoring-test']).regions).toEqual(['scoring'])
    const now = Date.now()
    expect(evaluateWorkerHeartbeatTopology(roster, now)).toMatchObject({
      scoring_nodes: ['scoring-test'],
      invalid_nodes: [],
      combined_owner_nodes: [],
    })
    const readiness = evaluateWorkerReleaseReadiness(roster, 'a'.repeat(40), 'b'.repeat(64), now)
    expect(readiness.invalid_nodes).toEqual([])
    expect(readiness.healthy_workers).toEqual([])
  })
})
