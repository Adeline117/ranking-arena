import type { QueryResult, QueryResultRow } from 'pg'

import type { AuthorizedConsumedRegionContext } from '../consumed-region-context'
import {
  BULL_JOB_PROVENANCE_CONTRACT,
  type BullJobAuthority,
  type BullJobProvenance,
} from '../job-provenance'
import { INGEST_JOB } from '../job-names'
import type { RegionAuthorityFence } from '../region-authority-lifecycle'
import {
  assertTierAExecutionClaimedWrite,
  claimSourceJobExecutionAuthority,
  SOURCE_JOB_EXECUTION_ASSERT_SQL,
  SOURCE_JOB_EXECUTION_BULL_LOCK_MS,
  SOURCE_JOB_EXECUTION_CLAIM_SQL,
  SOURCE_JOB_EXECUTION_CLOSE_SQL,
  SOURCE_JOB_EXECUTION_CONTRACT,
  SOURCE_JOB_EXECUTION_DB_LEASE_SECONDS,
  SOURCE_JOB_EXECUTION_HEARTBEAT_MS,
  SOURCE_JOB_EXECUTION_HEARTBEAT_SQL,
  type SourceJobExecutionHeartbeatTimer,
  type TierAExecutionClaimedWrite,
} from '../source-job-execution-authority'
import {
  SOURCE_JOB_LEASE_PROVENANCE_CONTRACT,
  type SourceJobLeaseAuthority,
  type SourceJobLeaseProof,
} from '../source-job-lease'
import type { SourceJobRunProvenance } from '../source-job-routing'
import type { WorkerDbFenceProof, WorkerDbFencedWrite } from '../worker-db-fence'

const SOURCE_ID = 42
const CLAIM_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_CLAIM_ID = '22222222-2222-4222-8222-222222222222'
const SOURCE_LEASE_ID = '33333333-3333-4333-8333-333333333333'
const WORKER_INSTANCE_ID = '44444444-4444-4444-8444-444444444444'
const BULL_DIGEST = 'a'.repeat(64)
const SOURCE_DIGEST = 'b'.repeat(64)
const RELEASE_ID = 'c'.repeat(64)
const GIT_SHA = 'd'.repeat(40)
const CLAIMED_AT = '2026-07-28T12:00:00.000Z'
const CLAIM_LEASE_EXPIRES_AT = '2026-07-28T12:01:30.000Z'
const HEARTBEAT_AT = '2026-07-28T12:00:30.000Z'
const HEARTBEAT_LEASE_EXPIRES_AT = '2026-07-28T12:02:00.000Z'
const ASSERTED_AT = '2026-07-28T12:00:45.000Z'
const CLOSED_AT = '2026-07-28T12:02:30.000Z'

function queryResult(
  alias: string,
  payload: unknown,
  options: { command?: string; outerExtra?: boolean; rowCount?: number } = {}
): QueryResult<QueryResultRow> {
  return {
    command: options.command ?? 'SELECT',
    fields: [],
    oid: 0,
    rowCount: options.rowCount ?? 1,
    rows: [options.outerExtra ? { [alias]: payload, unexpected: true } : { [alias]: payload }],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, reject, resolve }
}

interface HarnessBehavior {
  assertGate?: Promise<void>
  assertPatch: Record<string, unknown>
  claimCommand?: string
  claimOuterExtra?: boolean
  claimPatch: Record<string, unknown>
  claimRowCount?: number
  closePatch: Record<string, unknown>
  commitGate?: Promise<void>
  heartbeatPatch: Record<string, unknown>
  queryFailure?: { error: Error; sql: string }
}

function harness(
  options: {
    bullProofPatch?: Partial<BullJobProvenance>
    executionRegion?: AuthorizedConsumedRegionContext['executionRegion']
    sourceId?: number
    sourceLeaseMissing?: boolean
    sourceProofPatch?: Partial<SourceJobLeaseProof>
  } = {}
) {
  const harnessSourceId = options.sourceId ?? SOURCE_ID
  const executionRegion = options.executionRegion ?? 'local'
  const order: string[] = []
  const behavior: HarnessBehavior = {
    assertPatch: {},
    claimPatch: {},
    closePatch: {},
    heartbeatPatch: {},
  }
  let regionActive = true
  let currentLeaseExpiresAt = CLAIM_LEASE_EXPIRES_AT
  let rollbackCount = 0
  const regionAbort = new AbortController()
  const jobAbort = new AbortController()

  const bullProof: BullJobProvenance = Object.freeze({
    contract: BULL_JOB_PROVENANCE_CONTRACT,
    queueName: 'arena:ingest:local',
    jobId: 'repeat:tiera:binance_futures',
    jobName: INGEST_JOB.TIER_A,
    attemptsMade: 2,
    attemptsStarted: 3,
    processorTokenSha256: BULL_DIGEST,
    ...options.bullProofPatch,
  })
  const bullExtendLock = jest.fn(async (durationMs: number) => {
    order.push(`bull:${durationMs}`)
  })
  const bullAssertActive = jest.fn(() => {
    order.push('bull-assert')
  })
  const bullJob: BullJobAuthority = Object.freeze({
    proof: bullProof,
    assertActive: bullAssertActive,
    extendLock: bullExtendLock,
    replaceDataIfOwned: jest.fn(async () => undefined),
  })

  const sourceProof: SourceJobLeaseProof = Object.freeze({
    contract: SOURCE_JOB_LEASE_PROVENANCE_CONTRACT,
    leaseId: SOURCE_LEASE_ID,
    lane: 'tier-a',
    scopeId: 'binance_futures',
    ownerTokenSha256: SOURCE_DIGEST,
    ...options.sourceProofPatch,
  })
  const sourceRenew = jest.fn(async () => {
    order.push('source-renew')
  })
  const sourceAssertOwned = jest.fn(() => {
    order.push('source-assert')
  })
  const sourceLease: SourceJobLeaseAuthority = Object.freeze({
    proof: sourceProof,
    assertOwned: sourceAssertOwned,
    renew: sourceRenew,
  })
  const provenance: SourceJobRunProvenance = Object.freeze({
    bullJob,
    sourceLease: options.sourceLeaseMissing ? null : sourceLease,
  })

  const workerProof: WorkerDbFenceProof = Object.freeze({
    authorityScope: 'region:local',
    controlEpoch: 12,
    controlServerTimeMs: 2_000,
    databaseEpoch: 34,
    databaseLeaseExpiresAt: '2026-07-28T12:03:00.000Z',
    databaseServerTime: '2026-07-28T12:00:00.000Z',
    initialControlServerTimeMs: 1_000,
    instanceId: WORKER_INSTANCE_ID,
    nodeId: 'worker-local-1',
    region: 'local',
  })

  const claimPayload = () => ({
    contract: SOURCE_JOB_EXECUTION_CONTRACT,
    source_id: harnessSourceId,
    generation_seq: 7,
    claim_id: CLAIM_ID,
    bull_proof_contract: BULL_JOB_PROVENANCE_CONTRACT,
    queue_name: bullProof.queueName,
    queue_job_id: bullProof.jobId,
    queue_job_name: bullProof.jobName,
    queue_attempt: bullProof.attemptsMade,
    queue_attempt_started: bullProof.attemptsStarted,
    bull_lock_token_sha256: bullProof.processorTokenSha256,
    source_lease_contract: SOURCE_JOB_LEASE_PROVENANCE_CONTRACT,
    source_lease_id: sourceProof.leaseId,
    source_lease_lane: sourceProof.lane,
    source_lease_scope_id: sourceProof.scopeId,
    source_lease_token_sha256: sourceProof.ownerTokenSha256,
    execution_region: executionRegion,
    authority_scope: workerProof.authorityScope,
    authority_epoch: workerProof.databaseEpoch,
    worker_instance_id: workerProof.instanceId,
    worker_node_id: workerProof.nodeId,
    worker_region: workerProof.region,
    control_epoch: workerProof.controlEpoch,
    release_id: RELEASE_ID,
    git_sha: GIT_SHA,
    lease_seconds: SOURCE_JOB_EXECUTION_DB_LEASE_SECONDS,
    phase: 'active',
    claimed_at: CLAIMED_AT,
    last_heartbeat_at: CLAIMED_AT,
    lease_expires_at: CLAIM_LEASE_EXPIRES_AT,
    ...behavior.claimPatch,
  })
  const heartbeatPayload = () => ({
    contract: SOURCE_JOB_EXECUTION_CONTRACT,
    source_id: harnessSourceId,
    generation_seq: 7,
    claim_id: CLAIM_ID,
    phase: 'active',
    last_heartbeat_at: HEARTBEAT_AT,
    lease_expires_at: HEARTBEAT_LEASE_EXPIRES_AT,
    ...behavior.heartbeatPatch,
  })
  const assertPayload = () => ({
    contract: SOURCE_JOB_EXECUTION_CONTRACT,
    source_id: harnessSourceId,
    generation_seq: 7,
    claim_id: CLAIM_ID,
    phase: 'active',
    asserted_at: ASSERTED_AT,
    lease_expires_at_at_assertion: currentLeaseExpiresAt,
    ...behavior.assertPatch,
  })
  const closePayload = (phase: unknown) => ({
    contract: SOURCE_JOB_EXECUTION_CONTRACT,
    source_id: harnessSourceId,
    generation_seq: 7,
    claim_id: CLAIM_ID,
    phase,
    closed_at: CLOSED_AT,
    ...behavior.closePatch,
  })

  const query = jest.fn(async (text: string, values?: readonly unknown[]) => {
    order.push(`query:${text.split('\n')[0]}`)
    if (behavior.queryFailure?.sql === text) throw behavior.queryFailure.error
    if (text === SOURCE_JOB_EXECUTION_CLAIM_SQL) {
      return queryResult('tier_a_execution_claim', claimPayload(), {
        command: behavior.claimCommand,
        outerExtra: behavior.claimOuterExtra,
        rowCount: behavior.claimRowCount,
      })
    }
    if (text === SOURCE_JOB_EXECUTION_HEARTBEAT_SQL) {
      const result = queryResult('tier_a_execution_heartbeat', heartbeatPayload())
      currentLeaseExpiresAt = HEARTBEAT_LEASE_EXPIRES_AT
      return result
    }
    if (text === SOURCE_JOB_EXECUTION_ASSERT_SQL) {
      if (behavior.assertGate !== undefined) await behavior.assertGate
      return queryResult('tier_a_execution_assertion', assertPayload())
    }
    if (text === SOURCE_JOB_EXECUTION_CLOSE_SQL) {
      return queryResult('tier_a_execution_close', closePayload(values?.[2]))
    }
    if (text === 'INSERT INTO arena.test_rows(value) VALUES ($1) RETURNING id') {
      return {
        command: 'INSERT',
        fields: [],
        oid: 0,
        rowCount: 1,
        rows: [{ id: 'saved' }],
      } satisfies QueryResult<QueryResultRow>
    }
    throw new Error(`unexpected test query: ${text}`)
  })
  const transaction: WorkerDbFencedWrite = Object.freeze({
    query: <R extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[]
    ): Promise<QueryResult<R>> => query(text, values) as Promise<QueryResult<R>>,
    signal: regionAbort.signal,
  })
  const withFencedWrite = jest.fn(
    async <T>(callback: (candidate: WorkerDbFencedWrite) => Promise<T>): Promise<T> => {
      order.push('region-write')
      try {
        const result = await callback(transaction)
        if (behavior.commitGate !== undefined) await behavior.commitGate
        return result
      } catch (error) {
        rollbackCount += 1
        throw error
      }
    }
  )
  const regionAuthority: RegionAuthorityFence = Object.freeze({
    proof: workerProof,
    signal: regionAbort.signal,
    state: 'active',
    isActive: jest.fn(() => regionActive),
    withFencedWrite,
  })
  const assertCanConsume = jest.fn(() => {
    order.push('admission')
    if (!regionActive) throw new Error('admission closed with private database detail')
  })
  const context: AuthorizedConsumedRegionContext = Object.freeze({
    consumedRegion: 'local',
    executionRegion,
    authority: regionAuthority,
    assertCanConsume,
  })

  let scheduledCallback: (() => void) | undefined
  const timer: SourceJobExecutionHeartbeatTimer = Object.freeze({
    cancel: jest.fn(),
    unref: jest.fn(),
  })
  const scheduleHeartbeat = jest.fn((callback: () => void, _intervalMs: number) => {
    scheduledCallback = callback
    return timer
  })

  return {
    behavior,
    bullAssertActive,
    bullExtendLock,
    context,
    get rollbackCount() {
      return rollbackCount
    },
    jobAbort,
    order,
    provenance,
    query,
    regionAbort,
    scheduleHeartbeat,
    sourceId: harnessSourceId,
    sourceAssertOwned,
    sourceRenew,
    timer,
    triggerTimer: () => scheduledCallback?.(),
    withFencedWrite,
    setRegionActive: (active: boolean) => {
      regionActive = active
    },
  }
}

async function claim(h: ReturnType<typeof harness>) {
  return claimSourceJobExecutionAuthority({
    claimId: CLAIM_ID,
    context: h.context,
    provenance: h.provenance,
    scheduleHeartbeat: h.scheduleHeartbeat,
    signal: h.jobAbort.signal,
    sourceId: h.sourceId,
  })
}

describe('Tier-A source job execution authority', () => {
  it('claims in Bull → source → region order with exact SQL, params, and frozen proof', async () => {
    const h = harness()
    const authority = await claim(h)

    expect(h.order.slice(0, 5)).toEqual([
      `bull:${SOURCE_JOB_EXECUTION_BULL_LOCK_MS}`,
      'source-renew',
      'admission',
      'region-write',
      'query:SELECT arena.claim_tier_a_execution(',
    ])
    expect(SOURCE_JOB_EXECUTION_CLAIM_SQL).toBe(`SELECT arena.claim_tier_a_execution(
    $1::uuid,
    $2::integer,
    $3::text,
    $4::text,
    $5::text,
    $6::integer,
    $7::integer,
    $8::text,
    $9::uuid,
    $10::text,
    $11::text,
    $12::integer
  ) AS tier_a_execution_claim`)
    expect(h.query.mock.calls[0]).toEqual([
      SOURCE_JOB_EXECUTION_CLAIM_SQL,
      [
        CLAIM_ID,
        SOURCE_ID,
        'arena:ingest:local',
        'repeat:tiera:binance_futures',
        INGEST_JOB.TIER_A,
        2,
        3,
        BULL_DIGEST,
        SOURCE_LEASE_ID,
        SOURCE_DIGEST,
        'local',
        SOURCE_JOB_EXECUTION_DB_LEASE_SECONDS,
      ],
    ])
    expect(Object.isFrozen(h.query.mock.calls[0]?.[1])).toBe(true)
    expect(Object.isFrozen(authority)).toBe(true)
    expect(Object.isFrozen(authority.proof)).toBe(true)
    expect(Object.keys(authority.proof)).toEqual([
      'contract',
      'sourceId',
      'generationSeq',
      'claimId',
      'bullProofContract',
      'queueName',
      'queueJobId',
      'queueJobName',
      'queueAttempt',
      'queueAttemptStarted',
      'bullLockTokenSha256',
      'sourceLeaseContract',
      'sourceLeaseId',
      'sourceLeaseLane',
      'sourceLeaseScopeId',
      'sourceLeaseTokenSha256',
      'executionRegion',
      'authorityScope',
      'authorityEpoch',
      'workerInstanceId',
      'workerNodeId',
      'workerRegion',
      'controlEpoch',
      'releaseId',
      'gitSha',
      'leaseSeconds',
      'phase',
      'claimedAt',
      'lastHeartbeatAt',
      'leaseExpiresAt',
    ])
    expect(authority.proof).toMatchObject({
      claimId: CLAIM_ID,
      contract: SOURCE_JOB_EXECUTION_CONTRACT,
      generationSeq: 7,
      queueJobName: INGEST_JOB.TIER_A,
      sourceId: SOURCE_ID,
      sourceLeaseLane: 'tier-a',
    })
    expect(h.scheduleHeartbeat).toHaveBeenCalledWith(
      expect.any(Function),
      SOURCE_JOB_EXECUTION_HEARTBEAT_MS
    )
    expect(h.timer.unref).toHaveBeenCalledTimes(1)

    const closeProof = await authority.close('completed')
    expect(Object.isFrozen(closeProof)).toBe(true)
    expect(Object.keys(closeProof)).toEqual([
      'contract',
      'sourceId',
      'generationSeq',
      'claimId',
      'phase',
      'closedAt',
    ])
    expect(closeProof.phase).toBe('completed')
  })

  it('fails closed before capabilities when required provenance or int4 source identity is absent', async () => {
    const missingLease = harness({ sourceLeaseMissing: true })
    await expect(claim(missingLease)).rejects.toMatchObject({
      code: 'invalid_input',
      operation: 'claim',
    })
    expect(missingLease.bullExtendLock).not.toHaveBeenCalled()

    const missingBullField = harness({ bullProofPatch: { queueName: null } })
    await expect(claim(missingBullField)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(missingBullField.bullExtendLock).not.toHaveBeenCalled()

    const wrongJob = harness({ bullProofPatch: { jobName: 'tierb:profiles' } })
    await expect(claim(wrongJob)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(wrongJob.bullExtendLock).not.toHaveBeenCalled()

    const invalidSource = harness()
    await expect(
      claimSourceJobExecutionAuthority({
        claimId: CLAIM_ID,
        context: invalidSource.context,
        provenance: invalidSource.provenance,
        scheduleHeartbeat: invalidSource.scheduleHeartbeat,
        sourceId: 32_768,
      })
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(invalidSource.bullExtendLock).not.toHaveBeenCalled()

    const mismatchedExecutionRegion = harness({ executionRegion: 'vps_sg' })
    await expect(claim(mismatchedExecutionRegion)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(mismatchedExecutionRegion.bullExtendLock).not.toHaveBeenCalled()

    const maximumSource = harness({ sourceId: 32_767 })
    const maximumSourceAuthority = await claim(maximumSource)
    expect(maximumSourceAuthority.proof.sourceId).toBe(32_767)
    await maximumSourceAuthority.close('completed')

    const maximumJobId = harness({ bullProofPatch: { jobId: 'j'.repeat(512) } })
    const maximumJobIdAuthority = await claim(maximumJobId)
    expect(maximumJobIdAuthority.proof.queueJobId).toHaveLength(512)
    await maximumJobIdAuthority.close('completed')

    const oversizedJobId = harness({ bullProofPatch: { jobId: 'j'.repeat(513) } })
    await expect(claim(oversizedJobId)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(oversizedJobId.bullExtendLock).not.toHaveBeenCalled()
  })

  it('sanitizes a pre-claim cancellation before any capability runs', async () => {
    const h = harness()
    const privateCancellation = new Error('cancelled with raw token and postgres://private')
    h.jobAbort.abort(privateCancellation)

    const failure = await claim(h).catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 'cancelled', operation: 'claim' })
    expect(failure).not.toHaveProperty('cause')
    expect(String((failure as Error).stack)).not.toContain(privateCancellation.message)
    expect(h.bullExtendLock).not.toHaveBeenCalled()
    expect(h.query).not.toHaveBeenCalled()
  })

  it.each([
    ['wrong command', (h: ReturnType<typeof harness>) => (h.behavior.claimCommand = 'UPDATE')],
    ['wrong rowCount', (h: ReturnType<typeof harness>) => (h.behavior.claimRowCount = 0)],
    ['extra envelope key', (h: ReturnType<typeof harness>) => (h.behavior.claimOuterExtra = true)],
    [
      'replayed different claim id',
      (h: ReturnType<typeof harness>) => (h.behavior.claimPatch.claim_id = OTHER_CLAIM_ID),
    ],
    [
      'extra payload key',
      (h: ReturnType<typeof harness>) => (h.behavior.claimPatch.unexpected = true),
    ],
    [
      'unsafe generation',
      (h: ReturnType<typeof harness>) =>
        (h.behavior.claimPatch.generation_seq = Number.MAX_SAFE_INTEGER),
    ],
  ])('rejects a claim RPC with %s', async (_label, mutate) => {
    const h = harness()
    mutate(h)

    await expect(claim(h)).rejects.toMatchObject({
      code: 'rpc_contract_violation',
      operation: 'claim',
    })
    expect(h.scheduleHeartbeat).not.toHaveBeenCalled()
  })

  it('accepts an idempotent claim replay only when every echoed identity is exact', async () => {
    const first = harness()
    const firstAuthority = await claim(first)
    await firstAuthority.close('completed')

    const replay = harness()
    const replayedAuthority = await claim(replay)
    expect(replayedAuthority.proof.claimId).toBe(CLAIM_ID)
    expect(replayedAuthority.proof.generationSeq).toBe(7)
    await replayedAuthority.close('completed')
  })

  it('runs a single-flight heartbeat in Bull → source → DB CAS order', async () => {
    const h = harness()
    const authority = await claim(h)
    const gate = deferred<void>()
    h.bullExtendLock.mockImplementationOnce(async (durationMs: number) => {
      h.order.push(`bull:${durationMs}`)
      await gate.promise
    })

    const first = authority.heartbeat()
    const second = authority.heartbeat()
    h.triggerTimer()

    expect(second).toBe(first)
    expect(h.bullExtendLock).toHaveBeenCalledTimes(2)
    expect(h.sourceRenew).toHaveBeenCalledTimes(1)
    gate.resolve()

    const heartbeatProof = await first
    expect(Object.isFrozen(heartbeatProof)).toBe(true)
    expect(Object.keys(heartbeatProof)).toEqual([
      'contract',
      'sourceId',
      'generationSeq',
      'claimId',
      'phase',
      'lastHeartbeatAt',
      'leaseExpiresAt',
    ])
    expect(h.sourceRenew).toHaveBeenCalledTimes(2)
    const heartbeatQueryIndex = h.order.indexOf('query:SELECT arena.heartbeat_tier_a_execution(')
    expect(heartbeatQueryIndex).toBeGreaterThan(h.order.lastIndexOf('source-renew'))
    expect(h.query).toHaveBeenCalledWith(SOURCE_JOB_EXECUTION_HEARTBEAT_SQL, [CLAIM_ID, '7'])
    expect(Object.isFrozen(h.query.mock.calls[1]?.[1])).toBe(true)

    await authority.close('completed')
  })

  it('aborts and stops the timer when Bull ownership is lost without leaking its error', async () => {
    const h = harness()
    const authority = await claim(h)
    const privateFailure = new Error('Bull failed with raw lock token and redis://secret')
    h.bullExtendLock.mockRejectedValueOnce(privateFailure)
    ;(h.timer.cancel as jest.Mock).mockImplementation(() => {
      throw new Error('timer adapter exposed another private token')
    })

    const failure = await authority.heartbeat().catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 'ownership_lost', operation: 'heartbeat' })
    expect(failure).not.toHaveProperty('cause')
    expect(String((failure as Error).stack)).not.toContain(privateFailure.message)
    expect(authority.signal.aborted).toBe(true)
    expect(h.sourceRenew).toHaveBeenCalledTimes(1)
    expect(h.timer.cancel).toHaveBeenCalled()
    h.triggerTimer()
    expect(h.bullExtendLock).toHaveBeenCalledTimes(2)

    const close = await authority.close('completed')
    expect(close.phase).toBe('revoked')
    expect(h.query).toHaveBeenLastCalledWith(SOURCE_JOB_EXECUTION_CLOSE_SQL, [
      CLAIM_ID,
      '7',
      'revoked',
    ])
  })

  it('aborts before DB heartbeat when source ownership is lost', async () => {
    const h = harness()
    const authority = await claim(h)
    h.sourceRenew.mockRejectedValueOnce(new Error('source owner token leaked by driver'))

    await expect(authority.heartbeat()).rejects.toMatchObject({ code: 'ownership_lost' })
    expect(h.query.mock.calls.some(([sql]) => sql === SOURCE_JOB_EXECUTION_HEARTBEAT_SQL)).toBe(
      false
    )
    expect(h.timer.cancel).toHaveBeenCalled()
    await authority.close('revoked')
  })

  it('aborts on a malformed DB heartbeat CAS result', async () => {
    const h = harness()
    const authority = await claim(h)
    h.behavior.heartbeatPatch.phase = 'completed'

    await expect(authority.heartbeat()).rejects.toMatchObject({
      code: 'rpc_contract_violation',
      operation: 'heartbeat',
    })
    expect(authority.signal.aborted).toBe(true)
    expect(h.timer.cancel).toHaveBeenCalled()
    await authority.close('revoked')
  })

  it('asserts the execution inside the same fenced transaction before one branded callback', async () => {
    const h = harness()
    const authority = await claim(h)
    let retainedWrite: TierAExecutionClaimedWrite | undefined
    const callback = jest.fn(async (write: TierAExecutionClaimedWrite) => {
      retainedWrite = write
      expect(Object.isFrozen(write)).toBe(true)
      expect(() => assertTierAExecutionClaimedWrite(write)).not.toThrow()
      return (
        await write.query('INSERT INTO arena.test_rows(value) VALUES ($1) RETURNING id', ['value'])
      ).rows[0]?.id
    })

    await expect(authority.withClaimedWrite(callback)).resolves.toBe('saved')

    expect(callback).toHaveBeenCalledTimes(1)
    expect(h.withFencedWrite).toHaveBeenCalledTimes(2)
    expect(h.query.mock.calls.slice(1).map(([sql]) => sql)).toEqual([
      SOURCE_JOB_EXECUTION_ASSERT_SQL,
      'INSERT INTO arena.test_rows(value) VALUES ($1) RETURNING id',
    ])
    expect(h.query.mock.calls[1]).toEqual([SOURCE_JOB_EXECUTION_ASSERT_SQL, [CLAIM_ID, '7']])
    expect(() => assertTierAExecutionClaimedWrite(retainedWrite)).toThrow(
      'Tier-A execution write failed (invalid_input)'
    )
    expect(() => assertTierAExecutionClaimedWrite(Object.freeze({ query: jest.fn() }))).toThrow(
      'Tier-A execution write failed (invalid_input)'
    )

    await authority.close('completed')
  })

  it('preserves a business callback failure after the fenced transaction rolls back', async () => {
    const h = harness()
    const authority = await claim(h)
    const businessFailure = new Error('business validation failed')
    const callback = jest.fn(async () => Promise.reject(businessFailure))

    await expect(authority.withClaimedWrite(callback)).rejects.toBe(businessFailure)

    expect(callback).toHaveBeenCalledTimes(1)
    expect(h.rollbackCount).toBe(1)
    expect(authority.signal.aborted).toBe(false)
    expect(() => authority.assertActive()).not.toThrow()
    await authority.close('failed')
  })

  it('accepts a concurrent heartbeat lease advance while a write assertion is in flight', async () => {
    const h = harness()
    const authority = await claim(h)
    const assertionGate = deferred<void>()
    h.behavior.assertGate = assertionGate.promise
    const callback = jest.fn(async () => 'written')

    const write = authority.withClaimedWrite(callback)
    await Promise.resolve()
    expect(h.query.mock.calls.some(([sql]) => sql === SOURCE_JOB_EXECUTION_ASSERT_SQL)).toBe(true)

    await authority.heartbeat()
    assertionGate.resolve()

    await expect(write).resolves.toBe('written')
    expect(callback).toHaveBeenCalledTimes(1)
    expect(authority.signal.aborted).toBe(false)
    await authority.close('completed')
  })

  it('never invokes the callback when the in-transaction execution assertion is malformed', async () => {
    const h = harness()
    const authority = await claim(h)
    h.behavior.assertPatch.unexpected = true
    const callback = jest.fn(async () => 'must-not-run')

    await expect(authority.withClaimedWrite(callback)).rejects.toMatchObject({
      code: 'rpc_contract_violation',
      operation: 'assert',
    })
    expect(callback).not.toHaveBeenCalled()
    expect(h.rollbackCount).toBe(1)
    expect(authority.signal.aborted).toBe(true)
    await authority.close('revoked')
  })

  it('waits one in-flight heartbeat before a memoized close and never restarts', async () => {
    const h = harness()
    const authority = await claim(h)
    const gate = deferred<void>()
    h.bullExtendLock.mockImplementationOnce(async (durationMs: number) => {
      h.order.push(`bull:${durationMs}`)
      await gate.promise
    })
    const heartbeat = authority.heartbeat()
    const firstClose = authority.close('completed')
    const secondClose = authority.close('completed')

    expect(secondClose).toBe(firstClose)
    expect(h.timer.cancel).toHaveBeenCalled()
    expect(h.query.mock.calls.some(([sql]) => sql === SOURCE_JOB_EXECUTION_CLOSE_SQL)).toBe(false)
    gate.resolve()

    await heartbeat
    await expect(firstClose).resolves.toMatchObject({ phase: 'completed' })
    const heartbeatIndex = h.query.mock.calls.findIndex(
      ([sql]) => sql === SOURCE_JOB_EXECUTION_HEARTBEAT_SQL
    )
    const closeIndex = h.query.mock.calls.findIndex(
      ([sql]) => sql === SOURCE_JOB_EXECUTION_CLOSE_SQL
    )
    expect(closeIndex).toBeGreaterThan(heartbeatIndex)
    await expect(authority.close('failed')).rejects.toMatchObject({ code: 'closed' })
    await expect(authority.heartbeat()).rejects.toMatchObject({ code: 'closed' })
  })

  it('blocks new writes and waits an in-flight claimed write before DB close', async () => {
    const h = harness()
    const authority = await claim(h)
    const callbackStarted = deferred<void>()
    const finishCallback = deferred<void>()
    const callback = jest.fn(async () => {
      callbackStarted.resolve()
      await finishCallback.promise
      return 'committed'
    })
    const write = authority.withClaimedWrite(callback)
    await callbackStarted.promise

    const close = authority.close('completed')
    await Promise.resolve()
    expect(h.query.mock.calls.some(([sql]) => sql === SOURCE_JOB_EXECUTION_CLOSE_SQL)).toBe(false)
    await expect(authority.withClaimedWrite(async () => 'late')).rejects.toMatchObject({
      code: 'closed',
    })

    finishCallback.resolve()
    await expect(write).resolves.toBe('committed')
    await expect(close).resolves.toMatchObject({ phase: 'completed' })
    expect(h.query).toHaveBeenLastCalledWith(SOURCE_JOB_EXECUTION_CLOSE_SQL, [
      CLAIM_ID,
      '7',
      'completed',
    ])
  })

  it('waits a claimed write COMMIT barrier before DB close', async () => {
    const h = harness()
    const authority = await claim(h)
    const commitGate = deferred<void>()
    h.behavior.commitGate = commitGate.promise
    const callback = jest.fn(async () => 'ready-to-commit')
    const write = authority.withClaimedWrite(callback)
    await Promise.resolve()
    await Promise.resolve()
    expect(callback).toHaveBeenCalledTimes(1)

    const close = authority.close('completed')
    await Promise.resolve()
    expect(h.query.mock.calls.some(([sql]) => sql === SOURCE_JOB_EXECUTION_CLOSE_SQL)).toBe(false)

    commitGate.resolve()
    await expect(write).resolves.toBe('ready-to-commit')
    await expect(close).resolves.toMatchObject({ phase: 'completed' })
  })

  it('fails closed on region loss and does not attempt a DB close on a dead fence', async () => {
    const h = harness()
    const authority = await claim(h)
    h.setRegionActive(false)
    h.regionAbort.abort(new Error('database connection string must stay private'))

    await expect(authority.heartbeat()).rejects.toMatchObject({ code: 'region_lost' })
    const queriesBeforeClose = h.query.mock.calls.length
    await expect(authority.close('revoked')).rejects.toMatchObject({ code: 'region_lost' })
    expect(h.query).toHaveBeenCalledTimes(queriesBeforeClose)
  })

  it('logs only the class and code of a failure it reports under a fixed code', async () => {
    const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const h = harness()
      const authority = await claim(h)
      h.behavior.queryFailure = {
        error: Object.assign(
          new Error('lease expired for postgres://user:secret@db.internal/arena SELECT secret_sql'),
          { code: '57014' }
        ),
        sql: SOURCE_JOB_EXECUTION_ASSERT_SQL,
      }
      await expect(authority.withClaimedWrite(async () => undefined)).rejects.toMatchObject({
        code: 'region_lost',
        operation: 'assert',
      })
      expect(logged).toHaveBeenCalledTimes(1)
      expect(logged).toHaveBeenCalledWith(
        '[ingest-worker] Tier-A execution assert region_lost cause: Error code=57014'
      )
    } finally {
      logged.mockRestore()
    }
  })

  it('logs a fence error with its code and operation, and the code of the error it wraps', async () => {
    const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const h = harness()
      const authority = await claim(h)
      const driverError = Object.assign(new Error('read ECONNRESET 10.0.0.7:6543'), {
        code: 'ECONNRESET',
      })
      const fenceError = Object.assign(
        new Error('[ingest-worker] worker database fence write failed'),
        {
          name: 'WorkerDbFenceError',
          code: 'write_deadline_exceeded',
          operation: 'write',
          retryPolicy: 'never',
          cause: driverError,
        }
      )
      h.behavior.queryFailure = { error: fenceError, sql: SOURCE_JOB_EXECUTION_ASSERT_SQL }
      await expect(authority.withClaimedWrite(async () => undefined)).rejects.toMatchObject({
        code: 'region_lost',
      })
      expect(logged).toHaveBeenCalledWith(
        '[ingest-worker] Tier-A execution assert region_lost cause: ' +
          'WorkerDbFenceError code=write_deadline_exceeded operation=write retry=never' +
          ' <- Error code=ECONNRESET'
      )
    } finally {
      logged.mockRestore()
    }
  })

  it('sanitizes a claim query failure containing SQL and connection secrets', async () => {
    const h = harness()
    const raw = new Error(
      `connection postgres://private failed while running ${SOURCE_JOB_EXECUTION_CLAIM_SQL}`
    )
    h.behavior.queryFailure = { error: raw, sql: SOURCE_JOB_EXECUTION_CLAIM_SQL }

    const failure = await claim(h).catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 'unavailable', operation: 'claim' })
    expect(failure).not.toHaveProperty('cause')
    expect(String((failure as Error).stack)).not.toContain('postgres://private')
    expect(h.scheduleHeartbeat).not.toHaveBeenCalled()
  })
})
