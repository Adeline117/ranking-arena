import '../adapters/register'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT } from '../adapters/binance/history-contract'
import { BITGET_HISTORY_PAGE_ENVELOPE_CONTRACT } from '../adapters/bitget/history-terminal'
import type { ParsedHistoryRow, RawPage, SourceRow } from '../core/types'
import { getAdapter } from '../core/adapter'
import {
  COPIER_SNAPSHOT_ARTIFACT_CONTRACT,
  buildCopierSnapshotArtifact,
  copierSnapshotSourceRunId,
  type CopierSnapshotArtifact,
} from '../copier-snapshot-artifact'
import {
  COPIER_CANDIDATE_ADAPTER_SLUGS,
  buildCopierCandidateLedger,
  verifyCopierParserConservation,
  type CopierCandidateLedger,
  type CopierParserConservationProof,
} from '../copier-candidate-conservation'
import {
  COPIER_SNAPSHOT_CANDIDATE_PROJECTION_FIXED_MULTISET_CONTRACT,
  COPIER_SNAPSHOT_LENGTH_PREFIXED_UTF8_CONTRACT,
  COPIER_SNAPSHOT_PROJECTION_TUPLE_CONTRACT,
  COPIER_SNAPSHOT_SOURCE_CANDIDATE_FIXED_MULTISET_CONTRACT,
  copierSnapshotCandidateProjectionFixedMultisetSha256,
  copierSnapshotProjectionSha256,
  copierSnapshotSourceCandidateFixedMultisetSha256,
} from '../copier-snapshot-projection'
import {
  COPIER_SNAPSHOT_PARSER_BINDING_CONTRACT,
  COPIER_SNAPSHOT_PARSER_CONTRACTS,
  COPIER_SNAPSHOT_PROJECTION_LEDGER_CONTRACT,
  buildCopierSnapshotProjectionLedger,
  revalidateCopierSnapshotProjectionLedger,
  selectCopierSnapshotParserContract,
  type CopierSnapshotProjectionLedger,
  type RevalidateCopierSnapshotProjectionLedgerInput,
} from '../copier-snapshot-projection-ledger'
import {
  STRICT_CANONICAL_JSON_CONTRACT,
  strictCanonicalJson,
  strictCanonicalSha256,
} from '../strict-canonical-json'

type Candidate = Record<string, unknown>

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

function rawPage(candidates: Candidate[], pageIndex: number, secondOffset = pageIndex): RawPage {
  return capturedPage(
    { code: 0, data: { followerDetailsVoList: candidates } },
    pageIndex,
    secondOffset
  )
}

function capturedPage(payload: unknown, pageIndex: number, secondOffset = pageIndex): RawPage {
  return {
    pageIndex,
    payload,
    url: `https://example.test/copiers?page=${pageIndex}`,
    fetchedAt: `2026-08-04T12:00:${String(secondOffset).padStart(2, '0')}.000Z`,
  }
}

interface Evidence {
  src: SourceRow
  artifact: CopierSnapshotArtifact
  candidateLedger: CopierCandidateLedger
  parserProof: CopierParserConservationProof
  rows: ParsedHistoryRow[]
}

function evidenceFromPages(
  src: SourceRow,
  pages: RawPage[],
  rowsOverride?: ParsedHistoryRow[] | ((replayed: ParsedHistoryRow[]) => ParsedHistoryRow[])
): Evidence {
  const artifact = buildCopierSnapshotArtifact({
    src,
    traderId: 91,
    exchangeTraderId: 'trader-91',
    lane: 'tier_c',
    requestTimeframe: 0,
    pages,
    callerLimited: false,
  })
  const candidateLedger = buildCopierCandidateLedger({
    src,
    exchangeTraderId: artifact.trader.exchange_trader_id,
    pages: artifact.pages,
  })
  const replayed = artifact.pages.flatMap((page) =>
    getAdapter(src.adapter_slug).parseHistory(page.payload, 'copiers', {
      sourceSlug: artifact.source.slug,
      currency: artifact.source.currency,
      tfLabelMap: {},
      scrapedAt: artifact.observed_at,
      meta: src.adapter_slug === 'gate' ? { boardKey: src.meta.boardKey } : {},
    })
  )
  const rows =
    typeof rowsOverride === 'function' ? rowsOverride(replayed) : (rowsOverride ?? replayed)
  const parserProof = verifyCopierParserConservation({ ledger: candidateLedger, rows })
  return { src, artifact, candidateLedger, parserProof, rows }
}

function evidence(
  candidatesByPage: Candidate[][],
  rowsOverride?: ParsedHistoryRow[] | ((replayed: ParsedHistoryRow[]) => ParsedHistoryRow[]),
  sourceOverrides: Partial<SourceRow> = {}
): Evidence {
  const src = source(sourceOverrides)
  const pages = candidatesByPage.map((candidates, index) => rawPage(candidates, index + 1))
  return evidenceFromPages(src, pages, rowsOverride)
}

function build(input: Evidence): CopierSnapshotProjectionLedger {
  return buildCopierSnapshotProjectionLedger(input)
}

function storedEvidence(
  input: Pick<Evidence, 'artifact' | 'candidateLedger' | 'parserProof'>,
  ledger: unknown,
  expectedProjectionLedgerSha256 = strictCanonicalSha256(ledger)
): RevalidateCopierSnapshotProjectionLedgerInput {
  return {
    artifact: input.artifact,
    candidateLedger: input.candidateLedger,
    parserProof: input.parserProof,
    ledger,
    expectedProjectionLedgerSha256,
  }
}

function clone<T>(value: T): T {
  return JSON.parse(strictCanonicalJson(value)) as T
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

function fixture(relativePath: string): Candidate {
  return JSON.parse(
    readFileSync(join(__dirname, '..', 'adapters', relativePath), 'utf8')
  ) as Candidate
}

const realAdapterFixtures: readonly Array<{
  adapter: (typeof COPIER_CANDIDATE_ADAPTER_SLUGS)[number]
  src?: SourceRow
  fixturePath: string
  expectedCount: number
  wrap?(payload: Candidate): Candidate
}> = [
  {
    adapter: 'binance',
    fixturePath: 'binance/__tests__/fixtures/copy-traders-p1.json',
    expectedCount: 50,
    wrap: (response) => ({
      contract: BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT,
      portfolioId: 'trader-91',
      sort: null,
      request: { pageNumber: 1, pageSize: 50, portfolioId: 'trader-91' },
      response,
    }),
  },
  {
    adapter: 'bingx',
    fixturePath: 'bingx/__tests__/fixtures/records-followers.json',
    expectedCount: 12,
  },
  {
    adapter: 'bitget',
    fixturePath: 'bitget/__tests__/fixtures/copiers-p1.json',
    expectedCount: 2,
    wrap: (response) => ({
      contract: BITGET_HISTORY_PAGE_ENVELOPE_CONTRACT,
      historyTraderIdentity: 'trader-91',
      request: { pageNo: 1, pageSize: 10, traderUid: 'trader-91' },
      response,
    }),
  },
  {
    adapter: 'bitget_bots',
    fixturePath: 'bitget/__tests__/fixtures/bots-follow-rank.json',
    expectedCount: 10,
  },
  {
    adapter: 'bitunix',
    fixturePath: 'bitunix/__tests__/fixtures/follow-list-p1.json',
    expectedCount: 3,
  },
  {
    adapter: 'blofin',
    fixturePath: 'blofin/__tests__/fixtures/records-copiers.json',
    expectedCount: 20,
  },
  {
    adapter: 'btcc',
    fixturePath: 'btcc/__tests__/fixtures/followers-p1.json',
    expectedCount: 3,
  },
  {
    adapter: 'bybit_copytrade',
    fixturePath: 'bybit-copytrade/__tests__/fixtures/other-follower-p1.json',
    expectedCount: 18,
  },
  {
    adapter: 'coinex',
    fixturePath: 'coinex/__tests__/fixtures/followers-p1.json',
    expectedCount: 10,
  },
  {
    adapter: 'gate',
    src: source({
      slug: 'gate_futures',
      adapter_slug: 'gate',
      meta: { boardKey: 'futures' },
    }),
    fixturePath: 'gate/__tests__/fixtures/follow-user-p1.json',
    expectedCount: 3,
  },
  {
    adapter: 'gate',
    src: source({
      slug: 'gate_cfd',
      adapter_slug: 'gate',
      product_type: 'cfd',
      currency: 'USDx',
      meta: { boardKey: 'cfd' },
    }),
    fixturePath: 'gate/__tests__/fixtures/followers-cfd-p1.json',
    expectedCount: 3,
  },
  {
    adapter: 'kucoin',
    fixturePath: 'kucoin/__tests__/fixtures/copy-traders-p1.json',
    expectedCount: 3,
  },
  {
    adapter: 'lbank',
    fixturePath: 'lbank/__tests__/fixtures/followers-p1.json',
    expectedCount: 3,
  },
  {
    adapter: 'mexc',
    fixturePath: 'mexc/__tests__/fixtures/followers-p1.json',
    expectedCount: 10,
  },
  {
    adapter: 'okx',
    fixturePath: 'okx/__tests__/fixtures/copy-traders.json',
    expectedCount: 10,
  },
  {
    adapter: 'toobit',
    fixturePath: 'toobit/__tests__/fixtures/followers.json',
    expectedCount: 6,
  },
  {
    adapter: 'xt',
    fixturePath: 'xt/__tests__/fixtures/records-followers.json',
    expectedCount: 20,
  },
]

describe('copier snapshot projection ledger', () => {
  it('keeps an exact closed parser-contract registry and rejects unknown adapters', () => {
    expect(Object.keys(COPIER_SNAPSHOT_PARSER_CONTRACTS).sort()).toEqual(
      [...COPIER_CANDIDATE_ADAPTER_SLUGS].sort()
    )
    for (const adapterSlug of COPIER_CANDIDATE_ADAPTER_SLUGS) {
      expect(selectCopierSnapshotParserContract(adapterSlug)).toBe(
        `arena.ingest.copier-parser.${adapterSlug}@1`
      )
    }
    expect(() => selectCopierSnapshotParserContract('future' as never)).toThrow(
      'has no closed parser contract'
    )
    expect(() => selectCopierSnapshotParserContract('__proto__' as never)).toThrow(
      'has no closed parser contract'
    )
    expect(() => selectCopierSnapshotParserContract('constructor' as never)).toThrow(
      'has no closed parser contract'
    )
  })

  it.each(realAdapterFixtures)(
    'replays all $expectedCount rows from $fixturePath through the projection ledger',
    ({ adapter, src: configuredSource, fixturePath, expectedCount, wrap }) => {
      const src =
        configuredSource ??
        source({ adapter_slug: adapter, slug: `${adapter}_futures`, product_type: 'futures' })
      const captured = fixture(fixturePath)
      const payload = wrap ? wrap(captured) : captured
      const input = evidenceFromPages(src, [capturedPage(payload, 1)])
      const ledger = build(input)

      expect(ledger.row_count).toBe(expectedCount)
      expect(ledger.rows).toHaveLength(expectedCount)
      ledger.rows.forEach((row) => {
        expect(row.projection.source_candidate_sha256).toBe(row.source_candidate_sha256)
        expect(copierSnapshotProjectionSha256(row.projection)).toBe(row.projection_sha256)
      })
      expect({
        adapter,
        fixturePath,
        rowCount: ledger.row_count,
        sourceCandidateFixedMultisetSha256: ledger.source_candidate_fixed_multiset_sha256,
        candidateProjectionFixedMultisetSha256: ledger.candidate_projection_fixed_multiset_sha256,
      }).toMatchSnapshot()
      expect(revalidateCopierSnapshotProjectionLedger(storedEvidence(input, ledger))).toEqual(
        ledger
      )
    }
  )

  it('binds exact artifact, candidate ledger, parser proof, and projection tuples', () => {
    const input = evidence([[candidateA], [candidateB]])
    const ledger = build(input)
    const candidateHashes = input.parserProof.rows.map((row) => row.raw_candidate_sha256)
    const pairs = ledger.rows.map((row) => ({
      source_candidate_sha256: row.source_candidate_sha256,
      projection_sha256: row.projection_sha256,
    }))

    expect(ledger).toMatchObject({
      contract: COPIER_SNAPSHOT_PROJECTION_LEDGER_CONTRACT,
      serialization_contract: STRICT_CANONICAL_JSON_CONTRACT,
      snapshot_artifact_contract: COPIER_SNAPSHOT_ARTIFACT_CONTRACT,
      snapshot_source_run_id: copierSnapshotSourceRunId(input.artifact),
      candidate_ledger_sha256: strictCanonicalSha256(input.candidateLedger),
      parser_conservation_sha256: strictCanonicalSha256(input.parserProof),
      binding: {
        contract: COPIER_SNAPSHOT_PARSER_BINDING_CONTRACT,
        adapter_slug: 'bingx',
        product_type: 'futures',
        candidate_locator_contract: 'arena.ingest.copier-candidate-locator.bingx@1',
        parser_contract: 'arena.ingest.copier-parser.bingx@1',
      },
      parser_context: {
        sourceSlug: input.artifact.source.slug,
        currency: input.artifact.source.currency,
        tfLabelMap: {},
        scrapedAt: input.artifact.observed_at,
        meta: {},
      },
      projection_tuple_contract: COPIER_SNAPSHOT_PROJECTION_TUPLE_CONTRACT,
      projection_encoding_contract: COPIER_SNAPSHOT_LENGTH_PREFIXED_UTF8_CONTRACT,
      source_candidate_fixed_multiset_contract:
        COPIER_SNAPSHOT_SOURCE_CANDIDATE_FIXED_MULTISET_CONTRACT,
      candidate_projection_fixed_multiset_contract:
        COPIER_SNAPSHOT_CANDIDATE_PROJECTION_FIXED_MULTISET_CONTRACT,
      row_count: 2,
      source_candidate_fixed_multiset_sha256:
        copierSnapshotSourceCandidateFixedMultisetSha256(candidateHashes),
      candidate_projection_fixed_multiset_sha256:
        copierSnapshotCandidateProjectionFixedMultisetSha256(pairs),
    })
    expect(Object.keys(ledger).sort()).toEqual(
      [
        'contract',
        'serialization_contract',
        'snapshot_artifact_contract',
        'snapshot_source_run_id',
        'candidate_ledger_sha256',
        'parser_conservation_sha256',
        'binding',
        'parser_context',
        'projection_tuple_contract',
        'projection_encoding_contract',
        'source_candidate_fixed_multiset_contract',
        'candidate_projection_fixed_multiset_contract',
        'row_count',
        'source_candidate_fixed_multiset_sha256',
        'candidate_projection_fixed_multiset_sha256',
        'rows',
      ].sort()
    )
    expect(Object.keys(ledger.rows[0]).sort()).toEqual(
      [
        'row_ordinal',
        'source_page_ordinal',
        'candidate_ordinal',
        'source_candidate_sha256',
        'projection_sha256',
        'projection',
      ].sort()
    )
    ledger.rows.forEach((row, index) => {
      expect(row.row_ordinal).toBe(index)
      expect(row.source_page_ordinal).toBe(index + 1)
      expect(row.candidate_ordinal).toBe(1)
      expect(row.source_candidate_sha256).toBe(input.parserProof.rows[index].raw_candidate_sha256)
      expect(row.projection.source_candidate_sha256).toBe(row.source_candidate_sha256)
      expect(copierSnapshotProjectionSha256(row.projection)).toBe(row.projection_sha256)
    })
    expect(revalidateCopierSnapshotProjectionLedger(storedEvidence(input, ledger))).toEqual(ledger)
    expect(Object.isFrozen(ledger)).toBe(true)
    expect(Object.isFrozen(ledger.rows)).toBe(true)
    expect(Object.isFrozen(ledger.rows[0])).toBe(true)
    expect(Object.isFrozen(ledger.rows[0].projection)).toBe(true)
    expect(Object.isFrozen(ledger.binding)).toBe(true)
    expect(Object.isFrozen(ledger.parser_context)).toBe(true)
    expect(Object.isFrozen(ledger.parser_context.meta)).toBe(true)
  })

  it('revalidates stored evidence without a live SourceRow or caller-owned parsed rows', () => {
    const input = evidence([[candidateA]])
    const ledger = build(input)
    const stored = storedEvidence(input, ledger)

    input.src.status = 'inactive'
    input.src.serving_mode = 'shadow'
    const callerRow = input.rows[0]
    if (callerRow.kind !== 'copiers') throw new Error('test fixture did not replay a copier row')
    callerRow.copierPnl = 999_999

    expect(Object.keys(stored).sort()).toEqual(
      [
        'artifact',
        'candidateLedger',
        'parserProof',
        'ledger',
        'expectedProjectionLedgerSha256',
      ].sort()
    )
    expect(revalidateCopierSnapshotProjectionLedger(stored)).toEqual(ledger)
  })

  it('historically replays through its retained contract without the live adapter registry', async () => {
    const input = evidence([[candidateA]])
    const ledger = build(input)
    let registryCalls = 0

    try {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('../core/adapter', () => ({
          getAdapter: () => {
            registryCalls += 1
            throw new Error('live adapter registry is unavailable')
          },
        }))
        const isolated = await import('../copier-snapshot-projection-ledger')
        expect(
          isolated.revalidateCopierSnapshotProjectionLedger(storedEvidence(input, ledger))
        ).toEqual(ledger)
      })
      expect(registryCalls).toBe(0)
    } finally {
      jest.dontMock('../core/adapter')
    }
  })

  it('keeps historical replay valid after the operational copier capability is retired', () => {
    const input = evidence([[candidateA]])
    const ledger = build(input)
    const adapter = getAdapter(input.src.adapter_slug)
    const originalCapability = adapter.capabilities.copiers

    adapter.capabilities.copiers = false
    try {
      expect(() => build(input)).toThrow('not a copier parser authority for this source')
      expect(revalidateCopierSnapshotProjectionLedger(storedEvidence(input, ledger))).toEqual(
        ledger
      )
    } finally {
      adapter.capabilities.copiers = originalCapability
    }
  })

  it('accepts true-empty evidence with two distinct domain-separated fixed digests', () => {
    const input = evidence([[]], [])
    const ledger = build(input)

    expect(ledger.row_count).toBe(0)
    expect(ledger.rows).toEqual([])
    expect(ledger.source_candidate_fixed_multiset_sha256).toBe(
      copierSnapshotSourceCandidateFixedMultisetSha256([])
    )
    expect(ledger.candidate_projection_fixed_multiset_sha256).toBe(
      copierSnapshotCandidateProjectionFixedMultisetSha256([])
    )
    expect(ledger.source_candidate_fixed_multiset_sha256).not.toBe(
      ledger.candidate_projection_fixed_multiset_sha256
    )
    expect(() =>
      revalidateCopierSnapshotProjectionLedger(storedEvidence(input, ledger))
    ).not.toThrow()
  })

  it('persists only the reviewed parser-context allowlist', () => {
    const input = evidence([[candidateA]], undefined, {
      tf_label_map: { '7D': 7 },
      meta: { boardKey: 'futures', credential: 'must-not-persist' },
    })
    const ledger = build(input)

    expect(ledger.parser_context).toEqual({
      sourceSlug: input.artifact.source.slug,
      currency: input.artifact.source.currency,
      tfLabelMap: {},
      scrapedAt: input.artifact.observed_at,
      meta: {},
    })
    expect(strictCanonicalJson(ledger)).not.toContain('credential')
    expect(strictCanonicalJson(ledger)).not.toContain('7D')
  })

  it.each([
    {
      variant: 'futures',
      src: source({
        slug: 'gate_futures',
        adapter_slug: 'gate',
        meta: { boardKey: 'futures', credential: 'must-not-persist' },
      }),
      payload: {
        code: 200,
        data: [
          {
            follow_id: 'gate-follower',
            create_time: 1_754_304_001,
            profit: '1.25',
            follow_money: '10',
          },
        ],
      },
    },
    {
      variant: 'cfd',
      src: source({
        slug: 'gate_cfd',
        adapter_slug: 'gate',
        product_type: 'cfd',
        currency: 'USDx',
        meta: { boardKey: 'cfd', credential: 'must-not-persist' },
      }),
      payload: {
        code: 0,
        data: {
          list: [
            {
              nick_name: 'gate-cfd-follower',
              total_profit: '2.5',
              total_follow_amount: '20',
              total_follow_day: 3,
            },
          ],
        },
      },
    },
  ])(
    'durably binds the reviewed Gate $variant variant without secrets',
    ({ variant, src, payload }) => {
      const input = evidenceFromPages(src, [capturedPage(payload, 1)])
      const ledger = build(input)

      expect(ledger.binding).toMatchObject({
        adapter_slug: 'gate',
        product_type: variant,
        candidate_locator_contract: `arena.ingest.copier-candidate-locator.gate.${variant}@1`,
        parser_contract: 'arena.ingest.copier-parser.gate@1',
      })
      expect(ledger.parser_context.meta).toEqual({ boardKey: variant })
      expect(ledger.row_count).toBe(1)
      expect(strictCanonicalJson(ledger)).not.toContain('must-not-persist')
      expect(() =>
        revalidateCopierSnapshotProjectionLedger(storedEvidence(input, ledger))
      ).not.toThrow()

      const mismatched = clone(ledger)
      mismatched.binding.product_type = variant === 'futures' ? 'cfd' : 'futures'
      expect(() =>
        revalidateCopierSnapshotProjectionLedger(storedEvidence(input, mismatched))
      ).toThrow('locator does not match its adapter variant')
    }
  )

  it('rejects a source-specific copier surface the adapter does not support', () => {
    const src = source({
      slug: 'okx_spot',
      adapter_slug: 'okx',
      product_type: 'spot',
      meta: { inst_type: 'SPOT' },
    })
    const input = evidenceFromPages(src, [
      capturedPage({ code: '0', data: [{ copyTraders: [] }] }, 1),
    ])

    expect(() => build(input)).toThrow('not a copier parser authority for this source')
  })

  it('anchors durable product identity to the immutable projection-ledger SHA', () => {
    const src = source({
      slug: 'okx_futures',
      adapter_slug: 'okx',
      product_type: 'futures',
      meta: { inst_type: 'SWAP' },
    })
    const input = evidenceFromPages(src, [
      capturedPage({ code: '0', data: [{ copyTraders: [] }] }, 1),
    ])
    const ledger = build(input)
    const tampered = clone(ledger)
    tampered.binding.product_type = 'spot'
    const anchoredSha256 = strictCanonicalSha256(ledger)

    expect(() =>
      revalidateCopierSnapshotProjectionLedger(storedEvidence(input, tampered, anchoredSha256))
    ).toThrow('does not match its immutable SHA-256 anchor')

    let proxyTrapCalls = 0
    const proxiedInput = storedEvidence(input, tampered, anchoredSha256)
    const proxiedLedger = new Proxy(tampered, {
      getPrototypeOf() {
        proxyTrapCalls += 1
        Object.defineProperty(proxiedInput, 'expectedProjectionLedgerSha256', {
          enumerable: true,
          configurable: true,
          writable: true,
          value: strictCanonicalSha256(tampered),
        })
        return Object.prototype
      },
    })
    Object.defineProperty(proxiedInput, 'ledger', {
      enumerable: true,
      configurable: true,
      writable: true,
      value: proxiedLedger,
    })
    expect(() => revalidateCopierSnapshotProjectionLedger(proxiedInput)).toThrow('proxy objects')
    expect(proxyTrapCalls).toBe(0)
    expect(proxiedInput.expectedProjectionLedgerSha256).toBe(anchoredSha256)

    expect(() =>
      revalidateCopierSnapshotProjectionLedger(storedEvidence(input, ledger, 'not-a-sha'))
    ).toThrow('expected projection ledger SHA-256 is invalid')

    let coercions = 0
    const nonStringAnchor = {}
    Object.defineProperty(nonStringAnchor, 'toString', {
      get() {
        coercions += 1
        throw new Error('must not coerce an untrusted hash')
      },
    })
    expect(() =>
      revalidateCopierSnapshotProjectionLedger({
        ...storedEvidence(input, ledger),
        expectedProjectionLedgerSha256: nonStringAnchor,
      })
    ).toThrow('expected projection ledger SHA-256 is invalid')
    expect(coercions).toBe(0)

    let anchorReads = 0
    const accessorInput = storedEvidence(input, ledger)
    Object.defineProperty(accessorInput, 'expectedProjectionLedgerSha256', {
      enumerable: true,
      get() {
        anchorReads += 1
        return anchoredSha256
      },
    })
    expect(() => revalidateCopierSnapshotProjectionLedger(accessorInput)).toThrow(
      'enumerable data properties'
    )
    expect(anchorReads).toBe(0)
  })

  it('retains duplicate occurrences and consumes their earliest source coordinates', () => {
    const duplicate = {
      uid: 'same',
      nickName: 'same',
      followingProfitLoss: '1',
      copyAmount: '10',
      followingDays: 1,
    }
    const other = {
      uid: 'other',
      nickName: 'other',
      followingProfitLoss: '2',
      copyAmount: '20',
      followingDays: 2,
    }
    const input = evidence([[duplicate, duplicate, other]])
    const ledger = build(input)
    const duplicateHash = strictCanonicalSha256(duplicate)

    expect(ledger.rows.map((row) => row.source_candidate_sha256)).toEqual([
      duplicateHash,
      duplicateHash,
      strictCanonicalSha256(other),
    ])
    expect(ledger.rows.map((row) => [row.source_page_ordinal, row.candidate_ordinal])).toEqual([
      [1, 1],
      [1, 2],
      [1, 3],
    ])
    expect(ledger.rows[0].projection_sha256).toBe(ledger.rows[1].projection_sha256)
    expect(ledger.source_candidate_fixed_multiset_sha256).toBe(
      copierSnapshotSourceCandidateFixedMultisetSha256([
        duplicateHash,
        duplicateHash,
        strictCanonicalSha256(other),
      ])
    )
    expect(ledger.source_candidate_fixed_multiset_sha256).not.toBe(
      copierSnapshotSourceCandidateFixedMultisetSha256([
        duplicateHash,
        strictCanonicalSha256(other),
      ])
    )
  })

  it('rejects artifact source-coordinate drift before projection', () => {
    const input = evidence([[candidateA]])
    const changedSource = source({ currency: 'USDC' })

    expect(() => build({ ...input, src: changedSource })).toThrow(
      'artifact source coordinates do not match the source row'
    )
  })

  it.each([
    ['inactive', { status: 'inactive' as const }],
    ['shadow', { serving_mode: 'shadow' as const }],
    ['missing copier surface', { copier_table_depth: 'none' as const }],
  ])('rejects a %s live source even when the stored artifact remains valid', (_state, change) => {
    const input = evidence([[candidateA]])

    expect(() => build({ ...input, src: { ...input.src, ...change } })).toThrow(
      'source must be active serving with a copier surface'
    )
  })

  it('rejects a candidate ledger that cannot be replayed from exact artifact pages', () => {
    const input = evidence([[candidateA]])
    const other = evidence([[candidateB]])

    expect(() => build({ ...input, candidateLedger: other.candidateLedger })).toThrow(
      'does not match replayed RAW pages'
    )
  })

  it('rejects a swapped or tampered parser proof even when its shape is valid', () => {
    const input = evidence([[candidateA, candidateB]])
    const reversedRows = [...input.rows].reverse()
    const reversedProof = verifyCopierParserConservation({
      ledger: input.candidateLedger,
      rows: reversedRows,
    })
    const tamperedProof = clone(input.parserProof)
    tamperedProof.rows[0].raw_candidate_sha256 = '11'.repeat(32)

    expect(() => build({ ...input, parserProof: reversedProof })).toThrow(
      'parser conservation proof does not match'
    )
    expect(() => build({ ...input, parserProof: tamperedProof })).toThrow(
      'parser conservation proof does not match'
    )
  })

  it('rejects caller-forged projected values even though row.raw still conserves', () => {
    const input = evidence([[candidateA]])
    const forgedRows = clone(input.rows)
    const forged = forgedRows[0]
    if (forged.kind !== 'copiers') throw new Error('test fixture did not replay a copier row')
    forged.copierPnl = 999_999

    // The @1 proof sees only row.raw, so this remains byte-identical and proves
    // why registry replay is required before projection.
    const forgedProof = verifyCopierParserConservation({
      ledger: input.candidateLedger,
      rows: forgedRows,
    })
    expect(forgedProof).toEqual(input.parserProof)
    expect(() => build({ ...input, rows: forgedRows, parserProof: forgedProof })).toThrow(
      'parsed copier rows do not match canonical parser replay'
    )
  })

  it('rejects caller row reordering even when the multiset proof is valid', () => {
    const input = evidence([[candidateA, candidateB]])
    const reversedRows = [...input.rows].reverse()
    const reversedProof = verifyCopierParserConservation({
      ledger: input.candidateLedger,
      rows: reversedRows,
    })

    expect(() => build({ ...input, rows: reversedRows, parserProof: reversedProof })).toThrow(
      'parsed copier rows do not match canonical parser replay'
    )
  })

  it('rejects a source-run swap even when candidate content and proof are unchanged', () => {
    const input = evidence([[candidateA]])
    const laterPage = {
      ...input.artifact.pages[0],
      fetchedAt: '2026-08-04T12:01:00.000Z',
    }
    const laterArtifact = buildCopierSnapshotArtifact({
      src: input.src,
      traderId: input.artifact.trader.id,
      exchangeTraderId: input.artifact.trader.exchange_trader_id,
      lane: input.artifact.lane,
      requestTimeframe: input.artifact.request_timeframe,
      pages: [laterPage],
      callerLimited: input.artifact.caller_limited,
    })
    const ledger = build(input)
    const laterRows = laterArtifact.pages.flatMap((page) =>
      getAdapter(input.src.adapter_slug).parseHistory(page.payload, 'copiers', {
        sourceSlug: laterArtifact.source.slug,
        currency: laterArtifact.source.currency,
        tfLabelMap: {},
        scrapedAt: laterArtifact.observed_at,
        meta: {},
      })
    )
    const laterProof = verifyCopierParserConservation({
      ledger: input.candidateLedger,
      rows: laterRows,
    })

    expect(copierSnapshotSourceRunId(laterArtifact)).not.toBe(ledger.snapshot_source_run_id)
    expect(() =>
      revalidateCopierSnapshotProjectionLedger({
        artifact: laterArtifact,
        candidateLedger: input.candidateLedger,
        parserProof: laterProof,
        ledger,
        expectedProjectionLedgerSha256: strictCanonicalSha256(ledger),
      })
    ).toThrow('does not match replayed immutable evidence')
  })

  it('rejects self-consistent projection tampering instead of trusting supplied hashes', () => {
    const input = evidence([[candidateA]])
    const ledger = build(input)
    const tampered = clone(ledger)
    tampered.rows[0].projection.copier_pnl = '99'
    tampered.rows[0].projection_sha256 = copierSnapshotProjectionSha256(tampered.rows[0].projection)
    tampered.candidate_projection_fixed_multiset_sha256 =
      copierSnapshotCandidateProjectionFixedMultisetSha256([
        {
          source_candidate_sha256: tampered.rows[0].source_candidate_sha256,
          projection_sha256: tampered.rows[0].projection_sha256,
        },
      ])

    expect(() => revalidateCopierSnapshotProjectionLedger(storedEvidence(input, tampered))).toThrow(
      'does not match replayed immutable evidence'
    )
  })

  it('rejects parser contract, parser clock, and parser metadata tampering', () => {
    const input = evidence([[candidateA]])
    const ledger = build(input)
    const contractTamper = clone(ledger)
    contractTamper.binding.parser_contract = 'arena.ingest.copier-parser.bingx@2' as never
    const clockTamper = clone(ledger)
    clockTamper.parser_context.scrapedAt = '2026-08-04T00:00:00.000Z'
    const metadataTamper = clone(ledger)
    metadataTamper.parser_context.meta = { boardKey: 'futures' }

    expect(() =>
      revalidateCopierSnapshotProjectionLedger(storedEvidence(input, contractTamper))
    ).toThrow('parser replay binding parser contract is invalid')
    for (const tampered of [clockTamper, metadataTamper]) {
      expect(() =>
        revalidateCopierSnapshotProjectionLedger(storedEvidence(input, tampered))
      ).toThrow('does not match replayed immutable evidence')
    }
  })

  it('rejects omission and ledger-row reordering even with recomputed top-level digests', () => {
    const input = evidence([[candidateA, candidateB]])
    const ledger = build(input)
    const omitted = clone(ledger)
    omitted.rows.pop()
    omitted.row_count = omitted.rows.length
    omitted.source_candidate_fixed_multiset_sha256 =
      copierSnapshotSourceCandidateFixedMultisetSha256(
        omitted.rows.map((row) => row.source_candidate_sha256)
      )
    omitted.candidate_projection_fixed_multiset_sha256 =
      copierSnapshotCandidateProjectionFixedMultisetSha256(
        omitted.rows.map((row) => ({
          source_candidate_sha256: row.source_candidate_sha256,
          projection_sha256: row.projection_sha256,
        }))
      )

    const reordered = clone(ledger)
    reordered.rows.reverse()
    reordered.rows.forEach((row, index) => {
      row.row_ordinal = index
    })

    expect(() => revalidateCopierSnapshotProjectionLedger(storedEvidence(input, omitted))).toThrow(
      'does not match replayed immutable evidence'
    )
    expect(() =>
      revalidateCopierSnapshotProjectionLedger(storedEvidence(input, reordered))
    ).toThrow('does not match replayed immutable evidence')
  })

  it('rejects accessors in rows, evidence, and the supplied ledger', () => {
    const input = evidence([[candidateA]])
    const rowAccessor = clone(input.rows[0])
    Object.defineProperty(rowAccessor, 'raw', {
      enumerable: true,
      get: () => candidateA,
    })
    expect(() => build({ ...input, rows: [rowAccessor] as ParsedHistoryRow[] })).toThrow(
      'object accessors'
    )

    const candidateLedgerAccessor = clone(input.candidateLedger)
    Object.defineProperty(candidateLedgerAccessor, 'observed_candidate_count', {
      enumerable: true,
      get: () => 1,
    })
    expect(() => build({ ...input, candidateLedger: candidateLedgerAccessor })).toThrow(
      'object accessors'
    )

    const original = build(input)
    const supplied = clone(original)
    Object.defineProperty(supplied, 'snapshot_source_run_id', {
      enumerable: true,
      get: () => copierSnapshotSourceRunId(input.artifact),
    })
    expect(() =>
      revalidateCopierSnapshotProjectionLedger(
        storedEvidence(input, supplied, strictCanonicalSha256(original))
      )
    ).toThrow('object accessors')
  })

  it('rejects hidden, symbol, and extra projection-ledger fields', () => {
    const input = evidence([[candidateA]])
    const ledger = build(input)

    const hidden = clone(ledger)
    Object.defineProperty(hidden, 'hidden', { enumerable: false, value: true })
    expect(() =>
      revalidateCopierSnapshotProjectionLedger(
        storedEvidence(input, hidden, strictCanonicalSha256(ledger))
      )
    ).toThrow('non-enumerable object properties')

    const symbol = clone(ledger)
    Object.defineProperty(symbol, Symbol('hidden'), { enumerable: true, value: true })
    expect(() =>
      revalidateCopierSnapshotProjectionLedger(
        storedEvidence(input, symbol, strictCanonicalSha256(ledger))
      )
    ).toThrow('symbol keys')

    const extra = { ...clone(ledger), rank_eligible: true }
    expect(() => revalidateCopierSnapshotProjectionLedger(storedEvidence(input, extra))).toThrow(
      'projection ledger must have the exact contract fields'
    )
  })
})
