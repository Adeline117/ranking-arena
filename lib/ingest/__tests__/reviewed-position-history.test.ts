import {
  BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT,
  BINANCE_POSITION_HISTORY_URL,
} from '@/lib/ingest/adapters/binance/history-contract'
import { dedupeHash as binanceDedupeHash } from '@/lib/ingest/adapters/binance/parsers'
import { binancePositionHistoryTerminalVerifier } from '@/lib/ingest/adapters/binance/history-terminal'
import {
  BITGET_HISTORY_PAGE_ENVELOPE_CONTRACT,
  BITGET_POSITION_HISTORY_URL,
  bitgetPositionHistoryTerminalVerifier,
} from '@/lib/ingest/adapters/bitget/history-terminal'
import { okxPositionHistoryTerminalVerifier } from '@/lib/ingest/adapters/okx/history-terminal'
import { dedupeHash as okxDedupeHash } from '@/lib/ingest/adapters/okx/parsers'
import type { ParsedPositionHistoryRow, RawPage } from '@/lib/ingest/core/types'
import {
  captureHistoryAcquisition,
  HISTORY_TERMINAL_CLAIM_CONTRACT,
  type CapturedHistoryAcquisition,
  type HistoryTerminalClaim,
  type SelectedHistoryTerminalVerifier,
} from '@/lib/ingest/history-acquisition'
import {
  canonicalPositionHistoryCandidateValues,
  canonicalPositionHistoryTimestamp,
  canonicalPositionHistoryText,
  POSITION_HISTORY_TEXT_LIMITS,
  positionHistorySourceEpochTimestamp,
} from '@/lib/ingest/position-history-publication-values'
import {
  assertPostgresJsonbTextCompatible,
  assertReviewedPositionHistoryCurrency,
  buildReviewedPositionHistoryEvidence,
  POSITION_HISTORY_PAGE_MANIFEST_KEYS,
  POSITION_HISTORY_PUBLICATION_EVIDENCE_CONTRACT,
  POSITION_HISTORY_RAW_META_KEYS,
  POSITION_HISTORY_SOURCE_ROW_MANIFEST_KEYS,
  positionHistoryPublicationRawMeta,
  REVIEWED_POSITION_HISTORY_CONTRACTS,
  reviewedPositionHistoryRejectionCode,
} from '@/lib/ingest/reviewed-position-history'
import { strictCanonicalSha256 } from '@/lib/ingest/strict-canonical-json'

const attemptStartedAt = '2026-08-03T08:30:00.000Z'
const openedAt = '2026-08-03T08:45:00.000Z'
const closedAt = '2026-08-03T09:00:00.000Z'
const fetchedAt = '2026-08-03T10:00:00.000Z'
const openedMs = String(Date.parse(openedAt))
const closedMs = String(Date.parse(closedAt))
const traderId = 41
const exchangeTraderId = 'leader-1'

function terminalClaim(observations: HistoryTerminalClaim['observations']): HistoryTerminalClaim {
  return { contract: HISTORY_TERMINAL_CLAIM_CONTRACT, observations }
}

async function capture(
  source: { id: number; slug: string },
  pages: RawPage[],
  claim: HistoryTerminalClaim,
  verifier: SelectedHistoryTerminalVerifier,
  capturedExchangeTraderId = exchangeTraderId,
  capturedAttemptStartedAt = attemptStartedAt
): Promise<CapturedHistoryAcquisition> {
  async function* stream(): AsyncGenerator<RawPage, HistoryTerminalClaim, void> {
    for (const page of pages) yield page
    return claim
  }
  return captureHistoryAcquisition({
    source,
    traderId,
    exchangeTraderId: capturedExchangeTraderId,
    kind: 'position_history',
    cursor: null,
    attemptStartedAt: capturedAttemptStartedAt,
    stream: stream(),
    terminalVerifier: verifier,
  })
}

function bitgetRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orderNo: 'order-1',
    openTime: openedMs,
    closeTime: closedMs,
    symbolDisplayName: 'BTCUSDT',
    tokenId: 'USDT',
    position: 1,
    openLevel: '5',
    closeDealCount: '2',
    openAvgPrice: '100',
    closeAvgPrice: '110',
    netProfit: '20',
    returnRate: '0.2',
    ...overrides,
  }
}

async function bitgetCapture(
  rows: readonly Record<string, unknown>[] = [bitgetRaw()],
  verifier: SelectedHistoryTerminalVerifier = bitgetPositionHistoryTerminalVerifier,
  capturedExchangeTraderId = exchangeTraderId,
  capturedFetchedAt = fetchedAt,
  capturedAttemptStartedAt = attemptStartedAt
): Promise<CapturedHistoryAcquisition> {
  return capture(
    { id: 7, slug: 'bitget_futures' },
    [
      {
        pageIndex: 1,
        url: BITGET_POSITION_HISTORY_URL,
        fetchedAt: capturedFetchedAt,
        payload: {
          contract: BITGET_HISTORY_PAGE_ENVELOPE_CONTRACT,
          historyTraderIdentity: capturedExchangeTraderId,
          request: { pageNo: 1, pageSize: 20, traderUid: capturedExchangeTraderId },
          response: { code: '00000', data: { rows, nextFlag: false } },
        },
      },
    ],
    terminalClaim([{ segment_id: 'default', reason: 'reported_end', page_ordinal: 1 }]),
    verifier,
    capturedExchangeTraderId,
    capturedAttemptStartedAt
  )
}

async function binanceCapture(
  overrides: Record<string, unknown> = {},
  capturedExchangeTraderId = exchangeTraderId
): Promise<CapturedHistoryAcquisition> {
  const raw = {
    id: Number(openedMs),
    symbol: 'BTCUSDT',
    type: 'UM',
    side: 'Long',
    status: 'All Closed',
    opened: Number(openedMs),
    closed: Number(closedMs),
    leverage: '5',
    closedVolume: '2',
    avgCost: '100',
    avgClosePrice: '110',
    closingPnl: '20',
    roi: '0.2',
    ...overrides,
  }
  const page = (sort: 'CLOSING' | 'OPENING', at: string): RawPage => ({
    pageIndex: 1,
    url: BINANCE_POSITION_HISTORY_URL,
    fetchedAt: at,
    payload: {
      contract: BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT,
      portfolioId: capturedExchangeTraderId,
      request: { pageNumber: 1, pageSize: 50, portfolioId: capturedExchangeTraderId, sort },
      response: { code: '000000', success: true, data: { list: [raw], total: 1 } },
      sort,
    },
  })
  return capture(
    { id: 8, slug: 'binance_futures' },
    [page('CLOSING', fetchedAt), page('OPENING', '2026-08-03T10:00:01.000Z')],
    terminalClaim([
      { segment_id: 'closing', reason: 'reported_end', page_ordinal: 1 },
      { segment_id: 'opening', reason: 'reported_end', page_ordinal: 2 },
    ]),
    binancePositionHistoryTerminalVerifier,
    capturedExchangeTraderId
  )
}

async function okxCapture(
  overrides: Record<string, unknown> = {},
  capturedExchangeTraderId = exchangeTraderId
): Promise<CapturedHistoryAcquisition> {
  const raw: Record<string, unknown> = {
    subPosId: 'sub-position-1',
    instId: 'BTC-USDT-SWAP',
    ccy: 'USDT',
    posSide: 'long',
    instType: 'SWAP',
    uniqueCode: capturedExchangeTraderId,
    openTime: openedMs,
    closeTime: closedMs,
    lever: '5',
    subPos: '2',
    openAvgPx: '100',
    closeAvgPx: '110',
    pnl: '20',
    pnlRatio: '0.2',
    ...overrides,
  }
  if (Object.hasOwn(overrides, 'ccy') && overrides.ccy === undefined) delete raw.ccy
  return okxRowsCapture([raw], capturedExchangeTraderId)
}

async function okxRowsCapture(
  rows: readonly Record<string, unknown>[],
  capturedExchangeTraderId: string
): Promise<CapturedHistoryAcquisition> {
  const firstUrl =
    'https://www.okx.com/api/v5/copytrading/public-subpositions-history?' +
    `instType=SWAP&limit=100&uniqueCode=${encodeURIComponent(capturedExchangeTraderId)}`
  const lastSubPositionId = rows.at(-1)?.subPosId
  return capture(
    { id: 9, slug: 'okx_futures' },
    [
      {
        pageIndex: 1,
        url: firstUrl,
        fetchedAt,
        payload: { historyTraderIdentity: capturedExchangeTraderId, data: rows },
      },
      {
        pageIndex: 2,
        url: `${firstUrl}&after=${encodeURIComponent(String(lastSubPositionId))}`,
        fetchedAt: '2026-08-03T10:00:01.000Z',
        payload: { historyTraderIdentity: capturedExchangeTraderId, data: [] },
      },
    ],
    terminalClaim([{ segment_id: 'default', reason: 'empty_page', page_ordinal: 2 }]),
    okxPositionHistoryTerminalVerifier,
    capturedExchangeTraderId
  )
}

function exactPublicationMeta(captured: CapturedHistoryAcquisition) {
  const evidence = buildReviewedPositionHistoryEvidence(captured.artifact, captured.sourceRunId)
  const rawIntegrity = { serialization_contract: 'arena.strict-canonical-json@1' }
  return {
    evidence,
    meta: positionHistoryPublicationRawMeta(evidence, rawIntegrity),
  }
}

describe('shared reviewed position-history evidence contract', () => {
  it.each([
    ['Bitget', bitgetCapture],
    ['Binance', binanceCapture],
    ['OKX', okxCapture],
  ] as const)('builds exact publication RAW metadata for reviewed %s', async (_label, make) => {
    const captured = await make()
    const { evidence, meta } = exactPublicationMeta(captured)

    expect(Object.keys(meta).sort()).toEqual(POSITION_HISTORY_RAW_META_KEYS)
    expect(meta).toMatchObject({
      history_evidence_contract: POSITION_HISTORY_PUBLICATION_EVIDENCE_CONTRACT,
      history_kind: 'position_history',
      source_run_id: captured.sourceRunId,
      page_count: captured.artifact.pages.length,
      verifier_contract: evidence.contract.verifier.contract,
      parser_contract: evidence.contract.parserContract,
      source_contract: evidence.contract.sourceContract,
    })
    for (const [pageIndex, page] of evidence.pageManifest.entries()) {
      expect(Object.keys(page).sort()).toEqual(POSITION_HISTORY_PAGE_MANIFEST_KEYS)
      expect(page).toMatchObject({
        ordinal: pageIndex + 1,
        payload_sha256: captured.artifact.pages[pageIndex].payload_sha256,
        stored_page_index: captured.artifact.pages[pageIndex].stored_page_index,
      })
      for (const [rowIndex, sourceRow] of page.source_rows.entries()) {
        expect(Object.keys(sourceRow).sort()).toEqual(POSITION_HISTORY_SOURCE_ROW_MANIFEST_KEYS)
        expect(sourceRow.source_row_ordinal).toBe(rowIndex + 1)
      }
    }
  })

  it('keeps the captured Binance, Bitget, and OKX USDT fixtures publication-eligible', async () => {
    const binanceFixture = JSON.parse(
      readFileSync(
        join(__dirname, '../adapters/binance/__tests__/fixtures/position-history-closing-p1.json'),
        'utf8'
      )
    ) as { data: { list: Array<Record<string, unknown>> } }
    const bitgetFixture = JSON.parse(
      readFileSync(
        join(__dirname, '../adapters/bitget/__tests__/fixtures/position-history-p1.json'),
        'utf8'
      )
    ) as { data: { rows: Array<Record<string, unknown>> } }
    const okxFixture = JSON.parse(
      readFileSync(join(__dirname, '../adapters/okx/__tests__/fixtures/history-page.json'), 'utf8')
    ) as { data: Array<Record<string, unknown>> }

    const binance = await binanceCapture(binanceFixture.data.list[0])
    const bitget = await bitgetCapture([bitgetFixture.data.rows[0]])
    const okxIdentity = String(okxFixture.data[0].uniqueCode)
    const okx = await okxRowsCapture(okxFixture.data, okxIdentity)

    expect(
      buildReviewedPositionHistoryEvidence(binance.artifact, binance.sourceRunId).canonicalRows
    ).toHaveLength(1)
    expect(
      buildReviewedPositionHistoryEvidence(bitget.artifact, bitget.sourceRunId).canonicalRows
    ).toHaveLength(1)
    const okxEvidence = buildReviewedPositionHistoryEvidence(okx.artifact, okx.sourceRunId)
    expect(okxEvidence.canonicalRows).toHaveLength(2)
    expect(okxEvidence.bindingRows).toHaveLength(3)
    expect(okxEvidence.pageManifest[0].source_rows.map((row) => row.classification)).toEqual([
      'source_partial_omitted',
      'canonical_materialized',
      'canonical_materialized',
    ])
  })

  it('uses one reviewed registry for source, adapter, parser, verifier, page-size, and paths', () => {
    expect(POSITION_HISTORY_PUBLICATION_EVIDENCE_CONTRACT).toBe(
      'arena.position-history-publication-evidence@2'
    )
    expect(REVIEWED_POSITION_HISTORY_CONTRACTS.binance_futures).toMatchObject({
      adapterSlug: 'binance',
      expectedCurrency: 'USDT',
      pageSize: 50,
      servingReturnScale: 100,
      verifier: {
        contract: 'arena.ingest.history-terminal-verifier.binance.position_history@2',
      },
    })
    expect(REVIEWED_POSITION_HISTORY_CONTRACTS.bitget_futures).toMatchObject({
      adapterSlug: 'bitget',
      expectedCurrency: 'USDT',
      pageSize: 20,
      servingReturnScale: 1,
      verifier: {
        contract: 'arena.ingest.history-terminal-verifier.bitget.position_history@2',
      },
    })
    expect(REVIEWED_POSITION_HISTORY_CONTRACTS.okx_futures).toMatchObject({
      adapterSlug: 'okx',
      expectedCurrency: 'USDT',
      pageSize: 100,
      servingReturnScale: 100,
      verifier: {
        contract: 'arena.ingest.history-terminal-verifier.okx.position_history@2',
      },
    })
    expect(REVIEWED_POSITION_HISTORY_CONTRACTS.binance_futures.fieldPaths.sourceFactId).toEqual([
      [
        'portfolioId',
        'response.data.list[].id',
        'response.data.list[].symbol',
        'response.data.list[].side',
      ],
    ])
  })

  it('classifies Binance CLOSING as canonical and OPENING only as verifier evidence', async () => {
    const captured = await binanceCapture()
    const { evidence } = exactPublicationMeta(captured)

    expect(
      evidence.pageManifest.map(({ classification, segment_id }) => ({
        classification,
        segment_id,
      }))
    ).toEqual([
      { classification: 'canonical_materialized', segment_id: 'closing' },
      { classification: 'verifier_only', segment_id: 'opening' },
    ])
    expect(evidence.canonicalRows).toHaveLength(1)
    expect(evidence.canonicalRows[0]).toMatchObject({
      pageOrdinal: 1,
      sourceRowOrdinal: 1,
    })
    expect(evidence.pageManifest[0].source_rows[0].source_row_sha256).toBe(
      strictCanonicalSha256(evidence.canonicalRows[0].row.raw)
    )
    expect(evidence.pageManifest[0].source_rows[0].classification).toBe('canonical_materialized')
    expect(evidence.pageManifest[1].source_rows[0].classification).toBe('verifier_only')
  })

  it('keeps empty reviewed source containers explicit without inventing rows', async () => {
    const captured = await bitgetCapture([])
    const { evidence } = exactPublicationMeta(captured)

    expect(evidence.pageManifest).toHaveLength(1)
    expect(evidence.pageManifest[0]).toMatchObject({
      classification: 'canonical_materialized',
      segment_id: 'default',
      source_rows: [],
    })
    expect(evidence.canonicalRows).toEqual([])
  })

  it('fails a complete Bitget capture whose numeric orderNo is negative', async () => {
    const captured = await bitgetCapture([bitgetRaw({ orderNo: -1 })])

    expect(captured.artifact.termination).toMatchObject({
      evidence_state: 'rejected',
      scan_terminal_state: 'unknown',
      blocker_reasons: ['terminal_claim_rejected'],
    })
    expect(() =>
      buildReviewedPositionHistoryEvidence(captured.artifact, captured.sourceRunId)
    ).toThrow('exact reviewed terminal evidence')
  })

  it.each([
    ['RAW string value', () => bitgetCapture([bitgetRaw({ note: 'unsafe\0value' })])],
    ['RAW object key', () => bitgetCapture([bitgetRaw({ ['unsafe\0key']: 'value' })])],
  ] as const)(
    'rejects a PostgreSQL JSONB-incompatible %s with a fixed code',
    async (_label, make) => {
      const captured = await make()

      try {
        buildReviewedPositionHistoryEvidence(captured.artifact, captured.sourceRunId)
        throw new Error('expected reviewed evidence rejection')
      } catch (cause) {
        expect(reviewedPositionHistoryRejectionCode(cause)).toBe('reviewed_contract_rejected')
        expect(String(cause)).toContain('PostgreSQL JSONB cannot represent')
        expect(String(cause)).not.toContain('unsafe')
      }
    }
  )

  it.each([
    ['hexadecimal', '0x2012a2324a81dd6'],
    ['octal', '0o7117063541236003357'],
    ['binary', '0b1110101001011011001101001101010010001101010001111101011'],
  ] as const)(
    'rejects a %s numeric string with cross-runtime rounding drift',
    async (_label, value) => {
      const captured = await bitgetCapture([bitgetRaw({ returnRate: value })])

      expect(() =>
        buildReviewedPositionHistoryEvidence(captured.artifact, captured.sourceRunId)
      ).toThrow('must use decimal or exponent syntax')
    }
  )

  it.each([
    ['Binance', () => binanceCapture({ roi: '1e-9999' })],
    ['Bitget', () => bitgetCapture([bitgetRaw({ returnRate: '1e-324' })])],
    ['OKX', () => okxCapture({ pnlRatio: '2e-324' })],
  ] as const)('rejects %s nonzero decimal underflow before PG casting', async (_label, make) => {
    const captured = await make()

    expect(() =>
      buildReviewedPositionHistoryEvidence(captured.artifact, captured.sourceRunId)
    ).toThrow('must not underflow a nonzero decimal to zero')
  })

  it.each([
    ['Binance', () => binanceCapture({ roi: String(Number.MAX_VALUE) })],
    ['OKX', () => okxCapture({ pnlRatio: String(Number.MAX_VALUE) })],
  ] as const)(
    'rejects %s source return overflow after applying the serving scale',
    async (_label, make) => {
      const captured = await make()

      expect(() =>
        buildReviewedPositionHistoryEvidence(captured.artifact, captured.sourceRunId)
      ).toThrow('must remain finite after applying the serving return scale')
    }
  )

  it('keeps Bitget Number.MAX_VALUE eligible under its scale-one contract', async () => {
    const captured = await bitgetCapture([bitgetRaw({ returnRate: String(Number.MAX_VALUE) })])
    const evidence = buildReviewedPositionHistoryEvidence(captured.artifact, captured.sourceRunId)

    expect(evidence.canonicalRows[0].row.sourceReturn).toBe(Number.MAX_VALUE)
  })

  it.each([
    ['Binance', () => binanceCapture({ leverage: ' nope ' })],
    ['Bitget', () => bitgetCapture([bitgetRaw({ openLevel: ' nope ' })])],
    ['OKX', () => okxCapture({ lever: ' nope ' })],
  ] as const)('rejects %s parser-null numeric text with edge whitespace', async (_label, make) => {
    const captured = await make()

    expect(() =>
      buildReviewedPositionHistoryEvidence(captured.artifact, captured.sourceRunId)
    ).toThrow('edge whitespace')
  })

  it.each([
    ['radix side', { position: '0x3' }, 'must use decimal or exponent syntax'],
    ['negative-zero epoch', { openTime: '-0' }, 'must not be negative zero'],
  ] as const)(
    'rejects a parser-null Bitget %s using the RAW spelling',
    async (_label, overrides, message) => {
      const captured = await bitgetCapture([bitgetRaw(overrides)])

      expect(() =>
        buildReviewedPositionHistoryEvidence(captured.artifact, captured.sourceRunId)
      ).toThrow(message)
    }
  )

  it.each([
    ['Binance', () => binanceCapture({ leverage: 'not-a-number' })],
    ['Bitget', () => bitgetCapture([bitgetRaw({ openLevel: 'not-a-number' })])],
    ['OKX', () => okxCapture({ lever: 'not-a-number' })],
  ] as const)(
    'keeps ordinary invalid %s numeric text publishable as null',
    async (_label, make) => {
      const captured = await make()
      const evidence = buildReviewedPositionHistoryEvidence(captured.artifact, captured.sourceRunId)

      expect(evidence.canonicalRows[0].row.leverage).toBeNull()
    }
  )

  it.each([
    ['string', `${Date.parse(closedAt)}.5`],
    ['number', Date.parse(closedAt) + 0.5],
  ] as const)('rejects a fractional epoch %s outside the terminal domain', (_label, value) => {
    expect(positionHistorySourceEpochTimestamp(value)).toBeNull()
  })

  it.each([
    ['openTime string', 'openTime', `${Date.parse(openedAt)}.5`],
    ['openTime number', 'openTime', Date.parse(openedAt) + 0.5],
    ['closeTime string', 'closeTime', `${Date.parse(closedAt)}.5`],
    ['closeTime number', 'closeTime', Date.parse(closedAt) + 0.5],
  ] as const)(
    'rejects a parser-normalized fractional Bitget %s at the shared candidate gate',
    async (_label, rawField, value) => {
      const captured = await bitgetCapture()
      const evidence = buildReviewedPositionHistoryEvidence(captured.artifact, captured.sourceRunId)
      const baseline = evidence.canonicalRows[0].row
      const row: ParsedPositionHistoryRow = {
        ...baseline,
        ...(rawField === 'closeTime' ? { sourceLifecycleMarker: String(value) } : {}),
        raw: { ...baseline.raw, [rawField]: value },
      }
      const errorFactory = (detail: string) => new Error(detail)

      expect(() =>
        canonicalPositionHistoryCandidateValues(
          'bitget_futures',
          1,
          row,
          fetchedAt,
          evidence.observedAt,
          errorFactory
        )
      ).toThrow('must match a positive safe-integer RAW epoch')
    }
  )

  it('accepts mathematical zero with a large exponent and bounds every numeric string', async () => {
    const mathematicalZero = await bitgetCapture([bitgetRaw({ returnRate: '0e-9999' })])
    expect(() =>
      buildReviewedPositionHistoryEvidence(mathematicalZero.artifact, mathematicalZero.sourceRunId)
    ).not.toThrow()

    const atMaximum = await bitgetCapture([bitgetRaw({ returnRate: `0.${'0'.repeat(126)}` })])
    expect(() =>
      buildReviewedPositionHistoryEvidence(atMaximum.artifact, atMaximum.sourceRunId)
    ).not.toThrow()

    const overMaximum = await bitgetCapture([bitgetRaw({ returnRate: `0.${'0'.repeat(127)}` })])
    expect(() =>
      buildReviewedPositionHistoryEvidence(overMaximum.artifact, overMaximum.sourceRunId)
    ).toThrow('exceeds 128 characters')
  })

  it('counts PostgreSQL characters rather than UTF-16 code units at text and numeric limits', async () => {
    const errorFactory = (detail: string) => new Error(detail)
    expect(canonicalPositionHistoryText('🚀'.repeat(64), 'side', 1, 64, errorFactory)).toBe(
      '🚀'.repeat(64)
    )
    expect(() =>
      canonicalPositionHistoryText('🚀'.repeat(65), 'side', 1, 64, errorFactory)
    ).toThrow('1-64')

    const numericAtMaximum = await bitgetCapture([bitgetRaw({ openLevel: '🚀'.repeat(128) })])
    const evidence = buildReviewedPositionHistoryEvidence(
      numericAtMaximum.artifact,
      numericAtMaximum.sourceRunId
    )
    expect(evidence.canonicalRows[0].row.leverage).toBeNull()

    const numericOverMaximum = await bitgetCapture([bitgetRaw({ openLevel: '🚀'.repeat(129) })])
    expect(() =>
      buildReviewedPositionHistoryEvidence(
        numericOverMaximum.artifact,
        numericOverMaximum.sourceRunId
      )
    ).toThrow('exceeds 128 characters')
  })

  it('keeps the shared lifecycle text bound exact at maximum and maximum plus one', () => {
    const { minimum, maximum } = POSITION_HISTORY_TEXT_LIMITS.sourceLifecycleMarker
    const errorFactory = (detail: string) => new Error(detail)

    expect(
      canonicalPositionHistoryText(
        'l'.repeat(maximum),
        'sourceLifecycleMarker',
        minimum,
        maximum,
        errorFactory
      )
    ).toHaveLength(maximum)
    expect(() =>
      canonicalPositionHistoryText(
        'l'.repeat(maximum + 1),
        'sourceLifecycleMarker',
        minimum,
        maximum,
        errorFactory
      )
    ).toThrow('1-256')
  })

  it('rejects JavaScript year zero before PostgreSQL timestamp casting', () => {
    const errorFactory = (detail: string) => new Error(detail)

    for (const timestamp of ['0001-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z']) {
      expect(
        canonicalPositionHistoryTimestamp(timestamp, 'candidate timestamp', errorFactory)
      ).toBe(timestamp)
    }
    expect(new Date(Date.parse('0000-01-01T00:00:00.000Z')).toISOString()).toBe(
      '0000-01-01T00:00:00.000Z'
    )
    expect(() =>
      canonicalPositionHistoryTimestamp(
        '0000-01-01T00:00:00.000Z',
        'candidate timestamp',
        errorFactory
      )
    ).toThrow('canonical millisecond UTC timestamp')
  })

  it('rejects a year-zero acquisition clock before reviewed evidence construction', async () => {
    const yearZero = '0000-01-01T00:00:00.000Z'
    await expect(
      bitgetCapture(
        [bitgetRaw()],
        bitgetPositionHistoryTerminalVerifier,
        exchangeTraderId,
        yearZero,
        yearZero
      )
    ).rejects.toThrow('must be a canonical ISO timestamp')
  })

  it.each([
    ['with canonical rows', [bitgetRaw()]],
    ['for an empty verified capture', []],
  ] as const)(
    'rejects a NUL exchange identity %s before metadata construction',
    async (_label, rows) => {
      const captured = await bitgetCapture(
        rows,
        bitgetPositionHistoryTerminalVerifier,
        'leader\0identity'
      )

      try {
        buildReviewedPositionHistoryEvidence(captured.artifact, captured.sourceRunId)
        throw new Error('expected reviewed evidence rejection')
      } catch (cause) {
        expect(reviewedPositionHistoryRejectionCode(cause)).toBe('reviewed_contract_rejected')
        expect(String(cause)).toContain('PostgreSQL JSONB cannot represent')
        expect(String(cause)).not.toContain('leader')
      }
    }
  )

  it.each([
    ['tab-prefixed returnRate', { returnRate: '\t0.2' }, 'edge whitespace'],
    ['NBSP-prefixed leverage', { openLevel: '\u00a05' }, 'edge whitespace'],
    ['negative-zero returnRate', { returnRate: '-0' }, 'negative zero'],
    ['tab-prefixed numeric side', { position: '\t1' }, 'edge whitespace'],
  ] as const)(
    'rejects a parser-consumed %s before it becomes publication evidence',
    async (_label, overrides, message) => {
      const captured = await bitgetCapture([bitgetRaw(overrides)])

      expect(() =>
        buildReviewedPositionHistoryEvidence(captured.artifact, captured.sourceRunId)
      ).toThrow(message)
    }
  )

  it.each([
    ['Bitget symbol', () => bitgetCapture([bitgetRaw({ symbolDisplayName: ' BTCUSDT ' })])],
    ['Bitget non-string symbol', () => bitgetCapture([bitgetRaw({ symbolDisplayName: 7 })])],
    ['OKX posSide', () => okxCapture({ posSide: '\tlong' })],
  ] as const)('rejects a parser-reachable noncanonical %s', async (_label, make) => {
    const captured = await make()

    expect(() =>
      buildReviewedPositionHistoryEvidence(captured.artifact, captured.sourceRunId)
    ).toThrow()
  })

  it.each([
    ['Binance tab-prefixed roi', () => binanceCapture({ roi: '\t0.2' })],
    ['OKX NBSP-prefixed pnlRatio', () => okxCapture({ pnlRatio: '\u00a00.2' })],
  ] as const)('applies consumed numeric string rules to %s', async (_label, make) => {
    const captured = await make()

    expect(() =>
      buildReviewedPositionHistoryEvidence(captured.artifact, captured.sourceRunId)
    ).toThrow('edge whitespace')
  })

  it.each(['long', 'BUY', 'İ'] as const)(
    'rejects Binance position-history side %s outside exact Long/Short',
    async (side) => {
      const captured = await binanceCapture({ side })

      expect(() =>
        buildReviewedPositionHistoryEvidence(captured.artifact, captured.sourceRunId)
      ).toThrow('side must be exact Long or Short')
    }
  )

  it('rejects every side of a cross-field Binance delimiter collision', async () => {
    const first = {
      trader: exchangeTraderId,
      raw: { id: 1, opened: 1, symbol: '2|BTCUSDT' },
    }
    const second = {
      trader: `${exchangeTraderId}|1`,
      raw: { id: 2, opened: 2, symbol: 'BTCUSDT' },
    }
    expect(binanceDedupeHash('binance_ph', first.trader, 1, first.raw.symbol, 'Long')).toBe(
      binanceDedupeHash('binance_ph', second.trader, 2, second.raw.symbol, 'Long')
    )

    for (const candidate of [first, second]) {
      const captured = await binanceCapture(candidate.raw, candidate.trader)
      expect(() =>
        buildReviewedPositionHistoryEvidence(captured.artifact, captured.sourceRunId)
      ).toThrow('dedupe identity components must not contain the legacy delimiter')
    }
  })

  it('rejects every side of a cross-field OKX delimiter collision', async () => {
    const first = { trader: exchangeTraderId, subPositionId: 'sub|position' }
    const second = { trader: `${exchangeTraderId}|sub`, subPositionId: 'position' }
    expect(okxDedupeHash('okx_ph', first.trader, first.subPositionId)).toBe(
      okxDedupeHash('okx_ph', second.trader, second.subPositionId)
    )

    for (const candidate of [first, second]) {
      const captured = await okxCapture({ subPosId: candidate.subPositionId }, candidate.trader)
      expect(() =>
        buildReviewedPositionHistoryEvidence(captured.artifact, captured.sourceRunId)
      ).toThrow('dedupe identity components must not contain the legacy delimiter')
    }
  })

  it.each([
    ['string id', { id: openedMs }],
    ['id/opened mismatch', { id: Number(openedMs) + 1 }],
  ] as const)(
    'rejects Binance %s outside the reviewed source identity contract',
    async (_label, overrides) => {
      const captured = await binanceCapture(overrides)

      expect(() =>
        buildReviewedPositionHistoryEvidence(captured.artifact, captured.sourceRunId)
      ).toThrow('id and opened must be equal positive safe-integer JSON numbers')
    }
  )

  it.each([
    [
      'openedAt after closedAt',
      () =>
        bitgetCapture([bitgetRaw({ openTime: String(Date.parse('2026-08-03T09:30:00.000Z')) })]),
      'openedAt must not follow closedAt',
    ],
    [
      'closedAt after its page fetch',
      () =>
        bitgetCapture([bitgetRaw({ closeTime: String(Date.parse('2026-08-03T11:00:00.000Z')) })]),
      'closedAt must not follow its bound page fetchedAt',
    ],
    [
      'an extended-year openedAt',
      () =>
        bitgetCapture([bitgetRaw({ openTime: String(Date.parse('+010000-01-01T00:00:00.000Z')) })]),
      'openedAt must be a canonical millisecond UTC timestamp',
    ],
  ] as const)('rejects %s at the reviewed boundary', async (_label, make, message) => {
    const captured = await make()

    expect(() =>
      buildReviewedPositionHistoryEvidence(captured.artifact, captured.sourceRunId)
    ).toThrow(message)
  })

  it.each([
    [
      'symbol',
      () => bitgetCapture([bitgetRaw({ symbolDisplayName: 'S'.repeat(128) })]),
      () => bitgetCapture([bitgetRaw({ symbolDisplayName: 'S'.repeat(129) })]),
      '1-128',
    ],
    [
      'sourceFactId',
      () => bitgetCapture([bitgetRaw({ orderNo: 'o'.repeat(1024) })]),
      () => bitgetCapture([bitgetRaw({ orderNo: 'o'.repeat(1025) })]),
      '1-1024',
    ],
    [
      'exchange identity',
      () => bitgetCapture([bitgetRaw()], bitgetPositionHistoryTerminalVerifier, 'i'.repeat(512)),
      () => bitgetCapture([bitgetRaw()], bitgetPositionHistoryTerminalVerifier, 'i'.repeat(513)),
      '1-512',
    ],
  ] as const)(
    'accepts the %s maximum and rejects maximum plus one',
    async (_label, atMaximum, overMaximum, message) => {
      const accepted = await atMaximum()
      expect(() =>
        buildReviewedPositionHistoryEvidence(accepted.artifact, accepted.sourceRunId)
      ).not.toThrow()

      const rejected = await overMaximum()
      expect(() =>
        buildReviewedPositionHistoryEvidence(rejected.artifact, rejected.sourceRunId)
      ).toThrow(message)
    }
  )

  it.each([
    [
      'Bitget missing tokenId',
      async () => {
        const raw = bitgetRaw()
        delete raw.tokenId
        return bitgetCapture([raw])
      },
      'canonical row currency must be exact USDT',
    ],
    [
      'Bitget drifted tokenId',
      () => bitgetCapture([bitgetRaw({ tokenId: 'USDC' })]),
      'canonical row currency must be exact USDT',
    ],
    [
      'Bitget non-string tokenId',
      () => bitgetCapture([bitgetRaw({ tokenId: 7 })]),
      'canonical row currency must be exact USDT',
    ],
    ['OKX missing ccy', () => okxCapture({ ccy: undefined }), 'exact reviewed terminal evidence'],
    ['OKX drifted ccy', () => okxCapture({ ccy: 'USDC' }), 'exact reviewed terminal evidence'],
    ['OKX non-string ccy', () => okxCapture({ ccy: 7 }), 'exact reviewed terminal evidence'],
  ] as const)('rejects %s instead of assuming USDT', async (_label, make, message) => {
    const captured = await make()

    expect(() =>
      buildReviewedPositionHistoryEvidence(captured.artifact, captured.sourceRunId)
    ).toThrow(message)
  })

  it.each([
    ['CM type', { type: 'CM' }],
    ['USDC symbol', { symbol: 'BTCUSDC' }],
    ['empty-base symbol', { symbol: 'USDT' }],
  ] as const)(
    'rejects Binance %s without RAW USDT publication proof',
    async (_label, overrides) => {
      const valid = await binanceCapture()
      const evidence = buildReviewedPositionHistoryEvidence(valid.artifact, valid.sourceRunId)
      const row: ParsedPositionHistoryRow = {
        ...evidence.canonicalRows[0].row,
        raw: { ...evidence.canonicalRows[0].row.raw, ...overrides },
      }

      expect(() =>
        assertReviewedPositionHistoryCurrency(
          REVIEWED_POSITION_HISTORY_CONTRACTS.binance_futures,
          row
        )
      ).toThrow('must be proved by exact UM and USDT symbol suffix')
    }
  )

  it('allows a valid surrogate pair while defensively rejecting isolated surrogates', () => {
    expect(() =>
      assertPostgresJsonbTextCompatible({ 'asset🚀': 'BTC🚀' }, 'candidate')
    ).not.toThrow()
    expect(() => assertPostgresJsonbTextCompatible({ value: '\ud800' }, 'candidate')).toThrow(
      'PostgreSQL JSONB cannot represent'
    )
    expect(() => assertPostgresJsonbTextCompatible('leader\ud800', 'identity')).toThrow(
      'PostgreSQL JSONB cannot represent'
    )
    expect(() =>
      assertPostgresJsonbTextCompatible({ ['bad\udc00key']: 'value' }, 'candidate')
    ).toThrow('PostgreSQL JSONB cannot represent')
  })

  it('rejects malformed containers and unreviewed verifier claims for publication metadata', async () => {
    const missingSymbol = bitgetRaw()
    delete missingSymbol.symbolDisplayName
    const malformed = await bitgetCapture([missingSymbol])
    expect(() =>
      buildReviewedPositionHistoryEvidence(malformed.artifact, malformed.sourceRunId)
    ).toThrow('did not account for every source candidate')

    const fakeVerifier: SelectedHistoryTerminalVerifier = {
      contract: 'arena.ingest.history-terminal-verifier.fake.position_history@1',
      verify: () => ({ verified: true, scanTerminalState: 'exhausted' }),
    }
    const unverified = await bitgetCapture([bitgetRaw()], fakeVerifier)
    expect(() =>
      buildReviewedPositionHistoryEvidence(unverified.artifact, unverified.sourceRunId)
    ).toThrow('exact reviewed terminal evidence')
  })
})
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
