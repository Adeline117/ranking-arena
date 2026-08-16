import '../adapters/register'

import { getAdapter } from '../core/adapter'
import type { ParsedHistoryRow, RawPage, SourceRow } from '../core/types'
import {
  buildCopierSnapshotArtifact,
  copierSnapshotSourceRunId,
  type CopierSnapshotArtifact,
} from '../copier-snapshot-artifact'
import {
  COPIER_SNAPSHOT_ARTIFACT_V2_CONTRACT,
  buildCopierSnapshotArtifactV2,
  revalidateCopierSnapshotArtifactV2,
  type CopierSnapshotArtifactAnchor,
  type CopierSnapshotArtifactV2Result,
} from '../copier-snapshot-artifact-v2'
import {
  buildCopierCandidateLedger,
  verifyCopierParserConservation,
  type CopierCandidateLedger,
  type CopierParserConservationProof,
} from '../copier-candidate-conservation'
import {
  copierSnapshotCandidateProjectionFixedMultisetSha256,
  copierSnapshotProjectionSha256,
} from '../copier-snapshot-projection'
import {
  STRICT_CANONICAL_JSON_CONTRACT,
  strictCanonicalJson,
  strictCanonicalSha256,
} from '../strict-canonical-json'

type Candidate = Record<string, unknown>
type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T

interface Evidence {
  src: SourceRow
  snapshot: CopierSnapshotArtifact
  expectedSnapshot: CopierSnapshotArtifactAnchor
  candidateLedger: CopierCandidateLedger
  parserProof: CopierParserConservationProof
  rows: ParsedHistoryRow[]
}

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: 7,
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
    copier_table_depth: 'full',
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
    ...overrides,
  }
}

function page(candidates: Candidate[], pageIndex: number, minute = 0): RawPage {
  return {
    pageIndex,
    payload: { code: 0, data: { followerDetailsVoList: candidates } },
    url: `https://example.test/copiers?page=${pageIndex}`,
    fetchedAt: `2026-08-08T12:${String(minute).padStart(2, '0')}:${String(pageIndex).padStart(2, '0')}.000Z`,
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

function evidence(
  candidatesByPage: Candidate[][],
  options: {
    src?: SourceRow
    callerLimited?: boolean
    traderId?: number
    exchangeTraderId?: string
    minute?: number
  } = {}
): Evidence {
  const src = options.src ?? source()
  const pages = candidatesByPage.map((candidates, index) =>
    page(candidates, index + 1, options.minute)
  )
  const snapshot = buildCopierSnapshotArtifact({
    src,
    traderId: options.traderId ?? 91,
    exchangeTraderId: options.exchangeTraderId ?? 'trader-91',
    lane: 'tier_c',
    requestTimeframe: 0,
    pages,
    callerLimited: options.callerLimited ?? false,
  })
  const candidateLedger = buildCopierCandidateLedger({
    src,
    exchangeTraderId: snapshot.trader.exchange_trader_id,
    pages: snapshot.pages,
  })
  const rows = snapshot.pages.flatMap((capturedPage) =>
    getAdapter(src.adapter_slug).parseHistory(capturedPage.payload, 'copiers', {
      sourceSlug: snapshot.source.slug,
      currency: snapshot.source.currency,
      tfLabelMap: {},
      scrapedAt: snapshot.observed_at,
      meta: {},
    })
  )
  const parserProof = verifyCopierParserConservation({ ledger: candidateLedger, rows })
  return {
    src,
    snapshot,
    expectedSnapshot: snapshotAnchor(snapshot),
    candidateLedger,
    parserProof,
    rows,
  }
}

function build(input: Evidence): CopierSnapshotArtifactV2Result {
  return buildCopierSnapshotArtifactV2(input)
}

function revalidate(
  artifact: unknown,
  expectedSourceRunId: unknown
): CopierSnapshotArtifactV2Result {
  return revalidateCopierSnapshotArtifactV2({ artifact, expectedSourceRunId })
}

function clone<T>(value: T): DeepMutable<T> {
  return JSON.parse(strictCanonicalJson(value)) as DeepMutable<T>
}

const candidateA = {
  uid: 'a',
  nickName: 'private-a',
  followingProfitLoss: '1.25',
  copyAmount: '10',
  followingDays: 2,
}
const candidateB = {
  uid: 'b',
  nickName: 'private-b',
  followingProfitLoss: '2.5',
  copyAmount: '20',
  followingDays: 3,
}

describe('copier snapshot artifact v2', () => {
  it('binds every exact child under a deterministic non-recursive outer digest', () => {
    const input = evidence([[candidateA], [candidateB]])
    const built = build(input)
    const rebuilt = build(input)

    expect(built.artifact).toMatchObject({
      contract: COPIER_SNAPSHOT_ARTIFACT_V2_CONTRACT,
      serialization_contract: STRICT_CANONICAL_JSON_CONTRACT,
      snapshot: input.snapshot,
      snapshot_source_run_id: strictCanonicalSha256(input.snapshot),
      candidate_ledger: input.candidateLedger,
      candidate_ledger_sha256: strictCanonicalSha256(input.candidateLedger),
      parser_conservation: input.parserProof,
      parser_conservation_sha256: strictCanonicalSha256(input.parserProof),
    })
    expect(built.artifact.projection_ledger_sha256).toBe(
      strictCanonicalSha256(built.artifact.projection_ledger)
    )
    expect(built.artifact.projection_ledger).toMatchObject({
      snapshot_source_run_id: built.artifact.snapshot_source_run_id,
      candidate_ledger_sha256: built.artifact.candidate_ledger_sha256,
      parser_conservation_sha256: built.artifact.parser_conservation_sha256,
      row_count: 2,
    })
    expect(built.sourceRunId).toBe(strictCanonicalSha256(built.artifact))
    expect(rebuilt).toEqual(built)
    expect(revalidate(built.artifact, built.sourceRunId)).toEqual(built)

    expect(Object.keys(built.artifact).sort()).toEqual(
      [
        'contract',
        'serialization_contract',
        'snapshot',
        'snapshot_source_run_id',
        'candidate_ledger',
        'candidate_ledger_sha256',
        'parser_conservation',
        'parser_conservation_sha256',
        'projection_ledger',
        'projection_ledger_sha256',
      ].sort()
    )
    for (const forbidden of [
      'sourceRunId',
      'storage_path',
      'receipt',
      'rank_eligible',
      'parsed_rows',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(built.artifact, forbidden)).toBe(false)
    }
    expect(Object.isFrozen(built)).toBe(true)
    expect(Object.isFrozen(built.artifact)).toBe(true)
    expect(Object.isFrozen(built.artifact.snapshot.pages[0].payload)).toBe(true)
    expect(Object.isFrozen(built.artifact.candidate_ledger.pages)).toBe(true)
    expect(Object.isFrozen(built.artifact.parser_conservation.rows)).toBe(true)
    expect(Object.isFrozen(built.artifact.projection_ledger.rows[0].projection)).toBe(true)
  })

  it('preserves true-empty evidence without promoting its unverified terminal state', () => {
    const built = build(evidence([[]]))

    expect(built.artifact.snapshot).toMatchObject({
      scan_terminal_state: 'stream_exhausted_unverified',
      caller_limited: false,
      source_reported_row_count: null,
    })
    expect(built.artifact.candidate_ledger.observed_candidate_count).toBe(0)
    expect(built.artifact.parser_conservation.parsed_row_count).toBe(0)
    expect(built.artifact.projection_ledger).toMatchObject({ row_count: 0, rows: [] })
    expect(revalidate(built.artifact, built.sourceRunId)).toEqual(built)
  })

  it('retains duplicate occurrences and their ordered projection coordinates', () => {
    const built = build(evidence([[candidateA, candidateA, candidateB]]))
    const ledger = built.artifact.projection_ledger

    expect(ledger.row_count).toBe(3)
    expect(ledger.rows.map((row) => row.source_candidate_sha256)).toEqual([
      strictCanonicalSha256(candidateA),
      strictCanonicalSha256(candidateA),
      strictCanonicalSha256(candidateB),
    ])
    expect(ledger.rows.map((row) => [row.source_page_ordinal, row.candidate_ordinal])).toEqual([
      [1, 1],
      [1, 2],
      [1, 3],
    ])
    expect(ledger.rows[0].projection_sha256).toBe(ledger.rows[1].projection_sha256)
    expect(revalidate(built.artifact, built.sourceRunId)).toEqual(built)
  })

  it('preserves caller-limited as caller-limited and adds no ranking claim', () => {
    const built = build(evidence([[candidateA]], { callerLimited: true }))

    expect(built.artifact.snapshot).toMatchObject({
      scan_terminal_state: 'caller_limited',
      caller_limited: true,
      source_reported_row_count: null,
    })
    expect(Object.prototype.hasOwnProperty.call(built.artifact, 'rank_eligible')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(built.artifact, 'complete')).toBe(false)
  })

  it.each([
    ['source run', { sourceRunId: '0'.repeat(64) }],
    ['source id', { sourceId: 8 }],
    ['source slug', { sourceSlug: 'other_futures' }],
    ['trader id', { traderId: 92 }],
    ['exchange trader id', { exchangeTraderId: 'other-trader' }],
  ])('requires the external @1 %s coordinate before upgrade', (_label, change) => {
    const input = evidence([[candidateA]])

    expect(() =>
      buildCopierSnapshotArtifactV2({
        ...input,
        expectedSnapshot: { ...input.expectedSnapshot, ...change },
      })
    ).toThrow('does not match the external @1 capture anchor')
  })

  it('rejects a swapped capture/run and a swapped account before upgrade', () => {
    const first = evidence([[candidateA]], { minute: 0 })
    const later = evidence([[candidateA]], { minute: 1 })
    const otherTrader = evidence([[candidateA]], {
      minute: 2,
      traderId: 100,
      exchangeTraderId: 'trader-100',
    })

    expect(() =>
      buildCopierSnapshotArtifactV2({ ...later, expectedSnapshot: first.expectedSnapshot })
    ).toThrow('does not match the external @1 capture anchor')
    expect(() =>
      buildCopierSnapshotArtifactV2({ ...otherTrader, expectedSnapshot: first.expectedSnapshot })
    ).toThrow('does not match the external @1 capture anchor')
  })

  it('uses the live projection builder and rejects offline sources or forged parsed values', () => {
    const offline = evidence([[candidateA]])
    offline.src.status = 'inactive'
    expect(() => build(offline)).toThrow('source must be active serving with a copier surface')

    const forged = evidence([[candidateA]])
    const forgedRows = clone(forged.rows)
    const row = forgedRows[0]
    if (row.kind !== 'copiers') throw new Error('fixture did not replay a copier row')
    row.copierPnl = 999_999
    expect(
      verifyCopierParserConservation({ ledger: forged.candidateLedger, rows: forgedRows })
    ).toEqual(forged.parserProof)
    expect(() => buildCopierSnapshotArtifactV2({ ...forged, rows: forgedRows })).toThrow(
      'parsed copier rows do not match canonical parser replay'
    )
  })

  it('historically replays after SourceRow retirement and without caller parsed rows', () => {
    const input = evidence([[candidateA]])
    const built = build(input)
    input.src.status = 'inactive'
    input.src.serving_mode = 'shadow'
    const row = input.rows[0]
    if (row.kind !== 'copiers') throw new Error('fixture did not replay a copier row')
    row.copierPnl = 999_999

    expect(revalidate(built.artifact, built.sourceRunId)).toEqual(built)
    expect(Object.prototype.hasOwnProperty.call(built.artifact, 'rows')).toBe(false)
  })

  it('requires the immutable outer digest and never accepts a child digest as its anchor', () => {
    const first = build(evidence([[candidateA]], { minute: 0 }))
    const replacement = build(evidence([[candidateB]], { minute: 1 }))

    expect(() => revalidate(first.artifact, 'not-a-sha')).toThrow(
      'expected outer source-run id must be a lowercase SHA-256 digest'
    )
    expect(() => revalidate(first.artifact, '0'.repeat(64))).toThrow(
      'does not match its immutable source-run anchor'
    )
    expect(() => revalidate(first.artifact, first.artifact.snapshot_source_run_id)).toThrow(
      'does not match its immutable source-run anchor'
    )
    expect(() => revalidate(replacement.artifact, first.sourceRunId)).toThrow(
      'does not match its immutable source-run anchor'
    )
  })

  it.each([
    ['snapshot_source_run_id', 'snapshot digest'],
    ['candidate_ledger_sha256', 'candidate ledger digest'],
    ['parser_conservation_sha256', 'parser conservation digest'],
    ['projection_ledger_sha256', 'projection ledger digest'],
  ] as const)('rejects a stale %s even under a recomputed outer hash', (field, message) => {
    const built = build(evidence([[candidateA]]))
    const tampered = clone(built.artifact)
    tampered[field] = '0'.repeat(64)

    expect(() => revalidate(tampered, strictCanonicalSha256(tampered))).toThrow(message)
  })

  it('rejects a full child-evidence swap under a recomputed outer hash', () => {
    const first = build(evidence([[candidateA]], { minute: 0 }))
    const second = build(evidence([[candidateB]], { minute: 1 }))
    const swapped = clone(first.artifact)
    swapped.candidate_ledger = clone(second.artifact.candidate_ledger)
    swapped.candidate_ledger_sha256 = second.artifact.candidate_ledger_sha256
    swapped.parser_conservation = clone(second.artifact.parser_conservation)
    swapped.parser_conservation_sha256 = second.artifact.parser_conservation_sha256
    swapped.projection_ledger = clone(second.artifact.projection_ledger)
    swapped.projection_ledger_sha256 = second.artifact.projection_ledger_sha256

    expect(() => revalidate(swapped, strictCanonicalSha256(swapped))).toThrow()
  })

  it('rejects self-consistent projection tampering after every supplied digest is recomputed', () => {
    const built = build(evidence([[candidateA]]))
    const tampered = clone(built.artifact)
    tampered.projection_ledger.rows[0].projection.copier_pnl = '999'
    tampered.projection_ledger.rows[0].projection_sha256 = copierSnapshotProjectionSha256(
      tampered.projection_ledger.rows[0].projection
    )
    tampered.projection_ledger.candidate_projection_fixed_multiset_sha256 =
      copierSnapshotCandidateProjectionFixedMultisetSha256(
        tampered.projection_ledger.rows.map((row) => ({
          source_candidate_sha256: row.source_candidate_sha256,
          projection_sha256: row.projection_sha256,
        }))
      )
    tampered.projection_ledger_sha256 = strictCanonicalSha256(tampered.projection_ledger)

    expect(() => revalidate(tampered, strictCanonicalSha256(tampered))).toThrow(
      'does not match replayed immutable evidence'
    )
  })

  it.each(['sourceRunId', 'storage_path', 'receipt', 'rank_eligible', 'parsed_rows', 'complete'])(
    'rejects extra outer %s claims even under their recomputed hash',
    (field) => {
      const built = build(evidence([[candidateA]]))
      const withClaim = Object.assign(clone(built.artifact), { [field]: true })

      expect(() => revalidate(withClaim, strictCanonicalSha256(withClaim))).toThrow(
        'outer artifact must have the exact contract fields'
      )
    }
  )

  it('rejects extra fields in every child contract under recomputed child and outer hashes', () => {
    const built = build(evidence([[candidateA]]))

    const candidateExtra = clone(built.artifact)
    Object.assign(candidateExtra.candidate_ledger, { trusted: true })
    candidateExtra.candidate_ledger_sha256 = strictCanonicalSha256(candidateExtra.candidate_ledger)
    expect(() => revalidate(candidateExtra, strictCanonicalSha256(candidateExtra))).toThrow(
      'candidate ledger is not the exact canonical contract'
    )

    const parserExtra = clone(built.artifact)
    Object.assign(parserExtra.parser_conservation, { trusted: true })
    parserExtra.parser_conservation_sha256 = strictCanonicalSha256(parserExtra.parser_conservation)
    expect(() => revalidate(parserExtra, strictCanonicalSha256(parserExtra))).toThrow(
      'parser conservation proof is not the exact canonical contract'
    )

    const projectionExtra = clone(built.artifact)
    Object.assign(projectionExtra.projection_ledger, { trusted: true })
    projectionExtra.projection_ledger_sha256 = strictCanonicalSha256(
      projectionExtra.projection_ledger
    )
    expect(() => revalidate(projectionExtra, strictCanonicalSha256(projectionExtra))).toThrow(
      'projection ledger must have the exact contract fields'
    )

    const snapshotExtra = clone(built.artifact)
    Object.assign(snapshotExtra.snapshot, { trusted: true })
    snapshotExtra.snapshot_source_run_id = strictCanonicalSha256(snapshotExtra.snapshot)
    expect(() => revalidate(snapshotExtra, strictCanonicalSha256(snapshotExtra))).toThrow(
      'artifact is not the exact canonical contract'
    )
  })

  it('captures wrapper anchors through data descriptors without invoking accessors', () => {
    const built = build(evidence([[candidateA]]))
    let anchorReads = 0
    const accessorInput: { artifact: unknown; expectedSourceRunId: unknown } = {
      artifact: built.artifact,
      expectedSourceRunId: built.sourceRunId,
    }
    Object.defineProperty(accessorInput, 'expectedSourceRunId', {
      enumerable: true,
      get() {
        anchorReads += 1
        return built.sourceRunId
      },
    })

    expect(() => revalidateCopierSnapshotArtifactV2(accessorInput)).toThrow(
      'must contain enumerable data properties'
    )
    expect(anchorReads).toBe(0)

    let buildAnchorReads = 0
    const input = evidence([[candidateA]])
    Object.defineProperty(input.expectedSnapshot, 'sourceRunId', {
      enumerable: true,
      get() {
        buildAnchorReads += 1
        return copierSnapshotSourceRunId(input.snapshot)
      },
    })
    expect(() => build(input)).toThrow('object accessors')
    expect(buildAnchorReads).toBe(0)
  })

  it('rejects malformed build and revalidation envelopes before reading their values', () => {
    const input = evidence([[candidateA]])

    let buildTrapCalls = 0
    const proxiedBuild = new Proxy(input, {
      getPrototypeOf() {
        buildTrapCalls += 1
        return Object.prototype
      },
    })
    expect(() => Reflect.apply(buildCopierSnapshotArtifactV2, undefined, [proxiedBuild])).toThrow(
      'non-proxy plain object'
    )
    expect(buildTrapCalls).toBe(0)

    const buildWithSymbol = { ...input }
    Object.defineProperty(buildWithSymbol, Symbol('hidden'), { enumerable: true, value: true })
    expect(() =>
      Reflect.apply(buildCopierSnapshotArtifactV2, undefined, [buildWithSymbol])
    ).toThrow('exact contract fields')

    const buildWithHidden = { ...input }
    Object.defineProperty(buildWithHidden, 'hidden', { enumerable: false, value: true })
    expect(() =>
      Reflect.apply(buildCopierSnapshotArtifactV2, undefined, [buildWithHidden])
    ).toThrow('exact contract fields')

    const built = build(input)
    const revalidationWithExtra = {
      artifact: built.artifact,
      expectedSourceRunId: built.sourceRunId,
      extra: true,
    }
    expect(() =>
      Reflect.apply(revalidateCopierSnapshotArtifactV2, undefined, [revalidationWithExtra])
    ).toThrow('exact contract fields')

    let coercions = 0
    expect(() =>
      Reflect.apply(revalidateCopierSnapshotArtifactV2, undefined, [
        {
          artifact: built.artifact,
          expectedSourceRunId: {
            toString() {
              coercions += 1
              return built.sourceRunId
            },
          },
        },
      ])
    ).toThrow('must be a lowercase SHA-256 digest')
    expect(coercions).toBe(0)
  })

  it('rejects a proxied external snapshot anchor without executing its traps', () => {
    const input = evidence([[candidateA]])
    let trapCalls = 0
    input.expectedSnapshot = new Proxy(input.expectedSnapshot, {
      getPrototypeOf() {
        trapCalls += 1
        return Object.prototype
      },
    })

    expect(() => build(input)).toThrow('proxy objects')
    expect(trapCalls).toBe(0)
  })

  it('rejects wrapper and nested proxies without executing their traps or replacing the anchor', () => {
    const built = build(evidence([[candidateA]]))
    let wrapperTrapCalls = 0
    const wrapper = new Proxy(
      { artifact: built.artifact, expectedSourceRunId: built.sourceRunId },
      {
        getPrototypeOf() {
          wrapperTrapCalls += 1
          return Object.prototype
        },
      }
    )
    expect(() => revalidateCopierSnapshotArtifactV2(wrapper)).toThrow('non-proxy plain object')
    expect(wrapperTrapCalls).toBe(0)

    let nestedTrapCalls = 0
    const revalidationInput: { artifact: unknown; expectedSourceRunId: unknown } = {
      artifact: built.artifact,
      expectedSourceRunId: built.sourceRunId,
    }
    const proxiedArtifact = new Proxy(clone(built.artifact), {
      getPrototypeOf() {
        nestedTrapCalls += 1
        Object.defineProperty(revalidationInput, 'expectedSourceRunId', {
          enumerable: true,
          configurable: true,
          writable: true,
          value: strictCanonicalSha256(proxiedArtifact),
        })
        return Object.prototype
      },
    })
    revalidationInput.artifact = proxiedArtifact
    expect(() => revalidateCopierSnapshotArtifactV2(revalidationInput)).toThrow('proxy objects')
    expect(nestedTrapCalls).toBe(0)
    expect(revalidationInput.expectedSourceRunId).toBe(built.sourceRunId)
  })

  it('rejects nested accessors, symbols, and hidden fields under the original anchor', () => {
    const built = build(evidence([[candidateA]]))

    const accessor = clone(built.artifact)
    let reads = 0
    Object.defineProperty(accessor, 'contract', {
      enumerable: true,
      get() {
        reads += 1
        return COPIER_SNAPSHOT_ARTIFACT_V2_CONTRACT
      },
    })
    expect(() => revalidate(accessor, built.sourceRunId)).toThrow('object accessors')
    expect(reads).toBe(0)

    const symbol = clone(built.artifact)
    Object.defineProperty(symbol, Symbol('hidden'), { enumerable: true, value: true })
    expect(() => revalidate(symbol, built.sourceRunId)).toThrow('symbol keys')

    const hidden = clone(built.artifact)
    Object.defineProperty(hidden, 'hidden', { enumerable: false, value: true })
    expect(() => revalidate(hidden, built.sourceRunId)).toThrow('non-enumerable object properties')
  })
})
