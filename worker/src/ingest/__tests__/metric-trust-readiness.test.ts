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
      readyPayload({ legacy_complete_verified_count: 1 }),
      readyPayload({ legacy_complete_verified_count: -1 }),
      readyPayload({ release_migration_sha256: '0'.repeat(64) }),
      readyPayload({ source_page_lineage_column: false }),
      readyPayload({ extra: true }),
    ]) {
      expect(() => validateMetricTrustWorkerReadiness(payload)).toThrow(
        'metric-trust startup gate failed closed'
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
      "SET LOCAL statement_timeout = '10s'",
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

  it('pins the worker constant to the committed 054 bytes', () => {
    const migration = readFileSync(join(process.cwd(), METRIC_TRUST_RELEASE_MIGRATION_PATH))
    expect(createHash('sha256').update(migration).digest('hex')).toBe(
      METRIC_TRUST_RELEASE_MIGRATION_SHA256
    )
  })

  it('awaits readiness before every scheduler, consumer, heartbeat, or failover', () => {
    const entrypoints = [
      {
        path: 'worker/src/ingest-worker.ts',
        main: 'async function main(): Promise<void>',
        laterActions: [
          "await import('@/lib/ingest/adapters/register')",
          'new Worker(',
          'await reconcileSchedulers()',
          'startHeartbeat(',
          'startFailoverManager(',
          '[ingest-worker] ready',
        ],
      },
      {
        path: 'worker/src/index.ts',
        main: 'async function main()',
        laterActions: ['await registerSchedules()', 'new Worker(', '[worker] Ready'],
      },
    ]

    for (const entrypoint of entrypoints) {
      const source = readFileSync(join(process.cwd(), entrypoint.path), 'utf8')
      const main = source.slice(source.indexOf(entrypoint.main))
      const gate = main.indexOf('await assertMetricTrustWorkerReadiness()')
      expect(gate).toBeGreaterThan(-1)
      for (const laterAction of entrypoint.laterActions) {
        expect(main.indexOf(laterAction)).toBeGreaterThan(gate)
      }
    }
  })
})
