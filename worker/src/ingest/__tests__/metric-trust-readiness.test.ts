import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  METRIC_TRUST_RELEASE_MIGRATION_PATH,
  METRIC_TRUST_RELEASE_MIGRATION_SHA256,
  METRIC_TRUST_WORKER_READINESS_CONTRACT,
  assertArenaProductionDatabaseUrl,
  assertMetricTrustWorkerReadiness,
  loadMetricTrustWorkerReadiness,
  validateMetricTrustWorkerReadiness,
  type MetricTrustReadinessClient,
} from '../metric-trust-readiness'

const readyPayload = (overrides: Record<string, unknown> = {}) => ({
  contract: METRIC_TRUST_WORKER_READINESS_CONTRACT,
  ready: true,
  missing: [],
  legacy_complete_verified_count: 0,
  release_migration_sha256: METRIC_TRUST_RELEASE_MIGRATION_SHA256,
  source_page_lineage_column: true,
  ...overrides,
})
const DATABASE_URL =
  'postgresql://postgres.iknktzifjdyujdccyhsv:secret@aws-0-us-west-2.pooler.supabase.com:5432/postgres'

describe('ingest worker metric-trust startup gate', () => {
  it('binds direct and session-pooler URLs to the Arena production project', () => {
    for (const url of [
      'postgresql://postgres:secret@db.iknktzifjdyujdccyhsv.supabase.co:5432/postgres',
      'postgresql://postgres.iknktzifjdyujdccyhsv:secret@aws-0-us-west-2.pooler.supabase.com:5432/postgres',
      'postgresql://postgres.iknktzifjdyujdccyhsv:secret@aws-0-us-west-2.pooler.supabase.com:5432/postgres?sslmode=require',
    ]) {
      expect(() => assertArenaProductionDatabaseUrl(url)).not.toThrow()
    }

    for (const url of [
      undefined,
      'not-a-url',
      'https://db.iknktzifjdyujdccyhsv.supabase.co:5432/postgres',
      'postgresql://postgres:secret@db.otherproject.supabase.co:5432/postgres',
      'postgresql://postgres.otherproject:secret@aws-0-us-west-2.pooler.supabase.com:5432/postgres',
      'postgresql://postgres.iknktzifjdyujdccyhsv:secret@aws-0-us-west-2.pooler.supabase.com:6543/postgres',
      'postgresql://postgres.iknktzifjdyujdccyhsv@aws-0-us-west-2.pooler.supabase.com:5432/postgres',
      'postgresql://postgres.iknktzifjdyujdccyhsv:secret@aws-0-us-west-2.pooler.supabase.com:5432/postgres?host=evil.example',
      'postgresql://postgres.iknktzifjdyujdccyhsv:secret@aws-0-us-west-2.pooler.supabase.com:5432/postgres?user=postgres.other',
      'postgresql://postgres.iknktzifjdyujdccyhsv:secret@aws-0-us-west-2.pooler.supabase.com:5432/postgres?sslmode=require&sslmode=no-verify',
    ]) {
      expect(() => assertArenaProductionDatabaseUrl(url)).toThrow(
        'metric-trust startup gate failed closed'
      )
    }
  })

  it('accepts only the exact complete release contract', () => {
    expect(() => validateMetricTrustWorkerReadiness(readyPayload())).not.toThrow()

    for (const payload of [
      null,
      readyPayload({ contract: 'wrong' }),
      readyPayload({ ready: false }),
      readyPayload({ missing: ['arena.metric_trust_observations'] }),
      readyPayload({ missing: 'none' }),
      readyPayload({ missing: [''] }),
      readyPayload({ missing: [' '] }),
      readyPayload({ missing: [' ledger:20260722055000'] }),
      readyPayload({ missing: ['ledger:20260722055000', 'ledger:20260722055000'] }),
      readyPayload({ legacy_complete_verified_count: 1 }),
      readyPayload({ legacy_complete_verified_count: -1 }),
      readyPayload({ legacy_complete_verified_count: Number.MAX_SAFE_INTEGER + 1 }),
      readyPayload({ release_migration_sha256: '0'.repeat(64) }),
      readyPayload({ source_page_lineage_column: false }),
      readyPayload({ extra: true }),
    ]) {
      expect(() => validateMetricTrustWorkerReadiness(payload)).toThrow(
        'metric-trust startup gate failed closed'
      )
    }
  })

  it('explicitly rejects either quarantined @1 or the exact 054 digest', () => {
    for (const payload of [
      readyPayload({ contract: 'arena.metric-trust-release-readiness@1' }),
      readyPayload({
        release_migration_sha256:
          '93c512791e8bb7beb00742c7b65c6d79ecdf79ea49e26a3d67c3b3c438ae42cf',
      }),
    ]) {
      expect(() => validateMetricTrustWorkerReadiness(payload)).toThrow(
        'quarantined 054 readiness proof is unsupported'
      )
    }
  })

  it('rejects a non-production database before opening a connection', async () => {
    const connect = jest.fn(async () => {
      throw new Error('must not connect')
    })
    await expect(
      loadMetricTrustWorkerReadiness({
        connect,
        databaseUrl:
          'postgresql://postgres.other:secret@aws-0-us-west-2.pooler.supabase.com:5432/postgres',
      })
    ).rejects.toThrow('not the Arena production session pooler')
    expect(connect).not.toHaveBeenCalled()
  })

  it('sanitizes a missing RPC or database failure', async () => {
    let error: Error | undefined
    try {
      await assertMetricTrustWorkerReadiness({
        load: async () => {
          throw new Error('postgres://user:secret@example.invalid')
        },
      })
    } catch (caught) {
      error = caught as Error
    }

    expect(error?.message).toContain('readiness RPC is unavailable')
    expect(error?.message).not.toContain('secret')
    expect(error?.message).not.toContain('example.invalid')
  })

  it('bounds a hung readiness call before any worker can start', async () => {
    await expect(
      assertMetricTrustWorkerReadiness({
        load: () => new Promise<never>(() => undefined),
        timeoutMs: 5,
      })
    ).rejects.toThrow('readiness RPC is unavailable')
  })

  it('reads the RPC in one bounded read-only transaction and releases the client', async () => {
    const queries: string[] = []
    let releases = 0
    const client: MetricTrustReadinessClient = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql)
        if (sql.startsWith('SELECT public.arena_metric_trust_release_readiness')) {
          return { rowCount: 1, rows: [{ readiness: readyPayload() }] }
        }
        return { rowCount: null, rows: [] }
      }),
      release: () => {
        releases += 1
      },
    }

    await expect(
      loadMetricTrustWorkerReadiness({
        connect: async () => client,
        databaseUrl: DATABASE_URL,
      })
    ).resolves.toEqual(readyPayload())
    expect(queries).toEqual([
      'BEGIN TRANSACTION READ ONLY',
      "SET LOCAL statement_timeout = '25s'",
      'SELECT public.arena_metric_trust_release_readiness() AS readiness',
      'COMMIT',
    ])
    expect(releases).toBe(1)
  })

  it('rolls back and releases before surfacing an RPC failure', async () => {
    const queries: string[] = []
    let releases = 0
    const client: MetricTrustReadinessClient = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql)
        if (sql.startsWith('SELECT public.arena_metric_trust_release_readiness')) {
          throw new Error('missing function')
        }
        return { rowCount: null, rows: [] }
      }),
      release: () => {
        releases += 1
      },
    }

    await expect(
      assertMetricTrustWorkerReadiness({
        load: () =>
          loadMetricTrustWorkerReadiness({
            connect: async () => client,
            databaseUrl: DATABASE_URL,
          }),
      })
    ).rejects.toThrow('readiness RPC is unavailable')
    expect(queries.at(-1)).toBe('ROLLBACK')
    expect(releases).toBe(1)
  })

  it('pins the worker constant to the committed 055 bytes', () => {
    const migration = readFileSync(join(process.cwd(), METRIC_TRUST_RELEASE_MIGRATION_PATH))
    expect(createHash('sha256').update(migration).digest('hex')).toBe(
      METRIC_TRUST_RELEASE_MIGRATION_SHA256
    )
  })

  it('loads deferred runtime behind the entry gate, then installs handlers before native setup', () => {
    const source = readFileSync(join(process.cwd(), 'worker/src/ingest-worker.ts'), 'utf8')
    const main = source.slice(source.indexOf('async function main(): Promise<void>'))
    const runtimeLoad = main.indexOf('await initializeRuntime()')
    const handlers = main.indexOf('installProcessHandlers()')
    const firstAwaitLine = /^\s*await\b/m.exec(main)
    const firstAwait =
      firstAwaitLine === null ? -1 : firstAwaitLine.index + firstAwaitLine[0].indexOf('await')
    const metricGate = main.indexOf('await assertMetricTrustWorkerReadiness()')

    expect(runtimeLoad).toBe(firstAwait)
    expect(handlers).toBeGreaterThan(runtimeLoad)
    expect(metricGate).toBeGreaterThan(handlers)

    // This is the source-level construction boundary. startup-gate.test.ts
    // executes the callbacks and proves their heartbeat/reconcile/start/ready order.
    for (const laterPhase of [
      "await import('@/lib/ingest/adapters/register')",
      'resolveNativeRegionConfig(regions, executionRegion)',
      'await acquireRegionAuthorityLifecycleWithRetry({',
      'await prepareRegionConsumerRuntime({',
      'await startNativeIngestServing({',
      '[ingest-worker] ready (regions=',
    ]) {
      expect(main.indexOf(laterPhase)).toBeGreaterThan(metricGate)
    }
  })

  it('keeps the legacy worker entrypoint behind the same metric-trust gate', () => {
    const source = readFileSync(join(process.cwd(), 'worker/src/index.ts'), 'utf8')
    const main = source.slice(source.indexOf('async function main()'))
    const metricGate = main.indexOf('await assertMetricTrustWorkerReadiness()')

    expect(metricGate).toBeGreaterThan(-1)
    for (const laterAction of ['await registerSchedules()', 'new Worker(', '[worker] Ready']) {
      expect(main.indexOf(laterAction)).toBeGreaterThan(metricGate)
    }
  })

  it('selects one native region and prepares only inert consumers after retrying authority', () => {
    const source = readFileSync(join(process.cwd(), 'worker/src/ingest-worker.ts'), 'utf8')
    const main = source.slice(source.indexOf('async function main(): Promise<void>'))
    const acquisition = main.indexOf('await acquireRegionAuthorityLifecycleWithRetry({')
    const preparation = main.indexOf('const runtime = await prepareRegionConsumerRuntime({')
    const serving = main.indexOf('await startNativeIngestServing({')

    expect(main.match(/\bconsumedRegions\(\)/g)).toHaveLength(1)
    expect(main.match(/\bresolveNativeRegionConfig\(/g)).toHaveLength(1)
    expect(main).toContain('const region = nativeConfig.nativeRegion')
    expect(main).not.toMatch(/for\s*\(\s*const\s+region\s+of\s+regions\s*\)/)
    expect(main).not.toMatch(/\bacquireRegionAuthorityLifecycle\s*\(/)
    expect(acquisition).toBeGreaterThan(-1)
    expect(preparation).toBeGreaterThan(acquisition)
    expect(serving).toBeGreaterThan(preparation)
    expect(main.match(/\bautorun:\s*false\b/g)).toHaveLength(3)
    expect(main).not.toMatch(/\bautorun:\s*true\b/)
  })

  it('binds one identity and every owned resource before emitting ordinary readiness', () => {
    const source = readFileSync(join(process.cwd(), 'worker/src/ingest-worker.ts'), 'utf8')
    const main = source.slice(source.indexOf('async function main(): Promise<void>'))
    const acquisition = main.indexOf('await acquireRegionAuthorityLifecycleWithRetry({')
    const bindLifecycle = main.indexOf('processCoordinator.bindLifecycle(lifecycle)')
    const preparation = main.indexOf('const runtime = await prepareRegionConsumerRuntime({')
    const bindRuntime = main.indexOf('processCoordinator.bindRuntime(runtime)')
    const serving = main.indexOf('await startNativeIngestServing({')
    const authorityReady = main.indexOf('${NATIVE_AUTHORITY_READY_TOKEN}')
    const ordinaryReady = main.indexOf('[ingest-worker] ready (regions=')

    expect(main.match(/\bresolveWorkerRuntimeIdentity\(\)/g)).toHaveLength(1)
    expect(main).toContain('createWorkerOwnershipHeartbeatFactory(runtimeIdentity, region)')
    expect(main).toContain('startHeartbeat(redis, nativeConfig.consumedRegions, runtimeIdentity)')
    expect(main).toContain('signal: processCoordinator.startupSignal')
    expect(main).toContain('startupSignal: processCoordinator.startupSignal')
    expect(bindLifecycle).toBeGreaterThan(acquisition)
    expect(preparation).toBeGreaterThan(bindLifecycle)
    expect(bindRuntime).toBeGreaterThan(preparation)
    expect(serving).toBeGreaterThan(bindRuntime)
    for (const binding of [
      'processCoordinator.bindLifecycle(lifecycle)',
      'processCoordinator.bindRuntime(runtime)',
      'processCoordinator.bindHeartbeatTimer(',
      'processCoordinator.bindReconcileTimer(',
    ]) {
      expect(main.match(new RegExp(binding.replace(/[()]/g, '\\$&'), 'g'))).toHaveLength(1)
    }
    expect(authorityReady).toBeGreaterThan(-1)
    expect(ordinaryReady).toBeGreaterThan(authorityReady)
    expect(main).toContain('console.log(`${NATIVE_AUTHORITY_READY_TOKEN} region=${region}`)')
    expect(main).toContain('return processCoordinator.requestShutdown(')
    expect(source).not.toContain('startFailoverManager')
    expect(source).not.toMatch(/\bprocess\.exit\s*\(/)
    expect(source).toContain('process.exitCode = code')
  })
})
