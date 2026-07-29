import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  PARTITIONED_V4_ATTEMPT_BINDING_CONTRACT,
  PARTITIONED_V4_CAPTURE_CONTRACT,
  PARTITIONED_V4_FINISH_RPC_SHA256,
  PARTITIONED_V4_START_RPC_SHA256,
  PARTITIONED_V4_WORKER_READINESS_CONTRACT,
  assertPartitionedV4WorkerReadiness,
  loadPartitionedV4WorkerReadiness,
  validatePartitionedV4WorkerReadiness,
  type AttemptBoundCaptureReadinessClient,
} from '../attempt-bound-capture-readiness'
import {
  assertAttemptBoundCaptureEnvironmentFile,
  assertAttemptBoundCaptureRuntimeEnabled,
} from '../attempt-bound-capture-runtime'

function registryRow(product: 'futures' | 'spot'): Record<string, unknown> {
  const futures = product === 'futures'
  return {
    source_slug: futures ? 'bitget_bots_futures' : 'bitget_bots_spot',
    exchange_slug: 'bitget',
    source_adapter_slug: 'bitget_bots',
    product_type: product,
    trader_kind_scope: 'bot',
    status: 'active',
    serving_mode: 'serving',
    currency: 'USDT',
    timeframes_native: [30],
    timeframes_derived: [],
    page_size: 20,
    pagination_kind: 'numeric',
    boards: futures ? ['futures_grid', 'futures_martingale'] : ['spot_grid', 'spot_martingale'],
    cadence_contract_exact: true,
    capture_contract: PARTITIONED_V4_CAPTURE_CONTRACT,
    adapter_slug: 'bitget_bots',
    attempt_binding_contract: PARTITIONED_V4_ATTEMPT_BINDING_CONTRACT,
    requires_runner_git_sha: true,
  }
}

function rpcRow(): Record<string, unknown> {
  return {
    start_rpc_sha256: PARTITIONED_V4_START_RPC_SHA256,
    finish_rpc_sha256: PARTITIONED_V4_FINISH_RPC_SHA256,
    start_contract_exact: true,
    finish_contract_exact: true,
    rpc_acl_exact: true,
  }
}

function readyPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract: PARTITIONED_V4_WORKER_READINESS_CONTRACT,
    registry: [registryRow('futures'), registryRow('spot')],
    rpc: rpcRow(),
    ...overrides,
  }
}

describe('partitioned V4 worker startup readiness', () => {
  it('accepts only the explicit lowercase true rollout authority', () => {
    expect(() =>
      assertAttemptBoundCaptureRuntimeEnabled({
        INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED: 'true',
      })
    ).not.toThrow()

    for (const value of [undefined, '', 'false', 'TRUE', '1', ' true']) {
      expect(() =>
        assertAttemptBoundCaptureRuntimeEnabled({
          INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED: value,
        })
      ).toThrow('attempt-bound capture must be explicitly enabled')
    }

    expect(() =>
      assertAttemptBoundCaptureEnvironmentFile({
        parsed: { INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED: 'true' },
      })
    ).not.toThrow()
    expect(() => assertAttemptBoundCaptureEnvironmentFile({})).toThrow('worker/.env is unavailable')
    expect(() =>
      assertAttemptBoundCaptureEnvironmentFile({
        error: new Error('secret path'),
        parsed: { INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED: 'true' },
      })
    ).toThrow('worker/.env is unavailable')
  })

  it('accepts only two exact canonical active Bitget bot source contracts', () => {
    expect(() => validatePartitionedV4WorkerReadiness(readyPayload())).not.toThrow()

    const driftCases: Array<[string, unknown]> = [
      ['exchange_slug', 'binance'],
      ['source_adapter_slug', 'bitget'],
      ['product_type', 'spot'],
      ['trader_kind_scope', 'human'],
      ['status', 'disabled'],
      ['serving_mode', 'quarantined'],
      ['currency', 'USD'],
      ['timeframes_native', [7, 30]],
      ['timeframes_derived', [90]],
      ['page_size', 100],
      ['pagination_kind', 'cursor'],
      ['boards', ['futures_grid']],
      ['cadence_contract_exact', false],
      ['capture_contract', 'arena.ingest.leaderboard-acquisition-manifest@3'],
      ['adapter_slug', 'wrong'],
      ['attempt_binding_contract', 'wrong'],
      ['requires_runner_git_sha', false],
    ]
    for (const [key, value] of driftCases) {
      const registry = [registryRow('futures'), registryRow('spot')]
      registry[0] = { ...registry[0], [key]: value }
      expect(() => validatePartitionedV4WorkerReadiness(readyPayload({ registry }))).toThrow(
        'capture registry is not exact'
      )
    }

    expect(() =>
      validatePartitionedV4WorkerReadiness(
        readyPayload({ registry: [registryRow('spot'), registryRow('futures')] })
      )
    ).toThrow('capture registry is not exact')
    expect(() =>
      validatePartitionedV4WorkerReadiness(readyPayload({ registry: [registryRow('futures')] }))
    ).toThrow('capture registry cardinality is not exact')
  })

  it('rejects RPC body, execution contract, ACL, shape, and contract drift', () => {
    for (const rpc of [
      { ...rpcRow(), start_rpc_sha256: '0'.repeat(64) },
      { ...rpcRow(), finish_rpc_sha256: '0'.repeat(64) },
      { ...rpcRow(), start_contract_exact: false },
      { ...rpcRow(), finish_contract_exact: false },
      { ...rpcRow(), rpc_acl_exact: false },
      { ...rpcRow(), extra: true },
    ]) {
      expect(() => validatePartitionedV4WorkerReadiness(readyPayload({ rpc }))).toThrow(
        'startup gate failed closed'
      )
    }
    expect(() => validatePartitionedV4WorkerReadiness(readyPayload({ contract: 'wrong' }))).toThrow(
      'readiness contract is not exact'
    )
    expect(() => validatePartitionedV4WorkerReadiness({ ...readyPayload(), extra: true })).toThrow(
      'readiness payload is malformed'
    )
  })

  it('reads registry and RPC evidence in one bounded read-only transaction', async () => {
    const queries: string[] = []
    let releases = 0
    const client: AttemptBoundCaptureReadinessClient = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql)
        if (sql.includes('WITH candidate_sources AS')) {
          return {
            rowCount: 2,
            rows: [registryRow('futures'), registryRow('spot')],
          }
        }
        if (sql.includes('FROM pg_catalog.pg_proc AS start_proc')) {
          return { rowCount: 1, rows: [rpcRow()] }
        }
        return { rowCount: null, rows: [] }
      }),
      release: () => {
        releases += 1
      },
    }

    await expect(
      loadPartitionedV4WorkerReadiness({ connect: async () => client })
    ).resolves.toEqual(readyPayload())
    expect(queries[0]).toBe('BEGIN TRANSACTION READ ONLY')
    expect(queries[1]).toBe("SET LOCAL statement_timeout = '10s'")
    expect(queries[2]).toContain("source_row.status = 'active'")
    expect(queries[2]).toContain("source_row.adapter_slug = 'bitget_bots'")
    expect(queries[2]).toContain(PARTITIONED_V4_CAPTURE_CONTRACT)
    expect(queries[3]).toContain('pg_catalog.encode(')
    expect(queries[3]).toContain('pg_catalog.convert_to(')
    expect(queries[3]).toContain('pg_catalog.aclexplode(')
    expect(queries[3]).toContain("'service_role'::pg_catalog.regrole")
    expect(queries[3]).toContain("'service_role'")
    expect(queries[4]).toBe('COMMIT')
    expect(releases).toBe(1)
  })

  it('rolls back, releases, sanitizes database errors, and bounds hangs', async () => {
    const queries: string[] = []
    let releases = 0
    const client: AttemptBoundCaptureReadinessClient = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql)
        if (sql.includes('WITH candidate_sources AS')) {
          throw new Error('postgresql://user:secret@example.invalid')
        }
        return { rowCount: null, rows: [] }
      }),
      release: () => {
        releases += 1
      },
    }

    await expect(
      assertPartitionedV4WorkerReadiness({
        load: () => loadPartitionedV4WorkerReadiness({ connect: async () => client }),
      })
    ).rejects.toThrow('readiness query is unavailable')
    expect(queries.at(-1)).toBe('ROLLBACK')
    expect(releases).toBe(1)

    await expect(
      assertPartitionedV4WorkerReadiness({
        load: () => new Promise<never>(() => undefined),
        timeoutMs: 5,
      })
    ).rejects.toThrow('readiness query is unavailable')
  })

  it('gates the ingest entrypoint before database, adapter, Redis, or authority work', () => {
    const source = readFileSync(join(process.cwd(), 'worker/src/ingest-worker.ts'), 'utf8')
    const main = source.slice(source.indexOf('async function main(): Promise<void>'))
    const fileFlag = main.indexOf('assertAttemptBoundCaptureEnvironmentFile(workerEnvironment)')
    const effectiveFlag = main.indexOf('assertAttemptBoundCaptureRuntimeEnabled(process.env)')
    const metricGate = main.indexOf('await assertMetricTrustWorkerReadiness()')
    const v4Gate = main.indexOf('await assertPartitionedV4WorkerReadiness()')
    const adapterRegistration = main.indexOf("await import('@/lib/ingest/adapters/register')")

    expect(fileFlag).toBeGreaterThan(-1)
    expect(effectiveFlag).toBeGreaterThan(fileFlag)
    expect(metricGate).toBeGreaterThan(effectiveFlag)
    expect(v4Gate).toBeGreaterThan(metricGate)
    expect(adapterRegistration).toBeGreaterThan(v4Gate)
    expect(main.indexOf('const redis = getConnection()')).toBeGreaterThan(v4Gate)
    expect(main.indexOf('await acquireRegionAuthorityLifecycleWithRetry({')).toBeGreaterThan(v4Gate)
    expect(main).toContain('[ingest-worker] partitioned V4 database release contract ready')
  })
})
