import '../adapters/register'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { getAdapter, listAdapters } from '../core/adapter'
import type { ParsedCopierRow, ParsedHistoryRow, RawPage, SourceRow } from '../core/types'
import {
  COPIER_CANDIDATE_ADAPTER_SLUGS,
  COPIER_CANDIDATE_MULTISET_CONTRACT,
  COPIER_CANDIDATE_REPLAY_BINDING_CONTRACT,
  buildCopierCandidateLedger,
  buildCopierCandidateLedgerFromReplayBinding,
  deriveCopierCandidateReplayBinding,
  extractCopierCandidateRecords,
  extractCopierCandidateRecordsFromReplayBinding,
  revalidateCopierCandidateLedger,
  revalidateCopierCandidateLedgerFromReplayBinding,
  revalidateCopierCandidateReplayBinding,
  selectCopierCandidateLocatorContract,
  verifyCopierParserConservation,
  type CopierCandidateAdapterSlug,
} from '../copier-candidate-conservation'
import { BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT } from '../adapters/binance/history-contract'
import { BITGET_HISTORY_PAGE_ENVELOPE_CONTRACT } from '../adapters/bitget/history-terminal'
import { strictCanonicalSha256 } from '../strict-canonical-json'

type Dict = Record<string, unknown>

const exchangeTraderId = 'trader-1'

function source(adapterSlug: string, overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: 1,
    slug: `${adapterSlug}_futures`,
    exchange_id: 1,
    product_type: 'futures',
    trader_kind_scope: 'human',
    adapter_slug: adapterSlug,
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

function page(payload: unknown, pageIndex = 1): RawPage {
  return {
    pageIndex,
    payload,
    url: `https://example.test/copiers?page=${pageIndex}`,
    fetchedAt: `2026-08-03T12:00:0${pageIndex}.000Z`,
  }
}

function copierRow(raw: Dict, index = 0): ParsedCopierRow {
  return {
    kind: 'copiers',
    ts: '2026-08-03T12:00:00.000Z',
    copierLabel: `private-${index}`,
    copierPnl: index,
    copierInvested: null,
    copyDurationDays: null,
    dedupeHash: `row-${index}`,
    raw,
  }
}

function fixture(relativePath: string): Dict {
  return JSON.parse(readFileSync(join(__dirname, '..', 'adapters', relativePath), 'utf8')) as Dict
}

interface Shape {
  adapter: CopierCandidateAdapterSlug
  src?: SourceRow
  payload(candidates: Dict[], pageIndex?: number): Dict
  locator?: string
}

const shapes: readonly Shape[] = [
  {
    adapter: 'binance',
    payload: (candidates, pageIndex = 1) => ({
      contract: BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT,
      portfolioId: exchangeTraderId,
      sort: null,
      request: { pageNumber: pageIndex, pageSize: 50, portfolioId: exchangeTraderId },
      response: { code: '000000', success: true, data: { list: candidates } },
    }),
  },
  {
    adapter: 'bingx',
    payload: (candidates) => ({ code: 0, data: { followerDetailsVoList: candidates } }),
  },
  {
    adapter: 'bitget',
    payload: (candidates, pageIndex = 1) => ({
      contract: BITGET_HISTORY_PAGE_ENVELOPE_CONTRACT,
      historyTraderIdentity: exchangeTraderId,
      request: { pageNo: pageIndex, pageSize: 10, traderUid: exchangeTraderId },
      response: { code: '00000', success: true, data: { rows: candidates } },
    }),
  },
  {
    adapter: 'bitget_bots',
    payload: (candidates) => ({ code: '200', data: { followers: candidates } }),
  },
  {
    adapter: 'bitunix',
    payload: (candidates) => ({ code: 0, success: true, data: { records: candidates } }),
  },
  { adapter: 'blofin', payload: (candidates) => ({ code: 200, data: candidates }) },
  { adapter: 'btcc', payload: (candidates) => ({ code: 200, rows: candidates }) },
  {
    adapter: 'bybit_copytrade',
    payload: (candidates) => ({ retCode: 0, result: { data: candidates } }),
  },
  { adapter: 'coinex', payload: (candidates) => ({ code: 0, data: { data: candidates } }) },
  {
    adapter: 'gate',
    src: source('gate', { slug: 'gate_futures', meta: { boardKey: 'futures' } }),
    payload: (candidates) => ({ code: 200, data: candidates }),
    locator: 'arena.ingest.copier-candidate-locator.gate.futures@1',
  },
  {
    adapter: 'gate',
    src: source('gate', {
      slug: 'gate_cfd',
      product_type: 'cfd',
      currency: 'USDx',
      meta: { boardKey: 'cfd' },
    }),
    payload: (candidates) => ({ code: 0, data: { list: candidates } }),
    locator: 'arena.ingest.copier-candidate-locator.gate.cfd@1',
  },
  {
    adapter: 'kucoin',
    payload: (candidates) => ({ code: '200', success: true, data: { items: candidates } }),
  },
  { adapter: 'lbank', payload: (candidates) => ({ code: 200, data: { records: candidates } }) },
  {
    adapter: 'mexc',
    payload: (candidates) => ({ code: 0, success: true, data: { content: candidates } }),
  },
  {
    adapter: 'okx',
    payload: (candidates) => ({ code: '0', data: [{ copyTraders: candidates }] }),
  },
  { adapter: 'toobit', payload: (candidates) => ({ code: 200, data: candidates }) },
  {
    adapter: 'xt',
    payload: (candidates) => ({ returnCode: 0, error: null, result: { items: candidates } }),
  },
]

function shape(adapter: CopierCandidateAdapterSlug): Shape {
  const selected = shapes.find((candidate) => candidate.adapter === adapter)
  if (!selected) throw new Error(`missing test shape for ${adapter}`)
  return selected
}

const realShapes: readonly Array<{
  adapter: CopierCandidateAdapterSlug
  src?: SourceRow
  fixturePath: string
  expectedCount: number
  wrap?(payload: Dict): Dict
}> = [
  {
    adapter: 'binance',
    fixturePath: 'binance/__tests__/fixtures/copy-traders-p1.json',
    expectedCount: 50,
    wrap: (response) => ({
      contract: BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT,
      portfolioId: exchangeTraderId,
      sort: null,
      request: { pageNumber: 1, pageSize: 50, portfolioId: exchangeTraderId },
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
      historyTraderIdentity: exchangeTraderId,
      request: { pageNo: 1, pageSize: 10, traderUid: exchangeTraderId },
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
    src: source('gate', { slug: 'gate_futures', meta: { boardKey: 'futures' } }),
    fixturePath: 'gate/__tests__/fixtures/follow-user-p1.json',
    expectedCount: 3,
  },
  {
    adapter: 'gate',
    src: source('gate', {
      slug: 'gate_cfd',
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

describe('copier candidate closed registry', () => {
  it('exactly covers every registered adapter that declares copiers', () => {
    const declared = listAdapters()
      .filter((slug) => getAdapter(slug).capabilities.copiers)
      .sort()
    expect(declared).toEqual([...COPIER_CANDIDATE_ADAPTER_SLUGS].sort())
  })

  it.each(shapes)(
    'enumerates the exact $adapter candidate path without losing row identity',
    ({ adapter, src = source(adapter), payload, locator }) => {
      const candidates = [
        { uid: 'a', pnl: 1 },
        { pnl: 2, uid: 'b' },
      ]
      const extracted = extractCopierCandidateRecords({
        src,
        exchangeTraderId,
        pageIndex: 1,
        payload: payload(candidates),
      })
      expect(extracted.candidates).toEqual(candidates)
      expect(extracted.locatorContract).toBe(
        locator ?? `arena.ingest.copier-candidate-locator.${adapter}@1`
      )
      expect(Object.isFrozen(extracted)).toBe(true)
      expect(Object.isFrozen(extracted.candidates[0])).toBe(true)

      const ledger = buildCopierCandidateLedger({
        src,
        exchangeTraderId,
        pages: [page(payload(candidates))],
      })
      const proof = verifyCopierParserConservation({
        ledger,
        rows: candidates.map(copierRow),
      })
      expect(ledger.observed_candidate_count).toBe(2)
      expect(proof.parsed_row_count).toBe(2)
      expect(proof.candidate_multiset_sha256).toBe(proof.parsed_raw_multiset_sha256)
    }
  )

  it.each(realShapes)(
    'conserves all $expectedCount real $adapter fixture candidates through its parser',
    ({ adapter, src = source(adapter), fixturePath, expectedCount, wrap }) => {
      const captured = fixture(fixturePath)
      const payload = wrap ? wrap(captured) : captured
      const ledger = buildCopierCandidateLedger({
        src,
        exchangeTraderId,
        pages: [page(payload)],
      })
      const parsed = getAdapter(adapter).parseHistory(payload, 'copiers', {
        sourceSlug: src.slug,
        currency: src.currency,
        tfLabelMap: src.tf_label_map,
        scrapedAt: '2026-08-03T12:00:00.000Z',
        meta: src.meta,
      })

      expect(ledger.observed_candidate_count).toBe(expectedCount)
      expect(parsed).toHaveLength(expectedCount)
      expect(() => verifyCopierParserConservation({ ledger, rows: parsed })).not.toThrow()
    }
  )

  it('accepts a semantically observed true-empty array without inventing rows', () => {
    const selected = shape('bingx')
    const ledger = buildCopierCandidateLedger({
      src: source('bingx'),
      exchangeTraderId,
      pages: [page(selected.payload([]))],
    })
    const proof = verifyCopierParserConservation({ ledger, rows: [] })
    expect(ledger.observed_candidate_count).toBe(0)
    expect(proof.parsed_row_count).toBe(0)
  })

  it('binds canonical Binance and Bitget wrappers to the exact trader and request page', () => {
    const candidate = [{ uid: 'a' }]
    const binance = shape('binance').payload(candidate)
    binance.portfolioId = 'another-trader'
    expect(() =>
      extractCopierCandidateRecords({
        src: source('binance'),
        exchangeTraderId,
        pageIndex: 1,
        payload: binance,
      })
    ).toThrow('binance canonical wrapper is invalid')

    const bitget = shape('bitget').payload(candidate)
    ;(bitget.request as Dict).pageNo = 2
    expect(() =>
      extractCopierCandidateRecords({
        src: source('bitget'),
        exchangeTraderId,
        pageIndex: 1,
        payload: bitget,
      })
    ).toThrow('bitget copier request binding is invalid')

    const legacy = { data: { rows: candidate } }
    expect(() =>
      extractCopierCandidateRecords({
        src: source('bitget'),
        exchangeTraderId,
        pageIndex: 1,
        payload: legacy,
      })
    ).toThrow('bitget canonical wrapper is invalid')
  })

  it('requires Gate to name one internally consistent source variant', () => {
    expect(() =>
      extractCopierCandidateRecords({
        src: source('gate'),
        exchangeTraderId,
        pageIndex: 1,
        payload: { code: 200, data: [] },
      })
    ).toThrow('gate source variant must be explicit')
    expect(() =>
      extractCopierCandidateRecords({
        src: source('gate', { meta: { boardKey: 'cfd' } }),
        exchangeTraderId,
        pageIndex: 1,
        payload: { code: 0, data: { list: [] } },
      })
    ).toThrow('gate source variant must be explicit')
  })

  it('rejects unknown adapters, missing paths, error envelopes, and non-object candidates', () => {
    expect(() =>
      extractCopierCandidateRecords({
        src: source('future_adapter'),
        exchangeTraderId,
        pageIndex: 1,
        payload: {},
      })
    ).toThrow('is not registered')
    expect(() =>
      extractCopierCandidateRecords({
        src: source('bingx'),
        exchangeTraderId,
        pageIndex: 1,
        payload: { code: 0, data: {} },
      })
    ).toThrow('must be an array')
    expect(() =>
      extractCopierCandidateRecords({
        src: source('bingx'),
        exchangeTraderId,
        pageIndex: 1,
        payload: { code: 500, data: { followerDetailsVoList: [] } },
      })
    ).toThrow('non-success envelope')
    expect(() =>
      extractCopierCandidateRecords({
        src: source('bingx'),
        exchangeTraderId,
        pageIndex: 1,
        payload: { code: 0, data: { followerDetailsVoList: [null] } },
      })
    ).toThrow('candidate 1 must be an object')
    expect(() =>
      extractCopierCandidateRecords({
        src: source('bingx'),
        exchangeTraderId,
        pageIndex: 1,
        payload: { code: 0, data: { followerDetailsVoList: [{ bad: undefined }] } },
      })
    ).toThrow('strict canonical JSON')
  })

  it('rejects OKX aggregate blocks the parser would otherwise silently ignore', () => {
    expect(() =>
      extractCopierCandidateRecords({
        src: source('okx'),
        exchangeTraderId,
        pageIndex: 1,
        payload: {
          code: '0',
          data: [{ copyTraders: [] }, { copyTraders: [{ uid: 'hidden' }] }],
        },
      })
    ).toThrow('exactly one aggregate block')
  })
})

describe('durable copier candidate replay binding', () => {
  it.each(shapes)(
    'derives and replays the exact $adapter locator without a SourceRow',
    ({ adapter, src = source(adapter), payload, locator }) => {
      const binding = deriveCopierCandidateReplayBinding(src)
      const expectedLocator = locator ?? `arena.ingest.copier-candidate-locator.${adapter}@1`
      expect(binding).toEqual({
        contract: COPIER_CANDIDATE_REPLAY_BINDING_CONTRACT,
        serialization_contract: 'arena.strict-canonical-json@1',
        adapter_slug: adapter,
        product_type: src.product_type,
        candidate_locator_contract: expectedLocator,
      })
      expect(Object.isFrozen(binding)).toBe(true)
      expect(revalidateCopierCandidateReplayBinding(binding)).toEqual(binding)

      const candidates = [{ uid: 'a' }, { uid: 'b' }]
      const extracted = extractCopierCandidateRecordsFromReplayBinding({
        binding,
        exchangeTraderId,
        pageIndex: 1,
        payload: payload(candidates),
      })
      expect(extracted.locatorContract).toBe(expectedLocator)
      expect(extracted.candidates).toEqual(candidates)
    }
  )

  it('locks Gate to the exact futures/cfd product and locator pair', () => {
    const futures = deriveCopierCandidateReplayBinding(
      source('gate', { meta: { boardKey: 'futures' } })
    )
    const cfd = deriveCopierCandidateReplayBinding(
      source('gate', {
        slug: 'gate_cfd',
        product_type: 'cfd',
        meta: { boardKey: 'cfd' },
      })
    )
    expect(futures.candidate_locator_contract).toBe(
      'arena.ingest.copier-candidate-locator.gate.futures@1'
    )
    expect(cfd.candidate_locator_contract).toBe('arena.ingest.copier-candidate-locator.gate.cfd@1')

    expect(() =>
      deriveCopierCandidateReplayBinding(
        source('gate', { product_type: 'futures', meta: { boardKey: 'cfd' } })
      )
    ).toThrow('gate source variant must be explicit')
    expect(() =>
      deriveCopierCandidateReplayBinding(
        source('gate', { product_type: 'spot', meta: { boardKey: 'spot' } })
      )
    ).toThrow('gate product type must be futures or cfd')
    expect(() =>
      revalidateCopierCandidateReplayBinding({
        ...futures,
        candidate_locator_contract: 'arena.ingest.copier-candidate-locator.gate.cfd@1',
      })
    ).toThrow('locator does not match its adapter variant')
    expect(() =>
      revalidateCopierCandidateReplayBinding({
        ...futures,
        adapter_slug: 'bingx',
      })
    ).toThrow('locator does not match its adapter variant')
  })

  it('uses own-property closed lookup for unknown and prototype property names', () => {
    for (const adapterSlug of ['future_adapter', '__proto__', 'constructor', 'toString']) {
      expect(() => selectCopierCandidateLocatorContract(adapterSlug, 'futures')).toThrow(
        `adapter ${adapterSlug} is not registered`
      )
      expect(() =>
        deriveCopierCandidateReplayBinding(source(adapterSlug, { slug: 'safe_source' }))
      ).toThrow(`adapter ${adapterSlug} is not registered`)
    }
  })

  it('rejects an unretained locator version without consulting the active selector', () => {
    const binding = deriveCopierCandidateReplayBinding(source('bingx'))
    expect(() =>
      revalidateCopierCandidateReplayBinding({
        ...binding,
        candidate_locator_contract: 'arena.ingest.copier-candidate-locator.bingx@2',
      })
    ).toThrow('locator contract is not retained')
  })

  it('rejects accessors, hidden fields, exotic prototypes, and extra binding fields', () => {
    const valid = deriveCopierCandidateReplayBinding(source('bingx'))
    let reads = 0
    const accessor = { ...valid }
    Object.defineProperty(accessor, 'adapter_slug', {
      enumerable: true,
      get() {
        reads += 1
        return 'bingx'
      },
    })
    expect(() => revalidateCopierCandidateReplayBinding(accessor)).toThrow('object accessors')
    expect(reads).toBe(0)

    const hidden = { ...valid }
    Object.defineProperty(hidden, 'hidden', { enumerable: false, value: true })
    expect(() => revalidateCopierCandidateReplayBinding(hidden)).toThrow(
      'non-enumerable object properties'
    )
    expect(() => revalidateCopierCandidateReplayBinding({ ...valid, unreviewed: true })).toThrow(
      'violates its contract'
    )
    const exotic = Object.assign(Object.create({ inherited: true }) as Dict, { ...valid })
    expect(() => revalidateCopierCandidateReplayBinding(exotic)).toThrow('non-plain objects')

    const liveAccessor = source('bingx')
    Object.defineProperty(liveAccessor, 'adapter_slug', {
      enumerable: true,
      get() {
        throw new Error('must not execute')
      },
    })
    expect(() => deriveCopierCandidateReplayBinding(liveAccessor)).toThrow('object accessors')
  })

  it('rebuilds and exact-revalidates a candidate ledger from artifact coordinates', () => {
    const src = source('bingx')
    const binding = deriveCopierCandidateReplayBinding(src)
    const pages = [
      page(shape('bingx').payload([{ uid: 'a' }]), 1),
      page(shape('bingx').payload([{ uid: 'b' }, { uid: 'b' }]), 2),
    ]
    const live = buildCopierCandidateLedger({ src, exchangeTraderId, pages })
    const replayed = buildCopierCandidateLedgerFromReplayBinding({
      binding,
      source: { id: src.id, slug: src.slug },
      exchangeTraderId,
      pages,
    })
    expect(replayed).toEqual(live)
    expect(Object.isFrozen(replayed)).toBe(true)
    expect(Object.isFrozen(replayed.pages[1].occurrences[1])).toBe(true)
    expect(
      revalidateCopierCandidateLedgerFromReplayBinding({
        binding,
        source: { id: src.id, slug: src.slug },
        exchangeTraderId,
        pages,
        ledger: replayed,
      })
    ).toEqual(replayed)

    const drifted = JSON.parse(JSON.stringify(replayed)) as typeof replayed
    drifted.source.slug = 'another_source'
    expect(() =>
      revalidateCopierCandidateLedgerFromReplayBinding({
        binding,
        source: { id: src.id, slug: src.slug },
        exchangeTraderId,
        pages,
        ledger: drifted,
      })
    ).toThrow('does not match replayed RAW pages')
    expect(() =>
      buildCopierCandidateLedgerFromReplayBinding({
        binding,
        source: { id: src.id, slug: src.slug, extra: true } as never,
        exchangeTraderId,
        pages,
      })
    ).toThrow('violates its contract')
  })
})

describe('copier parser multiset conservation', () => {
  const selected = shape('bingx')
  const duplicate = { uid: 'same', pnl: 1 }
  const distinct = { uid: 'other', pnl: 2 }

  function ledger(candidates: Dict[] = [duplicate, duplicate, distinct]) {
    return buildCopierCandidateLedger({
      src: source('bingx'),
      exchangeTraderId,
      pages: [page(selected.payload(candidates))],
    })
  }

  it('preserves duplicate multiplicity and permits parser row reordering', () => {
    const built = ledger()
    const proof = verifyCopierParserConservation({
      ledger: built,
      rows: [copierRow(distinct, 0), copierRow(duplicate, 1), copierRow(duplicate, 2)],
    })
    expect(proof.parsed_row_count).toBe(3)
    expect(proof.rows.map((row) => row.raw_candidate_sha256)).toEqual([
      strictCanonicalSha256(distinct),
      strictCanonicalSha256(duplicate),
      strictCanonicalSha256(duplicate),
    ])
    expect(Object.isFrozen(proof.rows)).toBe(true)
  })

  it.each([
    ['an omitted candidate', [copierRow(duplicate), copierRow(distinct)]],
    [
      'a fabricated candidate',
      [copierRow(duplicate, 0), copierRow(duplicate, 1), copierRow({ uid: 'fabricated' }, 2)],
    ],
    [
      'a duplicate multiplicity mismatch',
      [copierRow(duplicate, 0), copierRow(distinct, 1), copierRow(distinct, 2)],
    ],
    [
      'a transformed RAW candidate',
      [copierRow(duplicate, 0), copierRow(duplicate, 1), copierRow({ ...distinct, parent: 1 }, 2)],
    ],
  ])('fails closed for %s', (_reason, rows) => {
    expect(() => verifyCopierParserConservation({ ledger: ledger(), rows })).toThrow(
      'do not conserve the captured candidate multiset'
    )
  })

  it('rejects a non-copier parser row', () => {
    const wrongKind = {
      kind: 'orders',
      ts: '2026-08-03T12:00:00.000Z',
      orderKind: null,
      symbol: null,
      side: null,
      price: null,
      qty: null,
      dedupeHash: 'wrong',
      raw: duplicate,
    } satisfies ParsedHistoryRow
    expect(() =>
      verifyCopierParserConservation({ ledger: ledger([duplicate]), rows: [wrongKind] })
    ).toThrow('row kind does not match copiers')
  })

  it('is deterministic across pages and strict-canonical object key order', () => {
    const left = buildCopierCandidateLedger({
      src: source('bingx'),
      exchangeTraderId,
      pages: [
        page(selected.payload([{ uid: 'a', pnl: 1 }]), 1),
        page(selected.payload([{ uid: 'b', pnl: 2 }]), 2),
      ],
    })
    const right = buildCopierCandidateLedger({
      src: source('bingx'),
      exchangeTraderId,
      pages: [
        page(selected.payload([{ pnl: 1, uid: 'a' }]), 1),
        page(selected.payload([{ pnl: 2, uid: 'b' }]), 2),
      ],
    })
    expect(right).toEqual(left)
    expect(strictCanonicalSha256(right)).toBe(strictCanonicalSha256(left))
    expect(Object.isFrozen(left.pages[0].occurrences[0])).toBe(true)
  })

  it('replays RAW and rejects a fully self-consistent omitted occurrence ledger', () => {
    const built = ledger([duplicate, distinct])
    const forged = JSON.parse(JSON.stringify(built)) as typeof built
    forged.pages[0].occurrences.pop()
    forged.pages[0].candidate_count = 1
    forged.observed_candidate_count = 1
    forged.candidate_multiset_sha256 = strictCanonicalSha256({
      contract: COPIER_CANDIDATE_MULTISET_CONTRACT,
      candidate_count: 1,
      raw_candidate_sha256: [strictCanonicalSha256(duplicate)],
    })

    expect(() =>
      revalidateCopierCandidateLedger({
        src: source('bingx'),
        exchangeTraderId,
        pages: [page(selected.payload([duplicate, distinct]))],
        ledger: forged,
      })
    ).toThrow('does not match replayed RAW pages')
  })
})
