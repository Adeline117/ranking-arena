import '../adapters/register'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { getAdapter } from '../core/adapter'
import type { ParsedHistoryRow, RawPage, SourceRow } from '../core/types'
import {
  buildCopierSnapshotArtifact,
  copierSnapshotSourceRunId,
  type BuildCopierSnapshotArtifactInput,
  type CopierSnapshotArtifact,
} from '../copier-snapshot-artifact'
import {
  buildCopierSnapshotArtifactV2,
  type CopierSnapshotArtifactAnchor,
  type CopierSnapshotArtifactV2Result,
} from '../copier-snapshot-artifact-v2'
import {
  buildCopierCandidateLedger,
  deriveCopierCandidateReplayBinding,
  verifyCopierParserConservation,
} from '../copier-candidate-conservation'
import {
  buildCopierSnapshotParserContext,
  replayCopierSnapshotParser,
  selectCopierSnapshotParserContract,
} from '../copier-parser-replay'
import { captureCopierSnapshotTrustArtifactV2 } from '../copier-snapshot-trust-capture'
import { strictCanonicalJson } from '../strict-canonical-json'

type JsonObject = Record<string, unknown>

function fixture(relativePath: string): JsonObject {
  return JSON.parse(
    readFileSync(join(__dirname, '..', 'adapters', relativePath), 'utf8')
  ) as JsonObject
}

const bingxFollowers = fixture('bingx/__tests__/fixtures/records-followers.json')
const gateFuturesFollowers = fixture('gate/__tests__/fixtures/follow-user-p1.json')
const gateCfdFollowers = fixture('gate/__tests__/fixtures/followers-cfd-p1.json')
const okxFollowers = fixture('okx/__tests__/fixtures/copy-traders.json')

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: 71,
    slug: 'bingx_futures',
    exchange_id: 3,
    product_type: 'futures',
    trader_kind_scope: 'human',
    adapter_slug: 'bingx',
    leaderboard_url: 'https://example.test/leaderboard',
    timeframes_native: [7, 30, 90],
    timeframes_derived: [],
    tf_label_map: { '7D': 7 },
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
    meta: { credential: 'must-not-enter-parser-context' },
    ...overrides,
  }
}

function page(payload: unknown, pageIndex = 1, fetchedAt = '2026-08-08T12:00:01.000Z'): RawPage {
  return {
    pageIndex,
    payload,
    url: `https://example.test/copiers?page=${pageIndex}`,
    fetchedAt,
  }
}

function input(
  pages: readonly RawPage[],
  src: SourceRow = source()
): BuildCopierSnapshotArtifactInput {
  return {
    src,
    traderId: 991,
    exchangeTraderId: 'trader-991',
    lane: 'tier_c',
    requestTimeframe: 0,
    pages,
    callerLimited: false,
  }
}

function anchor(snapshot: CopierSnapshotArtifact): CopierSnapshotArtifactAnchor {
  return {
    sourceRunId: copierSnapshotSourceRunId(snapshot),
    sourceId: snapshot.source.id,
    sourceSlug: snapshot.source.slug,
    traderId: snapshot.trader.id,
    exchangeTraderId: snapshot.trader.exchange_trader_id,
  }
}

function manualRetainedPipeline(
  capture: BuildCopierSnapshotArtifactInput
): CopierSnapshotArtifactV2Result {
  const snapshot = buildCopierSnapshotArtifact(capture)
  const candidateLedger = buildCopierCandidateLedger({
    src: capture.src,
    exchangeTraderId: snapshot.trader.exchange_trader_id,
    pages: snapshot.pages,
  })
  const candidateBinding = deriveCopierCandidateReplayBinding(capture.src)
  const parserContract = selectCopierSnapshotParserContract(candidateBinding.adapter_slug)
  const ctx = buildCopierSnapshotParserContext({
    adapterSlug: candidateBinding.adapter_slug,
    parserContract,
    productType: candidateBinding.product_type,
    sourceSlug: snapshot.source.slug,
    currency: snapshot.source.currency,
    scrapedAt: snapshot.observed_at,
  })
  const rows: ParsedHistoryRow[] = snapshot.pages.flatMap((capturedPage) =>
    replayCopierSnapshotParser({
      adapterSlug: candidateBinding.adapter_slug,
      parserContract,
      raw: capturedPage.payload,
      ctx,
    })
  )
  const parserProof = verifyCopierParserConservation({ ledger: candidateLedger, rows })
  return buildCopierSnapshotArtifactV2({
    src: capture.src,
    snapshot,
    expectedSnapshot: anchor(snapshot),
    candidateLedger,
    parserProof,
    rows,
  })
}

describe('copier snapshot trust capture orchestration', () => {
  it('matches the manual retained pipeline on a real ordinary adapter fixture', () => {
    const capture = input([page(bingxFollowers)])
    const built = captureCopierSnapshotTrustArtifactV2(capture)

    expect(strictCanonicalJson(built)).toBe(strictCanonicalJson(manualRetainedPipeline(capture)))
    expect(built.artifact.candidate_ledger.observed_candidate_count).toBe(12)
    expect(built.artifact.projection_ledger.row_count).toBe(12)
    expect(Object.isFrozen(built)).toBe(true)
    expect(Object.isFrozen(built.artifact)).toBe(true)
    expect(Object.isFrozen(built.artifact.projection_ledger.rows)).toBe(true)
    expect(Object.keys(built).sort()).toEqual(['artifact', 'sourceRunId'])
  })

  it('pins the Gate CFD variant and the reviewed parser-context allowlist', () => {
    const src = source({
      slug: 'gate_cfd',
      adapter_slug: 'gate',
      product_type: 'cfd',
      currency: 'USDx',
      meta: { boardKey: 'cfd', credential: 'must-not-persist' },
    })
    const built = captureCopierSnapshotTrustArtifactV2(input([page(gateCfdFollowers)], src))

    expect(built.artifact.candidate_ledger.observed_candidate_count).toBe(3)
    expect(built.artifact.projection_ledger.binding).toMatchObject({
      adapter_slug: 'gate',
      product_type: 'cfd',
      candidate_locator_contract: 'arena.ingest.copier-candidate-locator.gate.cfd@1',
      parser_contract: 'arena.ingest.copier-parser.gate@1',
    })
    expect(built.artifact.projection_ledger.parser_context).toEqual({
      sourceSlug: 'gate_cfd',
      currency: 'USDx',
      tfLabelMap: {},
      scrapedAt: '2026-08-08T12:00:01.000Z',
      meta: { boardKey: 'cfd' },
    })
    expect(strictCanonicalJson(built.artifact)).not.toContain('credential')
  })

  it.each([
    {
      name: 'Gate futures',
      src: source({
        slug: 'gate_futures',
        adapter_slug: 'gate',
        product_type: 'futures',
        meta: { boardKey: 'futures' },
      }),
      payload: gateFuturesFollowers,
      count: 3,
      locator: 'arena.ingest.copier-candidate-locator.gate.futures@1',
      parserMeta: { boardKey: 'futures' },
    },
    {
      name: 'OKX SWAP',
      src: source({
        slug: 'okx_futures',
        adapter_slug: 'okx',
        product_type: 'futures',
        meta: { inst_type: 'SWAP' },
      }),
      payload: okxFollowers,
      count: 10,
      locator: 'arena.ingest.copier-candidate-locator.okx@1',
      parserMeta: {},
    },
  ])(
    'pins the retained $name surface contract locally',
    ({ src, payload, count, locator, parserMeta }) => {
      const built = captureCopierSnapshotTrustArtifactV2(input([page(payload)], src))

      expect(built.artifact.candidate_ledger.observed_candidate_count).toBe(count)
      expect(built.artifact.projection_ledger.row_count).toBe(count)
      expect(built.artifact.projection_ledger.binding.candidate_locator_contract).toBe(locator)
      expect(built.artifact.projection_ledger.parser_context.meta).toEqual(parserMeta)
    }
  )

  it('retains a true-empty capture and binds the parser clock to the last captured page', () => {
    const emptyPayload = { code: 0, data: { followerDetailsVoList: [] } }
    const built = captureCopierSnapshotTrustArtifactV2(
      input([
        page(emptyPayload, 1, '2026-08-08T12:00:01.000Z'),
        page(emptyPayload, 2, '2026-08-08T12:00:09.000Z'),
      ])
    )

    expect(built.artifact.snapshot.observed_at).toBe('2026-08-08T12:00:09.000Z')
    expect(built.artifact.candidate_ledger.observed_candidate_count).toBe(0)
    expect(built.artifact.parser_conservation.parsed_row_count).toBe(0)
    expect(built.artifact.projection_ledger.row_count).toBe(0)
    expect(built.artifact.projection_ledger.parser_context).toEqual({
      sourceSlug: 'bingx_futures',
      currency: 'USDT',
      tfLabelMap: {},
      scrapedAt: '2026-08-08T12:00:09.000Z',
      meta: {},
    })
  })

  it('never calls the mutable adapter parser', () => {
    const adapter = getAdapter('bingx')
    const mutableParser = jest.spyOn(adapter, 'parseHistory').mockImplementation(() => {
      throw new Error('mutable parser must not run')
    })

    try {
      expect(() =>
        captureCopierSnapshotTrustArtifactV2(input([page(bingxFollowers)]))
      ).not.toThrow()
      expect(mutableParser).not.toHaveBeenCalled()
    } finally {
      mutableParser.mockRestore()
    }

    const implementation = readFileSync(
      join(__dirname, '..', 'copier-snapshot-trust-capture.ts'),
      'utf8'
    )
    expect(implementation).not.toMatch(/core\/adapter|adapters\/.+parsers/)
    expect(implementation).toContain("from './copier-parser-replay'")
  })

  it.each([
    source({ status: 'inactive' }),
    source({ serving_mode: 'shadow' }),
    source({ copier_table_depth: 'none' }),
  ])('fails closed when the live source is not serving a copier surface', (src) => {
    expect(() => captureCopierSnapshotTrustArtifactV2(input([page(bingxFollowers)], src))).toThrow(
      'source must be active serving with a copier surface'
    )
  })

  it('fails closed when the Gate source variant is inconsistent', () => {
    const src = source({
      slug: 'gate_cfd',
      adapter_slug: 'gate',
      product_type: 'cfd',
      currency: 'USDx',
      meta: { boardKey: 'futures' },
    })
    expect(() =>
      captureCopierSnapshotTrustArtifactV2(input([page(gateCfdFollowers)], src))
    ).toThrow('gate source variant must be explicit and internally consistent')
  })

  it('fails closed when an OKX spot source is presented as a copier surface', () => {
    const src = source({
      slug: 'okx_spot',
      adapter_slug: 'okx',
      product_type: 'spot',
      meta: { inst_type: 'SPOT' },
    })
    expect(() => captureCopierSnapshotTrustArtifactV2(input([page(okxFollowers)], src))).toThrow(
      'is not a copier parser authority for this source'
    )
  })

  it('rejects caller evidence fields, proxies, and accessors before replay', () => {
    const valid = input([page(bingxFollowers)])
    const withRows = { ...valid, rows: [] }
    expect(() =>
      Reflect.apply(captureCopierSnapshotTrustArtifactV2, undefined, [withRows])
    ).toThrow('exact capture fields')

    const proxied = new Proxy(valid, {})
    expect(() => captureCopierSnapshotTrustArtifactV2(proxied)).toThrow('non-proxy plain object')

    let getterCalls = 0
    const accessorInput = { ...valid }
    Object.defineProperty(accessorInput, 'exchangeTraderId', {
      enumerable: true,
      get() {
        getterCalls += 1
        return 'swapped-trader'
      },
    })
    expect(() =>
      Reflect.apply(captureCopierSnapshotTrustArtifactV2, undefined, [accessorInput])
    ).toThrow('enumerable data properties')
    expect(getterCalls).toBe(0)

    const nestedProxy = input([page(new Proxy(bingxFollowers, {}))])
    expect(() => captureCopierSnapshotTrustArtifactV2(nestedProxy)).toThrow(
      'strict canonical JSON rejects proxy objects'
    )
  })

  it('detaches caller-owned source and pages before building frozen evidence', () => {
    const raw = JSON.parse(strictCanonicalJson(bingxFollowers)) as JsonObject
    const src = source()
    const capture = input([page(raw)], src)
    const built = captureCopierSnapshotTrustArtifactV2(capture)
    const before = strictCanonicalJson(built)

    src.slug = 'mutated_source'
    raw.code = 999
    capture.pages[0].fetchedAt = '2026-08-08T12:00:59.000Z'

    expect(strictCanonicalJson(built)).toBe(before)
    expect(() => {
      ;(built.artifact.snapshot.pages[0].payload as JsonObject).code = 999
    }).toThrow()
  })
})
