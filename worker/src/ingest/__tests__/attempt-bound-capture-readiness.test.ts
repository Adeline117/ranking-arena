import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  PARTITIONED_V4_ATTEMPT_BINDING_CONTRACT,
  PARTITIONED_V4_CLAIMED_FINISH_RPC_SHA256,
  PARTITIONED_V4_CLAIMED_START_RPC_SHA256,
  PARTITIONED_V4_CAPTURE_CONTRACT,
  PARTITIONED_V4_FINISH_RPC_SHA256,
  PARTITIONED_V4_START_RPC_SHA256,
  PARTITIONED_V4_WORKER_READINESS_CONTRACT,
  TIER_A_EXECUTION_ASSERT_RPC_SHA256,
  TIER_A_EXECUTION_CLAIM_ENFORCEMENT_CONTRACT,
  TIER_A_EXECUTION_CLAIM_RPC_SHA256,
  TIER_A_EXECUTION_CLOSE_RPC_SHA256,
  TIER_A_EXECUTION_CONSTRAINT_CATALOG_SHA256,
  TIER_A_EXECUTION_ENFORCEMENT_MARKER_RPC_SHA256,
  TIER_A_EXECUTION_GET_RECEIPT_RPC_SHA256,
  TIER_A_EXECUTION_HEARTBEAT_RPC_SHA256,
  TIER_A_EXECUTION_RECORD_RECEIPT_RPC_PRE_EXHAUSTION_SHA256,
  TIER_A_EXECUTION_RECORD_RECEIPT_RPC_SHA256,
  TIER_A_EXECUTION_RECORD_RECEIPT_RPC_SHA256S,
  TIER_A_EXECUTION_TRIGGER_CATALOG_SHA256,
  TIER_A_ONE_PHASE_COMMIT_HELPER_SHA256,
  assertPartitionedV4WorkerReadiness,
  loadPartitionedV4WorkerReadiness,
  validatePartitionedV4WorkerReadiness,
  type AttemptBoundCaptureReadinessClient,
} from '../attempt-bound-capture-readiness'
import { assertWorkerEnvironmentFileLoaded } from '../worker-environment-file'

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

type EnforcementState = 'enforced' | 'expand'

function rpcRow(state: EnforcementState = 'expand'): Record<string, unknown> {
  return {
    legacy_start_rpc_sha256: PARTITIONED_V4_START_RPC_SHA256,
    legacy_finish_rpc_sha256: PARTITIONED_V4_FINISH_RPC_SHA256,
    claimed_start_rpc_sha256: PARTITIONED_V4_CLAIMED_START_RPC_SHA256,
    claimed_finish_rpc_sha256: PARTITIONED_V4_CLAIMED_FINISH_RPC_SHA256,
    execution_claim_rpc_sha256: TIER_A_EXECUTION_CLAIM_RPC_SHA256,
    execution_heartbeat_rpc_sha256: TIER_A_EXECUTION_HEARTBEAT_RPC_SHA256,
    execution_assert_rpc_sha256: TIER_A_EXECUTION_ASSERT_RPC_SHA256,
    execution_close_rpc_sha256: TIER_A_EXECUTION_CLOSE_RPC_SHA256,
    execution_record_receipt_rpc_sha256: TIER_A_EXECUTION_RECORD_RECEIPT_RPC_SHA256,
    execution_get_receipt_rpc_sha256: TIER_A_EXECUTION_GET_RECEIPT_RPC_SHA256,
    legacy_contract_exact: true,
    claimed_runtime_contract_exact: true,
    claimed_runtime_acl_exact: true,
    legacy_expand_acl_exact: state === 'expand',
    legacy_enforced_acl_exact: state === 'enforced',
  }
}

function enforcementCatalog(state: EnforcementState): Record<string, unknown> {
  return state === 'expand'
    ? {
        marker_present: false,
        marker_rpc_sha256: null,
        marker_contract_exact: false,
        marker_acl_exact: false,
        one_phase_commit_exact: true,
        substrate_contract_exact: false,
      }
    : {
        marker_present: true,
        marker_rpc_sha256: TIER_A_EXECUTION_ENFORCEMENT_MARKER_RPC_SHA256,
        marker_contract_exact: true,
        marker_acl_exact: true,
        one_phase_commit_exact: true,
        substrate_contract_exact: true,
      }
}

function enforcementPayload(state: EnforcementState): Record<string, unknown> {
  return {
    ...enforcementCatalog(state),
    marker_payload:
      state === 'enforced'
        ? {
            contract: TIER_A_EXECUTION_CLAIM_ENFORCEMENT_CONTRACT,
            state: 'enforced',
          }
        : null,
    state,
  }
}

function readyPayload(
  overrides: Record<string, unknown> = {},
  state: EnforcementState = 'expand'
): Record<string, unknown> {
  return {
    contract: PARTITIONED_V4_WORKER_READINESS_CONTRACT,
    enforcement: enforcementPayload(state),
    registry: [registryRow('futures'), registryRow('spot')],
    rpc: rpcRow(state),
    ...overrides,
  }
}

describe('partitioned V4 worker startup readiness', () => {
  it('requires a loaded worker/.env (no capture rollout toggle remains)', () => {
    expect(() => assertWorkerEnvironmentFileLoaded({ parsed: {} })).not.toThrow()
    expect(() => assertWorkerEnvironmentFileLoaded({})).toThrow('worker/.env is unavailable')
    expect(() =>
      assertWorkerEnvironmentFileLoaded({ error: new Error('secret path'), parsed: {} })
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

  it('accepts the exact expand → enforced transition without weakening either state', async () => {
    expect(() => validatePartitionedV4WorkerReadiness(readyPayload())).not.toThrow()
    expect(() => validatePartitionedV4WorkerReadiness(readyPayload({}, 'enforced'))).not.toThrow()

    let state: EnforcementState = 'expand'
    const load = jest.fn(async () => readyPayload({}, state))
    await expect(assertPartitionedV4WorkerReadiness({ load })).resolves.toBeUndefined()
    state = 'enforced'
    await expect(assertPartitionedV4WorkerReadiness({ load })).resolves.toBeUndefined()
    expect(load).toHaveBeenCalledTimes(2)

    expect(() =>
      validatePartitionedV4WorkerReadiness(readyPayload({ rpc: rpcRow('enforced') }, 'expand'))
    ).toThrow('expand execution enforcement state is not exact')
    expect(() =>
      validatePartitionedV4WorkerReadiness(readyPayload({ rpc: rpcRow('expand') }, 'enforced'))
    ).toThrow('enforced execution enforcement state is not exact')

    expect(() =>
      validatePartitionedV4WorkerReadiness(
        readyPayload({
          enforcement: {
            ...enforcementPayload('expand'),
            one_phase_commit_exact: false,
          },
        })
      )
    ).toThrow('expand execution enforcement state is not exact')
    expect(() =>
      validatePartitionedV4WorkerReadiness(
        readyPayload(
          {
            enforcement: {
              ...enforcementPayload('enforced'),
              one_phase_commit_exact: false,
            },
          },
          'enforced'
        )
      )
    ).toThrow('enforced execution enforcement state is not exact')
  })

  it('rejects missing or drifted claimed/execution RPCs and every non-exact ACL', () => {
    const hashKeys = [
      'legacy_start_rpc_sha256',
      'legacy_finish_rpc_sha256',
      'claimed_start_rpc_sha256',
      'claimed_finish_rpc_sha256',
      'execution_claim_rpc_sha256',
      'execution_heartbeat_rpc_sha256',
      'execution_assert_rpc_sha256',
      'execution_close_rpc_sha256',
      'execution_record_receipt_rpc_sha256',
      'execution_get_receipt_rpc_sha256',
    ] as const
    for (const key of hashKeys) {
      expect(() =>
        validatePartitionedV4WorkerReadiness(
          readyPayload({ rpc: { ...rpcRow(), [key]: '0'.repeat(64) } })
        )
      ).toThrow('acquisition RPC contract is not exact')
    }

    // Either receipt body passes (worker deploy and 20261118161307 may come in
    // either order); nothing else does.
    for (const digest of [
      TIER_A_EXECUTION_RECORD_RECEIPT_RPC_PRE_EXHAUSTION_SHA256,
      TIER_A_EXECUTION_RECORD_RECEIPT_RPC_SHA256,
    ]) {
      expect(() =>
        validatePartitionedV4WorkerReadiness(
          readyPayload({ rpc: { ...rpcRow(), execution_record_receipt_rpc_sha256: digest } })
        )
      ).not.toThrow()
    }
    for (const digest of [null, 42, TIER_A_EXECUTION_GET_RECEIPT_RPC_SHA256.toUpperCase()]) {
      expect(() =>
        validatePartitionedV4WorkerReadiness(
          readyPayload({ rpc: { ...rpcRow(), execution_record_receipt_rpc_sha256: digest } })
        )
      ).toThrow('acquisition RPC contract is not exact')
    }

    for (const rpc of [
      { ...rpcRow(), claimed_start_rpc_sha256: null },
      { ...rpcRow(), claimed_runtime_contract_exact: false },
      { ...rpcRow(), claimed_runtime_acl_exact: false },
      { ...rpcRow(), legacy_contract_exact: false },
      { ...rpcRow(), legacy_expand_acl_exact: false },
      { ...rpcRow(), extra: true },
    ]) {
      expect(() => validatePartitionedV4WorkerReadiness(readyPayload({ rpc }))).toThrow(
        'startup gate failed closed'
      )
    }

    // A rogue grant makes both exact ACL predicates false. Neither rollout
    // state may reinterpret that third state as compatible.
    const rogueExpand = {
      ...rpcRow('expand'),
      legacy_expand_acl_exact: false,
      legacy_enforced_acl_exact: false,
    }
    const rogueEnforced = {
      ...rpcRow('enforced'),
      legacy_expand_acl_exact: false,
      legacy_enforced_acl_exact: false,
    }
    expect(() => validatePartitionedV4WorkerReadiness(readyPayload({ rpc: rogueExpand }))).toThrow(
      'expand execution enforcement state is not exact'
    )
    expect(() =>
      validatePartitionedV4WorkerReadiness(readyPayload({ rpc: rogueEnforced }, 'enforced'))
    ).toThrow('enforced execution enforcement state is not exact')

    expect(() => validatePartitionedV4WorkerReadiness(readyPayload({ contract: 'wrong' }))).toThrow(
      'readiness contract is not exact'
    )
    expect(() => validatePartitionedV4WorkerReadiness({ ...readyPayload(), extra: true })).toThrow(
      'readiness payload is malformed'
    )
  })

  it('rejects a forged, malformed, or wrongly granted enforcement marker', () => {
    const enforced = enforcementPayload('enforced')
    const missingOnePhaseProof = { ...enforced }
    delete missingOnePhaseProof.one_phase_commit_exact
    for (const enforcement of [
      { ...enforced, marker_present: false },
      { ...enforced, marker_rpc_sha256: '0'.repeat(64) },
      { ...enforced, marker_contract_exact: false },
      { ...enforced, marker_acl_exact: false },
      { ...enforced, one_phase_commit_exact: false },
      { ...enforced, substrate_contract_exact: false },
      { ...enforced, marker_payload: null },
      missingOnePhaseProof,
      {
        ...enforced,
        marker_payload: { contract: TIER_A_EXECUTION_CLAIM_ENFORCEMENT_CONTRACT },
      },
      {
        ...enforced,
        marker_payload: {
          contract: TIER_A_EXECUTION_CLAIM_ENFORCEMENT_CONTRACT,
          state: 'expand',
        },
      },
      { ...enforced, extra: true },
    ]) {
      expect(() =>
        validatePartitionedV4WorkerReadiness(readyPayload({ enforcement }, 'enforced'))
      ).toThrow('startup gate failed closed')
    }
  })

  it('reads expand evidence in one bounded repeatable read-only transaction', async () => {
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
        if (sql.includes('WITH marker_identity AS')) {
          return { rowCount: 1, rows: [enforcementCatalog('expand')] }
        }
        if (sql.includes('WITH expected(')) {
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
    expect(queries[0]).toBe('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    expect(queries[1]).toBe("SET LOCAL statement_timeout = '10s'")
    expect(queries[2]).toBe('SET LOCAL search_path = pg_catalog, pg_temp')
    expect(queries[3]).toContain("source_row.status = 'active'")
    expect(queries[3]).toContain("source_row.adapter_slug = 'bitget_bots'")
    expect(queries[3]).toContain(PARTITIONED_V4_CAPTURE_CONTRACT)
    expect(queries[4]).toContain('tier_a_execution_claim_enforcement_state()')
    expect(queries[4]).toContain('one_phase_commit_contract AS')
    expect(queries[4]).toContain(
      'COALESCE(one_phase_commit_contract.exact, false) AS one_phase_commit_exact'
    )
    expect(queries[4]).toContain('substrate_contract_exact')
    expect(queries[4]).toContain(TIER_A_EXECUTION_CONSTRAINT_CATALOG_SHA256)
    expect(queries[4]).toContain(TIER_A_EXECUTION_TRIGGER_CATALOG_SHA256)
    expect(queries[4]).toContain('pg_catalog.count(*) = 65')
    expect(queries[4]).toContain('pg_catalog.count(*) = 24')
    // The arena.sources name guard (20261122204058) is outside the Tier-A
    // contract and is excluded only by its exact identity.
    expect(queries[4]).toContain("trigger_row.tgname = 'sources_reject_ambiguous_serving_name'")
    expect(queries[4]).toContain("function_row.proname = 'reject_ambiguous_serving_source_name'")
    expect(queries[4]).toContain('trigger_row.tgtype = 23')
    expect(queries[4]).toContain("trigger_row.tgattr::text = '2 27 26 25'")
    expect(queries[4]).toContain('trigger_row.tgqual IS NULL')
    expect(queries[4]).toContain('NOT function_row.prosecdef')
    expect(queries[4]).toContain(
      "= '254a1583a8bd4d67762d8f9ff8a5d068425878f1cf4e57abc010c8989a8d8d8f'"
    )
    expect(queries[4]).toContain('pg_catalog.count(attribute.attrelid) = 33')
    expect(queries[4]).toContain('pg_catalog.count(function_row.oid) = 17')
    expect(queries[4]).toContain("'verification_round'::name")
    expect(queries[4]).toContain("'one_phase_commit_required'::name")
    expect(queries[4]).toContain("'arena.require_tier_a_one_phase_commit()'")
    expect(queries[4]).toContain(TIER_A_ONE_PHASE_COMMIT_HELPER_SHA256)
    expect(queries[4]).toContain("'statement_timeout=5s'")
    expect(queries[4]).toContain("function_row.proowner = pg_catalog.to_regrole('postgres')")
    expect(queries[4]).toContain('function_row.prosecdef = expected.security_definer')
    expect(queries[4]).toContain('function_row.provolatile::text = expected.volatility')
    expect(queries[4]).toContain('function_row.proconfig IS NOT DISTINCT FROM expected.config')
    expect(queries[4]).toContain('acl_row.grantee <> function_row.proowner')
    expect(queries[4]).toContain("helper.proowner = pg_catalog.to_regrole('postgres')")
    expect(queries[4]).toContain('helper.proconfig IS NOT DISTINCT FROM ARRAY[')
    expect(queries[4]).toContain("guard_column.atttypid = 'boolean'::pg_catalog.regtype")
    expect(queries[4]).toContain(") = 'arena.require_tier_a_one_phase_commit()'")
    expect(queries[4]).toContain("guard_table.relkind = 'r'")
    expect(queries[4]).toContain('guard_table.relrowsecurity')
    expect(queries[4]).toContain('NOT guard_table.relforcerowsecurity')
    expect(queries[4]).toContain('acl_row.grantee <> guard_table.relowner')
    expect(queries[4]).toContain('guarded_attribute.attacl')
    expect(queries[4]).toContain(
      "pg_catalog.current_setting('max_prepared_transactions')::integer = 0"
    )
    expect(queries[4]).toContain("'MAINTAIN'")
    expect(queries[5]).toContain('pg_catalog.encode(')
    expect(queries[5]).toContain('pg_catalog.convert_to(')
    expect(queries[5]).toContain('pg_catalog.aclexplode(')
    expect(queries[5]).toContain("'service_role'::pg_catalog.regrole")
    expect(queries[5]).toContain("'anon', function_row.oid")
    expect(queries[5]).toContain("'authenticated', function_row.oid")
    expect(queries[5]).toContain(PARTITIONED_V4_CLAIMED_START_RPC_SHA256)
    expect(queries[5]).toContain(
      `ARRAY['${TIER_A_EXECUTION_RECORD_RECEIPT_RPC_PRE_EXHAUSTION_SHA256}', '${TIER_A_EXECUTION_RECORD_RECEIPT_RPC_SHA256}']::pg_catalog.text[]`
    )
    expect(queries[5]).toContain('= ANY (expected.expected_sha256s)')
    expect(queries).not.toContain(
      'SELECT arena.tier_a_execution_claim_enforcement_state() AS enforcement_state'
    )
    expect(queries[6]).toBe('COMMIT')
    expect(releases).toBe(1)
  })

  it('rejects expand startup when the one-phase migration proof is absent', async () => {
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
        if (sql.includes('WITH marker_identity AS')) {
          return {
            rowCount: 1,
            rows: [
              {
                ...enforcementCatalog('expand'),
                one_phase_commit_exact: false,
              },
            ],
          }
        }
        if (sql.includes('WITH expected(')) {
          return { rowCount: 1, rows: [rpcRow('expand')] }
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
    ).rejects.toThrow('expand execution enforcement state is not exact')
    expect(queries.at(-1)).toBe('COMMIT')
    expect(releases).toBe(1)
  })

  it('fails closed before invoking the marker when the independent one-phase proof is false', async () => {
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
        if (sql.includes('WITH marker_identity AS')) {
          return {
            rowCount: 1,
            rows: [
              {
                ...enforcementCatalog('enforced'),
                one_phase_commit_exact: false,
              },
            ],
          }
        }
        if (sql.includes('WITH expected(')) {
          return { rowCount: 1, rows: [rpcRow('enforced')] }
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
    ).rejects.toThrow('enforced execution enforcement state is not exact')
    expect(queries).not.toContain(
      'SELECT arena.tier_a_execution_claim_enforcement_state() AS enforcement_state'
    )
    expect(queries.at(-1)).toBe('COMMIT')
    expect(releases).toBe(1)
  })

  it('restarts after postdeploy from the exact marker and owner-only legacy ACL', async () => {
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
        if (sql.includes('WITH marker_identity AS')) {
          return { rowCount: 1, rows: [enforcementCatalog('enforced')] }
        }
        if (sql.includes('WITH expected(')) {
          return { rowCount: 1, rows: [rpcRow('enforced')] }
        }
        if (sql.includes('SELECT arena.tier_a_execution_claim_enforcement_state()')) {
          return {
            rowCount: 1,
            rows: [
              {
                enforcement_state: {
                  contract: TIER_A_EXECUTION_CLAIM_ENFORCEMENT_CONTRACT,
                  state: 'enforced',
                },
              },
            ],
          }
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
    ).resolves.toBeUndefined()

    expect(queries[0]).toBe('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    expect(queries[2]).toBe('SET LOCAL search_path = pg_catalog, pg_temp')
    expect(queries[4]).toContain('tier_a_execution_claim_enforcement_state()')
    expect(queries[4]).toContain('marker_rpc_sha256')
    expect(queries[4]).toContain(TIER_A_EXECUTION_ENFORCEMENT_MARKER_RPC_SHA256)
    expect(queries[4]).toContain('substrate_contract_exact')
    expect(queries[5]).toContain(PARTITIONED_V4_CLAIMED_FINISH_RPC_SHA256)
    expect(queries[6]).toBe(
      'SELECT arena.tier_a_execution_claim_enforcement_state() AS enforcement_state'
    )
    expect(queries[7]).toBe('COMMIT')
    expect(releases).toBe(1)
  })

  it('locks RPC bodies, marker, and live catalog digests to the migration contract', () => {
    const executionClaimMigration = readFileSync(
      join(process.cwd(), 'supabase/migrations/20260729015500_tier_a_execution_claim_fence.sql'),
      'utf8'
    )
    const enforcementMigration = readFileSync(
      join(
        process.cwd(),
        'supabase/migrations/20261111192134_tier_a_execution_claim_enforcement_later_raw_guards.sql'
      ),
      'utf8'
    )
    const receiptExhaustionMigration = readFileSync(
      join(
        process.cwd(),
        'supabase/migrations/20261118161307_tier_a_window_receipt_exhaustion_branch.sql'
      ),
      'utf8'
    )
    const onePhaseMigration = readFileSync(
      join(process.cwd(), 'supabase/migrations/20260729071500_tier_a_one_phase_commit_guard.sql'),
      'utf8'
    )
    const directBody = (migration: string, functionName: string): string => {
      const declaration = `CREATE OR REPLACE FUNCTION arena.${functionName}(`
      const declarationIndex = migration.indexOf(declaration)
      expect(declarationIndex).toBeGreaterThan(-1)
      const bodyStartMarker = 'AS $function$'
      const bodyStart = migration.indexOf(bodyStartMarker, declarationIndex)
      expect(bodyStart).toBeGreaterThan(declarationIndex)
      const contentStart = bodyStart + bodyStartMarker.length
      const bodyEnd = migration.indexOf('$function$;', contentStart)
      expect(bodyEnd).toBeGreaterThan(contentStart)
      return migration.slice(contentStart, bodyEnd)
    }
    const sha256 = (value: string): string =>
      createHash('sha256').update(value, 'utf8').digest('hex')

    expect(
      sha256(directBody(executionClaimMigration, 'start_leaderboard_acquisition_attempt'))
    ).toBe(PARTITIONED_V4_CLAIMED_START_RPC_SHA256)
    expect(
      sha256(directBody(executionClaimMigration, 'finish_leaderboard_acquisition_attempt'))
    ).toBe(PARTITIONED_V4_CLAIMED_FINISH_RPC_SHA256)
    expect(sha256(directBody(executionClaimMigration, 'claim_tier_a_execution'))).toBe(
      TIER_A_EXECUTION_CLAIM_RPC_SHA256
    )
    expect(sha256(directBody(executionClaimMigration, 'heartbeat_tier_a_execution'))).toBe(
      TIER_A_EXECUTION_HEARTBEAT_RPC_SHA256
    )
    const executionAssertBody = directBody(executionClaimMigration, 'assert_tier_a_execution_write')
    expect(sha256(executionAssertBody)).toBe(TIER_A_EXECUTION_ASSERT_RPC_SHA256)
    expect(executionAssertBody).toContain(`INSERT INTO arena.tier_a_execution_write_guards (
      contract,
      top_xid8_text,
      source_id,
      generation_seq,
      claim_id,
      authority_scope,
      authority_epoch,
      worker_instance_id,
      worker_node_id,
      worker_region,
      control_epoch,
      release_id,
      git_sha,
      asserted_at,
      lease_expires_at_at_assertion
    ) VALUES (`)
    expect(executionAssertBody).not.toContain('one_phase_commit_required')
    expect(sha256(directBody(executionClaimMigration, 'close_tier_a_execution'))).toBe(
      TIER_A_EXECUTION_CLOSE_RPC_SHA256
    )
    expect(
      sha256(directBody(executionClaimMigration, 'record_tier_a_execution_window_receipt'))
    ).toBe(TIER_A_EXECUTION_RECORD_RECEIPT_RPC_PRE_EXHAUSTION_SHA256)
    expect(
      sha256(directBody(receiptExhaustionMigration, 'record_tier_a_execution_window_receipt'))
    ).toBe(TIER_A_EXECUTION_RECORD_RECEIPT_RPC_SHA256)
    expect(TIER_A_EXECUTION_RECORD_RECEIPT_RPC_SHA256S).toEqual([
      TIER_A_EXECUTION_RECORD_RECEIPT_RPC_PRE_EXHAUSTION_SHA256,
      TIER_A_EXECUTION_RECORD_RECEIPT_RPC_SHA256,
    ])
    expect(sha256(directBody(executionClaimMigration, 'get_tier_a_execution_window_receipt'))).toBe(
      TIER_A_EXECUTION_GET_RECEIPT_RPC_SHA256
    )
    expect(
      sha256(directBody(enforcementMigration, 'tier_a_execution_claim_enforcement_state'))
    ).toBe(TIER_A_EXECUTION_ENFORCEMENT_MARKER_RPC_SHA256)
    expect(sha256(directBody(onePhaseMigration, 'require_tier_a_one_phase_commit'))).toBe(
      TIER_A_ONE_PHASE_COMMIT_HELPER_SHA256
    )
    expect(onePhaseMigration)
      .toContain(`CREATE OR REPLACE FUNCTION arena.require_tier_a_one_phase_commit()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '5s'`)
    expect(onePhaseMigration).toContain(`ALTER FUNCTION arena.require_tier_a_one_phase_commit()
  OWNER TO postgres;`)
    expect(onePhaseMigration).toContain('NOT NULL DEFAULT arena.require_tier_a_one_phase_commit();')
    expect(onePhaseMigration).toContain('expanded.grantee <> function_row.proowner')
    expect(onePhaseMigration).toContain(TIER_A_EXECUTION_ASSERT_RPC_SHA256)

    const postflightStart = enforcementMigration.indexOf('DO $postflight$')
    const constraintManifestStart = enforcementMigration.indexOf(
      '    WITH manifest(\n',
      postflightStart
    )
    const constraintManifestEnd = enforcementMigration.indexOf(
      '    expected AS (',
      constraintManifestStart
    )
    expect(postflightStart).toBeGreaterThan(-1)
    expect(constraintManifestStart).toBeGreaterThan(postflightStart)
    expect(constraintManifestEnd).toBeGreaterThan(constraintManifestStart)
    const constraintRows = Array.from(
      enforcementMigration
        .slice(constraintManifestStart, constraintManifestEnd)
        .matchAll(
          /\('arena\.([^']+)'::pg_catalog\.regclass, '([^']+)', '([^']+)', '([0-9a-f]{64})'\)/g
        ),
      ([, tableName, constraintName, constraintType, definitionSha256]) => {
        const validated = constraintName !== 'leaderboard_acquisition_attempts_execution_required'
        const noInherit = constraintType !== 'c'
        const deferred = constraintType === 't'
        return [
          'arena',
          tableName,
          constraintName,
          constraintType,
          validated ? '1' : '0',
          noInherit ? '1' : '0',
          '1',
          '0',
          '0',
          deferred ? '1' : '0',
          deferred ? '1' : '0',
          definitionSha256,
        ].join('|')
      }
    ).sort()
    expect(constraintRows).toHaveLength(65)
    expect(sha256(constraintRows.join('\n'))).toBe(TIER_A_EXECUTION_CONSTRAINT_CATALOG_SHA256)

    const triggerManifestStart = enforcementMigration.indexOf(
      'INSERT INTO tier_a_claim_enforcement_expected_triggers'
    )
    const triggerManifestEnd = enforcementMigration.indexOf(
      'UPDATE tier_a_claim_enforcement_expected_triggers',
      triggerManifestStart
    )
    expect(triggerManifestStart).toBeGreaterThan(-1)
    expect(triggerManifestEnd).toBeGreaterThan(triggerManifestStart)
    const triggerRows = Array.from(
      enforcementMigration
        .slice(triggerManifestStart, triggerManifestEnd)
        .matchAll(
          /\(\s*'arena\.([^']+)'::pg_catalog\.regclass,\s*'([^']+)',\s*'arena\.([^']+)'::pg_catalog\.regprocedure,\s*(\d+),\s*(true|false),\s*(true|false)\s*\)/g
        ),
      ([, tableName, triggerName, functionSignature, triggerType, deferrable, deferred]) =>
        [
          'arena',
          tableName,
          triggerName,
          'O',
          'arena',
          functionSignature,
          triggerType,
          deferrable === 'true' ? '1' : '0',
          deferred === 'true' ? '1' : '0',
          triggerName === 'tier_a_execution_fence_commit_assertion' ? '1' : '0',
          '0',
          '0',
          '',
          '<NULL>',
          '0',
        ].join('|')
    ).sort()
    expect(triggerRows).toHaveLength(24)
    expect(sha256(triggerRows.join('\n'))).toBe(TIER_A_EXECUTION_TRIGGER_CATALOG_SHA256)
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
    const environmentFile = main.indexOf('assertWorkerEnvironmentFileLoaded(workerEnvironment)')
    const metricGate = main.indexOf('await assertMetricTrustWorkerReadiness()')
    const v4Gate = main.indexOf('await assertPartitionedV4WorkerReadiness()')
    const adapterRegistration = main.indexOf("await import('@/lib/ingest/adapters/register')")

    expect(environmentFile).toBeGreaterThan(-1)
    expect(main).not.toContain('INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED')
    expect(metricGate).toBeGreaterThan(environmentFile)
    expect(v4Gate).toBeGreaterThan(metricGate)
    expect(adapterRegistration).toBeGreaterThan(v4Gate)
    expect(main.indexOf('const redis = getConnection()')).toBeGreaterThan(v4Gate)
    expect(main.indexOf('await acquireRegionAuthorityLifecycleWithRetry({')).toBeGreaterThan(v4Gate)
    expect(main).toContain('[ingest-worker] partitioned V4 database release contract ready')
  })
})
