import '../../adapters/register'

const mockWithVerifiedCopierSnapshotTrustRawArtifactV2 = jest.fn()

jest.mock('../../raw', () => ({
  withVerifiedCopierSnapshotTrustRawArtifactV2: (...args: unknown[]) =>
    mockWithVerifiedCopierSnapshotTrustRawArtifactV2(...args),
}))

import { getAdapter } from '../../core/adapter'
import type { ParsedHistoryRow, RawPage, SourceRow } from '../../core/types'
import type { IngestQueryExecutor } from '../../db'
import {
  buildCopierSnapshotArtifact,
  copierSnapshotSourceRunId,
  type CopierSnapshotArtifact,
} from '../../copier-snapshot-artifact'
import {
  buildCopierSnapshotArtifactV2,
  type CopierSnapshotArtifactAnchor,
  type CopierSnapshotArtifactV2Result,
} from '../../copier-snapshot-artifact-v2'
import {
  buildCopierCandidateLedger,
  verifyCopierParserConservation,
} from '../../copier-candidate-conservation'
import type {
  IngestTransactionRunner,
  LockedVerifiedCopierSnapshotTrustRawArtifactV2,
  ReadVerifiedCopierSnapshotTrustRawArtifactV2Input,
} from '../../raw'
import { strictCanonicalJson } from '../../strict-canonical-json'
import { publishCopierSnapshotTrustV2 } from '../copier-snapshot-publish-v2'

const candidate = {
  uid: 'private-candidate-a',
  nickName: 'private-name-a',
  followingProfitLoss: '1.25',
  copyAmount: '10',
  followingDays: 2,
}

function source(copierTableDepth: 'full' | 'top10' = 'full'): SourceRow {
  return {
    id: 34,
    slug: 'bingx_futures',
    exchange_id: 3,
    product_type: 'futures',
    trader_kind_scope: 'human',
    adapter_slug: 'bingx',
    leaderboard_url: 'https://example.test/leaderboard',
    timeframes_native: [7, 30, 90],
    timeframes_derived: [],
    tf_label_map: {},
    expected_count: null,
    deep_profile_topn: 20,
    positions_topn: 20,
    profile_cache_ttl: '15 minutes',
    copier_table_depth: copierTableDepth,
    currency: 'USDT',
    page_size: 20,
    pagination_kind: 'numeric',
    cadence_tier_a: '15 minutes',
    cadence_tier_b: '1 hour',
    cadence_tier_d: '5 minutes',
    fetch_region: 'local',
    rate_budget_ms: 250,
    phase: 1,
    serving_mode: 'serving',
    status: 'active',
    meta: {},
  }
}

function page(candidates: readonly Record<string, unknown>[]): RawPage {
  return {
    pageIndex: 1,
    payload: { code: 0, data: { followerDetailsVoList: candidates } },
    url: 'https://example.test/copiers?page=1',
    fetchedAt: '2026-08-08T12:00:01.000Z',
  }
}

function snapshotAnchor(snapshot: CopierSnapshotArtifact): CopierSnapshotArtifactAnchor {
  return {
    sourceRunId: copierSnapshotSourceRunId(snapshot),
    sourceId: snapshot.source.id,
    sourceSlug: snapshot.source.slug,
    traderId: snapshot.trader.id,
    exchangeTraderId: snapshot.trader.exchange_trader_id,
  }
}

function artifactFixture(
  options: {
    readonly empty?: boolean
    readonly lane?: 'tier_b' | 'tier_c'
    readonly callerLimited?: boolean
    readonly copierTableDepth?: 'full' | 'top10'
  } = {}
): CopierSnapshotArtifactV2Result {
  const src = source(options.copierTableDepth)
  const lane = options.lane ?? 'tier_c'
  const snapshot = buildCopierSnapshotArtifact({
    src,
    traderId: 101,
    exchangeTraderId: 'private-exchange-trader-101',
    lane,
    requestTimeframe: lane === 'tier_b' ? null : 0,
    pages: [page(options.empty ? [] : [candidate])],
    callerLimited: options.callerLimited ?? false,
  })
  const candidateLedger = buildCopierCandidateLedger({
    src,
    exchangeTraderId: snapshot.trader.exchange_trader_id,
    pages: snapshot.pages,
  })
  const rows: ParsedHistoryRow[] = snapshot.pages.flatMap((capturedPage) =>
    getAdapter(src.adapter_slug).parseHistory(capturedPage.payload, 'copiers', {
      sourceSlug: snapshot.source.slug,
      currency: snapshot.source.currency,
      tfLabelMap: {},
      scrapedAt: snapshot.observed_at,
      meta: {},
    })
  )
  const parserProof = verifyCopierParserConservation({ ledger: candidateLedger, rows })
  return buildCopierSnapshotArtifactV2({
    src,
    snapshot,
    expectedSnapshot: snapshotAnchor(snapshot),
    candidateLedger,
    parserProof,
    rows,
  })
}

function lockedEvidence(
  built: CopierSnapshotArtifactV2Result,
  rawObjectId = 8001
): LockedVerifiedCopierSnapshotTrustRawArtifactV2 {
  const artifact = built.artifact
  return Object.freeze({
    contract: artifact.contract,
    trustScope: 'raw_candidate_parser_projection_binding' as const,
    pointerSnapshot: Object.freeze({
      rawObjectId,
      sourceRunId: built.sourceRunId,
      storagePath:
        `${artifact.snapshot.source.slug}/copier_snapshot_trust/${artifact.snapshot.lane}/` +
        `${built.sourceRunId}/copier_snapshot_trust_${built.sourceRunId}.json.gz`,
      observedAt: artifact.snapshot.observed_at,
    }),
    snapshotSourceRunId: artifact.snapshot_source_run_id,
    candidateLedgerSha256: artifact.candidate_ledger_sha256,
    parserConservationSha256: artifact.parser_conservation_sha256,
    projectionLedgerSha256: artifact.projection_ledger_sha256,
    artifact,
  })
}

function readInput(
  built: CopierSnapshotArtifactV2Result,
  rawObjectId = 8001
): ReadVerifiedCopierSnapshotTrustRawArtifactV2Input {
  const artifact = built.artifact
  return {
    rawObjectId,
    expectedSourceId: artifact.snapshot.source.id,
    expectedSourceSlug: artifact.snapshot.source.slug,
    expectedTraderId: artifact.snapshot.trader.id,
    expectedExchangeTraderId: artifact.snapshot.trader.exchange_trader_id,
    expectedLane: artifact.snapshot.lane,
    expectedSourceRunId: built.sourceRunId,
    expectedSnapshotSourceRunId: artifact.snapshot_source_run_id,
    expectedCandidateLedgerSha256: artifact.candidate_ledger_sha256,
    expectedParserConservationSha256: artifact.parser_conservation_sha256,
    expectedProjectionLedgerSha256: artifact.projection_ledger_sha256,
  }
}

function storedReceipt(
  evidence: LockedVerifiedCopierSnapshotTrustRawArtifactV2,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const artifact = evidence.artifact
  const snapshot = artifact.snapshot
  return {
    publication_id: 9001,
    published_at: '2026-08-08T12:00:02.000000Z',
    source_id: snapshot.source.id,
    trader_id: snapshot.trader.id,
    lane: snapshot.lane,
    raw_object_id_at_publication: evidence.pointerSnapshot.rawObjectId,
    outer_source_run_id: evidence.pointerSnapshot.sourceRunId,
    observed_at: '2026-08-08T12:00:01.000000Z',
    snapshot_source_run_id: evidence.snapshotSourceRunId,
    candidate_ledger_sha256: evidence.candidateLedgerSha256,
    parser_conservation_sha256: evidence.parserConservationSha256,
    projection_ledger_sha256: evidence.projectionLedgerSha256,
    parsed_row_count: artifact.projection_ledger.row_count,
    coverage_state:
      snapshot.caller_limited || snapshot.source.copier_table_depth !== 'full'
        ? 'partial'
        : 'unknown',
    rank_eligible: false,
    replayed: false,
    is_current_head: true,
    ...overrides,
  }
}

function harness(
  evidence: LockedVerifiedCopierSnapshotTrustRawArtifactV2,
  options: {
    readonly rows?: readonly Record<string, unknown>[]
    readonly queryError?: Error
  } = {}
) {
  const query = jest.fn(async () => {
    if (options.queryError) throw options.queryError
    const rows = options.rows ?? [storedReceipt(evidence)]
    return { rows, rowCount: rows.length }
  })
  const transaction = { query } as IngestQueryExecutor
  const runTransaction = jest.fn(
    async <T>(operation: (executor: IngestQueryExecutor) => Promise<T>): Promise<T> =>
      operation(transaction)
  ) as IngestTransactionRunner
  mockWithVerifiedCopierSnapshotTrustRawArtifactV2.mockImplementation(
    async (
      _input: ReadVerifiedCopierSnapshotTrustRawArtifactV2Input,
      runner: IngestTransactionRunner,
      consume: (
        executor: IngestQueryExecutor,
        value: LockedVerifiedCopierSnapshotTrustRawArtifactV2
      ) => Promise<unknown>
    ) => runner((executor) => consume(executor, evidence))
  )
  return { query, runTransaction, transaction }
}

describe('copier snapshot trust v2 publisher', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('publishes only four exact canonical children through the locked reader transaction', async () => {
    const built = artifactFixture()
    const evidence = lockedEvidence(built)
    const input = readInput(built)
    const { query, runTransaction, transaction } = harness(evidence)

    const result = await publishCopierSnapshotTrustV2(input, runTransaction)

    expect(mockWithVerifiedCopierSnapshotTrustRawArtifactV2).toHaveBeenCalledTimes(1)
    expect(mockWithVerifiedCopierSnapshotTrustRawArtifactV2.mock.calls[0][0]).toBe(input)
    expect(mockWithVerifiedCopierSnapshotTrustRawArtifactV2.mock.calls[0][1]).toBe(runTransaction)
    expect(runTransaction).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledTimes(1)
    const [sql, values] = query.mock.calls[0]
    const statement = String(sql)
    expect(statement).toContain('FROM arena.publish_copier_snapshot_trust_v2(')
    expect(statement.match(/AT TIME ZONE 'UTC'/g)).toHaveLength(2)
    expect(statement.match(/'YYYY-MM-DD"T"HH24:MI:SS\.US"Z"'/g)).toHaveLength(2)
    expect(statement).not.toMatch(/(?:published_at|observed_at)::text/)
    expect(statement).not.toMatch(/\b(?:BEGIN|COMMIT|ROLLBACK)\b/)
    expect(statement).not.toContain('::jsonb')
    expect(statement).not.toContain('$10')
    expect(statement.match(/\$[1-9]::(?:bigint|smallint|text)/g)).toEqual([
      '$1::bigint',
      '$2::smallint',
      '$3::bigint',
      '$4::text',
      '$5::text',
      '$6::text',
      '$7::text',
      '$8::text',
      '$9::text',
    ])
    expect(values).toEqual([
      evidence.pointerSnapshot.rawObjectId,
      evidence.artifact.snapshot.source.id,
      evidence.artifact.snapshot.trader.id,
      evidence.artifact.snapshot.lane,
      evidence.pointerSnapshot.sourceRunId,
      strictCanonicalJson(evidence.artifact.snapshot),
      strictCanonicalJson(evidence.artifact.candidate_ledger),
      strictCanonicalJson(evidence.artifact.parser_conservation),
      strictCanonicalJson(evidence.artifact.projection_ledger),
    ])
    expect(values).toHaveLength(9)
    expect(values).not.toContain(evidence.pointerSnapshot.storagePath)
    expect(values).not.toContain('partial')
    expect(values).not.toContain('unknown')
    expect(values).not.toContain(false)
    expect(transaction.query).toBe(query)

    expect(result).toEqual({
      publicationId: 9001,
      publishedAt: '2026-08-08T12:00:02.000000Z',
      sourceId: 34,
      traderId: 101,
      lane: 'tier_c',
      rawObjectIdAtPublication: 8001,
      outerSourceRunId: built.sourceRunId,
      observedAt: '2026-08-08T12:00:01.000000Z',
      snapshotSourceRunId: built.artifact.snapshot_source_run_id,
      candidateLedgerSha256: built.artifact.candidate_ledger_sha256,
      parserConservationSha256: built.artifact.parser_conservation_sha256,
      projectionLedgerSha256: built.artifact.projection_ledger_sha256,
      parsedRowCount: 1,
      coverageState: 'unknown',
      rankEligible: false,
      replayed: false,
      isCurrentHead: true,
    })
    expect(Object.isFrozen(result)).toBe(true)
  })

  it('passes a hostile input envelope untouched to the reader', async () => {
    const built = artifactFixture()
    const evidence = lockedEvidence(built)
    const { runTransaction } = harness(evidence)
    const target = readInput(built)
    const hostile = new Proxy(target, {
      get() {
        throw new Error('wrapper touched input')
      },
      ownKeys() {
        throw new Error('wrapper enumerated input')
      },
    })

    await expect(publishCopierSnapshotTrustV2(hostile, runTransaction)).resolves.toMatchObject({
      publicationId: 9001,
    })
    expect(mockWithVerifiedCopierSnapshotTrustRawArtifactV2.mock.calls[0][0]).toBe(hostile)
  })

  it.each([
    ['empty full-depth evidence', { empty: true } as const, 'unknown'],
    ['caller-limited evidence', { callerLimited: true } as const, 'partial'],
    ['source-limited evidence', { copierTableDepth: 'top10' } as const, 'partial'],
  ])('keeps %s non-ranking with the exact coverage state', async (_label, options, coverage) => {
    const built = artifactFixture(options)
    const evidence = lockedEvidence(built)
    const { runTransaction } = harness(evidence, {
      rows: [storedReceipt(evidence, { parsed_row_count: options.empty ? 0 : 1 })],
    })

    await expect(
      publishCopierSnapshotTrustV2(readInput(built), runTransaction)
    ).resolves.toMatchObject({
      parsedRowCount: options.empty ? 0 : 1,
      coverageState: coverage,
      rankEligible: false,
    })
  })

  it('accepts an old exact replay without pretending it is the current lane head', async () => {
    const built = artifactFixture()
    const evidence = lockedEvidence(built)
    const { runTransaction } = harness(evidence, {
      rows: [storedReceipt(evidence, { replayed: true, is_current_head: false })],
    })

    await expect(
      publishCopierSnapshotTrustV2(readInput(built), runTransaction)
    ).resolves.toMatchObject({
      replayed: true,
      isCurrentHead: false,
    })
  })

  it('rejects a newly inserted publication that is not the current lane head', async () => {
    const built = artifactFixture()
    const evidence = lockedEvidence(built)
    const { runTransaction } = harness(evidence, {
      rows: [storedReceipt(evidence, { replayed: false, is_current_head: false })],
    })

    await expect(publishCopierSnapshotTrustV2(readInput(built), runTransaction)).rejects.toThrow(
      'new database publication must be the current lane head'
    )
  })

  it.each([0, 2])('rejects a database result with %i receipt rows', async (rowCount) => {
    const built = artifactFixture()
    const evidence = lockedEvidence(built)
    const rows = Array.from({ length: rowCount }, () => storedReceipt(evidence))
    const { runTransaction } = harness(evidence, { rows })

    await expect(publishCopierSnapshotTrustV2(readInput(built), runTransaction)).rejects.toThrow(
      `database returned ${rowCount} publication receipts`
    )
  })

  it('independently requires candidate, proof, and projection counts to agree', async () => {
    const built = artifactFixture()
    const evidence = lockedEvidence(built)
    const inconsistentEvidence: LockedVerifiedCopierSnapshotTrustRawArtifactV2 = Object.freeze({
      ...evidence,
      artifact: Object.freeze({
        ...evidence.artifact,
        projection_ledger: Object.freeze({
          ...evidence.artifact.projection_ledger,
          row_count: evidence.artifact.projection_ledger.row_count + 1,
        }),
      }),
    })
    const { query, runTransaction } = harness(inconsistentEvidence)

    await expect(publishCopierSnapshotTrustV2(readInput(built), runTransaction)).rejects.toThrow(
      'locked evidence row counts are not conserved'
    )
    expect(query).not.toHaveBeenCalled()
  })

  it.each([
    ['publication id', { publication_id: '9001' }, 'publication id'],
    ['publication clock', { published_at: 'not-an-instant' }, 'publication clock'],
    ['publication clock shape', { published_at: '2026-08-08 12:00:02+00' }, 'publication clock'],
    [
      'publication clock calendar',
      { published_at: '2026-02-31T12:00:02.000000Z' },
      'publication clock',
    ],
    ['source id', { source_id: 35 }, 'source or trader identity'],
    ['trader id', { trader_id: 102 }, 'source or trader identity'],
    ['lane', { lane: 'tier_b' }, 'lane'],
    ['RAW id', { raw_object_id_at_publication: '8001' }, 'RAW identity'],
    ['outer hash type', { outer_source_run_id: 1 }, 'outer source-run id'],
    ['outer hash value', { outer_source_run_id: 'f'.repeat(64) }, 'outer source-run id'],
    ['observed clock', { observed_at: '2026-08-08T12:00:02.000000Z' }, 'observation clock'],
    ['observed clock shape', { observed_at: '2026-08-08 12:00:01+00' }, 'observation clock'],
    [
      'observed clock microsecond drift',
      { observed_at: '2026-08-08T12:00:01.000999Z' },
      'observation clock',
    ],
    ['snapshot hash', { snapshot_source_run_id: 'f'.repeat(64) }, 'child evidence anchors'],
    ['candidate hash', { candidate_ledger_sha256: 'f'.repeat(64) }, 'child evidence anchors'],
    ['parser hash', { parser_conservation_sha256: 'f'.repeat(64) }, 'child evidence anchors'],
    ['projection hash', { projection_ledger_sha256: 'f'.repeat(64) }, 'child evidence anchors'],
    ['row count type', { parsed_row_count: '1' }, 'parsed row count'],
    ['row count value', { parsed_row_count: 2 }, 'parsed row count'],
    ['coverage type', { coverage_state: false }, 'coverage state'],
    ['coverage value', { coverage_state: 'complete' }, 'coverage state'],
    ['wrong allowed coverage', { coverage_state: 'partial' }, 'coverage state'],
    ['rank boolean', { rank_eligible: 'false' }, 'must remain non-ranking'],
    ['rank true', { rank_eligible: true }, 'must remain non-ranking'],
    ['replay boolean', { replayed: 'false' }, 'replay or head flag'],
    ['head boolean', { is_current_head: 'true' }, 'replay or head flag'],
  ])('rejects a database receipt with invalid %s', async (_label, override, message) => {
    const built = artifactFixture()
    const evidence = lockedEvidence(built)
    const { runTransaction } = harness(evidence, {
      rows: [storedReceipt(evidence, override)],
    })

    await expect(publishCopierSnapshotTrustV2(readInput(built), runTransaction)).rejects.toThrow(
      message
    )
  })

  it('propagates the SQL error unchanged through the reader transaction', async () => {
    const built = artifactFixture()
    const evidence = lockedEvidence(built)
    const databaseError = new Error('publisher SQL rejected live authority')
    const { runTransaction } = harness(evidence, { queryError: databaseError })

    await expect(publishCopierSnapshotTrustV2(readInput(built), runTransaction)).rejects.toBe(
      databaseError
    )
  })

  it('propagates a locked-reader failure without opening a transaction or querying', async () => {
    const built = artifactFixture()
    const evidence = lockedEvidence(built)
    const { query, runTransaction } = harness(evidence)
    const readerError = new Error('locked reader rejected evidence')
    mockWithVerifiedCopierSnapshotTrustRawArtifactV2.mockRejectedValueOnce(readerError)

    await expect(publishCopierSnapshotTrustV2(readInput(built), runTransaction)).rejects.toBe(
      readerError
    )
    expect(runTransaction).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  })
})
