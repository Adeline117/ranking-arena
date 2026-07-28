import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  assertSourceJobMatchesConsumedRegion,
  bindAuthorizedConsumedRegion,
  bindConsumedRegion,
  createConsumedRegionAdmission,
  createConsumedRegionContext,
  requireWorkerExecutionRegion,
} from '../consumed-region-context'
import type { WorkerDbFence, WorkerDbFenceProof } from '../worker-db-fence'
import {
  acquireRegionAuthorityLifecycle,
  type RegionAuthorityLifecycle,
} from '../region-authority-lifecycle'

function authorityHarness(region: 'local' | 'vps_sg' = 'local') {
  const controller = new AbortController()
  const proof: WorkerDbFenceProof = {
    authorityScope: `region:${region}`,
    controlEpoch: 1,
    controlServerTimeMs: 1_000,
    databaseEpoch: 1,
    databaseLeaseExpiresAt: '2026-07-28T20:03:00.000Z',
    databaseServerTime: '2026-07-28T20:00:00.000Z',
    initialControlServerTimeMs: 1_000,
    instanceId: '00000000-0000-4000-8000-000000000001',
    nodeId: 'consumed-region-test',
    region,
  }
  const fence: WorkerDbFence = Object.freeze({
    proof,
    signal: controller.signal,
    state: 'active',
    isActive: () => !controller.signal.aborted,
    release: jest.fn(async () => {
      controller.abort(new Error('released'))
    }),
    renewAndPublish: jest.fn(async () => undefined),
    withFencedWrite: jest.fn(),
  })
  return { controller, fence }
}

async function lifecycleHarness(region: 'local' | 'vps_sg' = 'local') {
  const authority = authorityHarness(region)
  const acquired = await acquireRegionAuthorityLifecycle({
    acquireAuthority: async () => ({ fence: authority.fence, status: 'active' }),
    heartbeat: () => ({
      attempt_bound_capture: true,
      node: 'consumed-region-test',
      pid: 42,
      regions: [region],
      release_id: 'a'.repeat(64),
      sha: 'b'.repeat(40),
    }),
    onLost: jest.fn(),
    redis: { eval: jest.fn() },
    region,
    scheduleRenewal: () => ({ cancel: jest.fn(), unref: jest.fn() }),
  })
  if (acquired.status !== 'active') throw new Error('expected active lifecycle')
  return { authority, lifecycle: acquired.lifecycle }
}

describe('consumed queue region context', () => {
  it('binds the exact immutable context into a concurrent-safe route closure', async () => {
    const local = createConsumedRegionContext('local', 'local')
    const sg = createConsumedRegionContext('vps_sg', 'vps_sg')
    const route = jest.fn(async (job: string, context: typeof local) => ({
      executionRegion: context.executionRegion,
      job,
      region: context.consumedRegion,
    }))

    await expect(
      Promise.all([
        bindConsumedRegion(local, route)('local-job'),
        bindConsumedRegion(sg, route)('sg-job'),
      ])
    ).resolves.toEqual([
      { executionRegion: 'local', job: 'local-job', region: 'local' },
      { executionRegion: 'vps_sg', job: 'sg-job', region: 'vps_sg' },
    ])
    expect(Object.isFrozen(local)).toBe(true)
    expect(Object.isFrozen(sg)).toBe(true)
  })

  it('rejects a stale source job before its route can run', async () => {
    const run = jest.fn()
    const resolveSourceRegion = jest.fn(async () => 'vps_sg' as const)
    const job = {
      name: 'tiera:leaderboard',
      data: { sourceSlug: 'binance_futures', fetchRegion: 'local' },
    }

    await expect(
      assertSourceJobMatchesConsumedRegion(
        job as never,
        createConsumedRegionContext('local', 'local'),
        resolveSourceRegion
      ).then(run)
    ).rejects.toThrow('belongs to vps_sg, not consumed queue region local')
    expect(resolveSourceRegion).toHaveBeenCalledWith('binance_futures')
    expect(run).not.toHaveBeenCalled()
  })

  it('does not derive authority from job data or INGEST_LOCAL_REGION', async () => {
    const previous = process.env.INGEST_LOCAL_REGION
    process.env.INGEST_LOCAL_REGION = 'vps_sg'
    try {
      const resolveSourceRegion = jest.fn(async () => 'local' as const)
      await expect(
        assertSourceJobMatchesConsumedRegion(
          {
            name: 'tierd:positions',
            data: { sourceSlug: 'okx_futures', fetchRegion: 'vps_sg' },
          } as never,
          createConsumedRegionContext('local', 'vps_sg'),
          resolveSourceRegion
        )
      ).resolves.toBeUndefined()
      expect(resolveSourceRegion).toHaveBeenCalledWith('okx_futures')
    } finally {
      if (previous === undefined) delete process.env.INGEST_LOCAL_REGION
      else process.env.INGEST_LOCAL_REGION = previous
    }
  })

  it('fails closed when a source-wide job has no source identity', async () => {
    const resolveSourceRegion = jest.fn()
    await expect(
      assertSourceJobMatchesConsumedRegion(
        { name: 'tierb:profiles', data: {} } as never,
        createConsumedRegionContext('local', 'local'),
        resolveSourceRegion
      )
    ).rejects.toThrow('tierb:profiles job is missing sourceSlug')
    expect(resolveSourceRegion).not.toHaveBeenCalled()
  })

  it('leaves non-source maintenance jobs outside source-region lookup', async () => {
    const resolveSourceRegion = jest.fn()
    await expect(
      assertSourceJobMatchesConsumedRegion(
        { name: 'maint:freshness', data: {} } as never,
        createConsumedRegionContext('local', 'local'),
        resolveSourceRegion
      )
    ).resolves.toBeUndefined()
    expect(resolveSourceRegion).not.toHaveBeenCalled()
  })

  it('keeps failover authority and execution provenance distinct', () => {
    expect(createConsumedRegionContext('local', 'vps_sg')).toEqual({
      consumedRegion: 'local',
      executionRegion: 'vps_sg',
    })
    expect(() => createConsumedRegionContext('vps_jp', 'vps_jp')).toThrow(
      'unsupported consumed queue region'
    )
    expect(() => requireWorkerExecutionRegion(undefined)).toThrow(
      'INGEST_LOCAL_REGION must name the execution region'
    )
  })

  it('keeps authorized consumer admission closed until explicitly opened', async () => {
    const { lifecycle } = await lifecycleHarness()
    const admission = createConsumedRegionAdmission(lifecycle, 'vps_sg')
    const route = jest.fn(
      async (_job: string, context: typeof admission.context) =>
        `${context.consumedRegion}/${context.executionRegion}`
    )
    const consume = bindAuthorizedConsumedRegion(admission.context, route)

    await expect(consume('before-open')).rejects.toThrow('consumer admission is closed')
    expect(route).not.toHaveBeenCalled()
    admission.open()
    await expect(consume('after-open')).resolves.toBe('local/vps_sg')
    expect(admission.isOpen()).toBe(true)

    admission.close()
    await expect(consume('after-close')).rejects.toThrow('consumer admission is closed')
    expect(() => admission.open()).toThrow('consumer admission cannot reopen')
    await lifecycle.stopAfterDrain(async () => undefined)
  })

  it('closes admission synchronously when the authority fence aborts', async () => {
    const { authority, lifecycle } = await lifecycleHarness()
    const admission = createConsumedRegionAdmission(lifecycle, 'local')
    admission.open()

    authority.controller.abort(new Error('authority lost'))

    expect(admission.isOpen()).toBe(false)
    expect(() => admission.context.assertCanConsume()).toThrow('consumer admission is closed')
  })

  it('rejects a structurally forged lifecycle capability', () => {
    const authority = authorityHarness()
    const forged: RegionAuthorityLifecycle = {
      failure: undefined,
      fence: authority.fence,
      region: 'local',
      state: 'active',
      stopAfterDrain: jest.fn(),
    }

    expect(() => createConsumedRegionAdmission(forged, 'local')).toThrow(
      'consumer admission requires a managed authority lifecycle'
    )
  })

  it('fails closed from lifecycle stopping even while its fence keeps renewing', async () => {
    const { lifecycle } = await lifecycleHarness()
    const admission = createConsumedRegionAdmission(lifecycle, 'local')
    const route = jest.fn(async () => 'ran')
    const consume = bindAuthorizedConsumedRegion(admission.context, route)
    let finishDrain!: () => void
    const draining = new Promise<void>((resolve) => {
      finishDrain = resolve
    })
    admission.open()

    const stop = lifecycle.stopAfterDrain(() => draining)
    await Promise.resolve()

    expect(lifecycle.state).toBe('stopping')
    expect(admission.isOpen()).toBe(false)
    await expect(consume('during-drain')).rejects.toThrow('consumer admission is closed')
    expect(route).not.toHaveBeenCalled()
    expect(() => admission.open()).toThrow('authority is not active for consumer admission')

    finishDrain()
    await stop
  })

  it('keeps every queue consumer bound to its closure context', () => {
    const entrypoint = readFileSync(join(process.cwd(), 'worker/src/ingest-worker.ts'), 'utf8')
    const failover = readFileSync(join(process.cwd(), 'worker/src/ingest/failover.ts'), 'utf8')
    const tierA = readFileSync(
      join(process.cwd(), 'worker/src/ingest/processors/tier-a-leaderboard.ts'),
      'utf8'
    )

    expect(entrypoint.match(/bindConsumedRegion\(contextFor\(region\), route\)/g)).toHaveLength(2)
    expect(entrypoint).toContain('bindConsumedRegion(contextFor(region), routeTierC)')
    expect(entrypoint).not.toMatch(/region(?:Fast)?QueueName\(region\),\s*route\s*,/)
    expect(failover).toContain(
      'new Worker(regionQueueName(region), bindConsumedRegion(context, route)'
    )
    expect(tierA).not.toContain('INGEST_LOCAL_REGION')
    expect(tierA).toContain('const workerRegion = context.executionRegion')
  })
})
