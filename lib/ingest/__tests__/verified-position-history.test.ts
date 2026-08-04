import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT,
  BINANCE_POSITION_HISTORY_URL,
} from '@/lib/ingest/adapters/binance/history-contract'
import { parseBinanceHistory } from '@/lib/ingest/adapters/binance/parsers'
import { binancePositionHistoryTerminalVerifier } from '@/lib/ingest/adapters/binance/history-terminal'
import { parseBitgetHistory } from '@/lib/ingest/adapters/bitget/parsers'
import {
  BITGET_HISTORY_PAGE_ENVELOPE_CONTRACT,
  BITGET_POSITION_HISTORY_URL,
  bitgetPositionHistoryTerminalVerifier,
} from '@/lib/ingest/adapters/bitget/history-terminal'
import { parseOkxHistory } from '@/lib/ingest/adapters/okx/parsers'
import { okxPositionHistoryTerminalVerifier } from '@/lib/ingest/adapters/okx/history-terminal'
import type {
  ParseCtx,
  ParsedHistoryRow,
  ParsedPositionHistoryRow,
  RawPage,
} from '@/lib/ingest/core/types'
import {
  captureHistoryAcquisition,
  HISTORY_TERMINAL_CLAIM_CONTRACT,
  type CapturedHistoryAcquisition,
  type HistoryTerminalClaim,
  type SelectedHistoryTerminalVerifier,
} from '@/lib/ingest/history-acquisition'
import { buildReviewedPositionHistoryEvidence } from '@/lib/ingest/reviewed-position-history'
import { strictCanonicalJson } from '@/lib/ingest/strict-canonical-json'
import {
  BITGET_POSITION_HISTORY_SOURCE_CONTRACT,
  isPreparedVerifiedPositionHistoryPublication,
  prepareVerifiedPositionHistoryPublication,
  prepareVerifiedPositionHistoryRpcCall,
  PUBLISH_VERIFIED_POSITION_HISTORY_SQL,
  validateVerifiedPositionHistoryPublicationReceipt,
  VERIFIED_POSITION_HISTORY_RPC_PAYLOAD_CONTRACT,
  validateVerifiedPositionHistoryBindingSet,
  type PrepareVerifiedPositionHistoryPublicationInput,
  type PreparedVerifiedPositionHistoryPublication,
} from '@/lib/ingest/verified-position-history'

const attemptStartedAt = '2026-08-03T08:30:00.000Z'
const openedAt = '2026-08-03T08:45:00.000Z'
const closedAt = '2026-08-03T09:00:00.000Z'
const fetchedAt = '2026-08-03T10:00:00.000Z'
const openedMs = String(Date.parse(openedAt))
const closedMs = String(Date.parse(closedAt))
const traderId = 41
const exchangeTraderId = 'leader-1'

const FACT_KEYS = [
  'closed_at',
  'dedupe_hash',
  'entry_price',
  'exit_price',
  'field_sources',
  'leverage',
  'limitations',
  'opened_at',
  'raw',
  'realized_pnl',
  'side',
  'size',
  'source_fact_id',
  'source_lifecycle_marker',
  'source_return',
  'symbol',
] as const

const ROW_BINDING_KEYS = [
  'binding_ordinal',
  'classification',
  'fact_canonical_json',
  'fact_ordinal',
  'fact_sha256',
  'page_fetched_at',
  'page_ordinal',
  'page_payload_sha256',
  'page_stored_index',
  'raw_row_canonical_json',
  'raw_row_sha256',
  'source_row_ordinal',
] as const

const RPC_PAYLOAD_KEYS = [
  'adapter_slug',
  'binding_set_sha256',
  'bindings_canonical_json',
  'contract',
  'exchange_trader_id',
  'history_kind',
  'observed_at',
  'page_count',
  'parser_contract',
  'previous_publication_id',
  'raw_object_id',
  'serialization_contract',
  'source_contract',
  'source_id',
  'source_run_id',
  'source_slug',
  'starting_cursor',
  'trader_id',
] as const

function sha256Utf8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function parseCtx(sourceSlug: string, scrapedAt = fetchedAt): ParseCtx {
  return { sourceSlug, currency: 'USDT', tfLabelMap: {}, scrapedAt, meta: {} }
}

function positionRows(rows: ParsedHistoryRow[]): ParsedPositionHistoryRow[] {
  return rows.filter((row): row is ParsedPositionHistoryRow => row.kind === 'position_history')
}

function terminalClaim(observations: HistoryTerminalClaim['observations']): HistoryTerminalClaim {
  return { contract: HISTORY_TERMINAL_CLAIM_CONTRACT, observations }
}

async function capture(
  source: { id: number; slug: string },
  pages: RawPage[],
  claim: HistoryTerminalClaim,
  verifier: SelectedHistoryTerminalVerifier,
  capturedExchangeTraderId = exchangeTraderId
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
    attemptStartedAt,
    stream: stream(),
    terminalVerifier: verifier,
  })
}

function inputFor(
  captured: CapturedHistoryAcquisition,
  source: PrepareVerifiedPositionHistoryPublicationInput['source'],
  rows: PrepareVerifiedPositionHistoryPublicationInput['rows']
): PrepareVerifiedPositionHistoryPublicationInput {
  return {
    acquisition: captured.artifact,
    previousPublicationId: null,
    rawObject: {
      id: 501,
      storagePath:
        `${source.slug}/history_trust/position_history/${captured.sourceRunId}/` +
        `event_history_${captured.sourceRunId}.json.gz`,
      contentHash: captured.sourceRunId,
    },
    rows,
    source,
    sourceRunId: captured.sourceRunId,
  }
}

function bitgetRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orderNo: 'order-1',
    openTime: openedMs,
    closeTime: closedMs,
    symbolDisplayName: 'BTCUSDT',
    tokenId: 'USDT',
    position: 'long',
    openLevel: '5',
    closeDealCount: '2',
    openAvgPrice: '100',
    closeAvgPrice: '110',
    netProfit: '20',
    returnRate: '0.2',
    ...overrides,
  }
}

async function bitgetInput(
  rawRows: readonly Record<string, unknown>[] = [bitgetRaw()],
  capturedExchangeTraderId = exchangeTraderId
): Promise<PrepareVerifiedPositionHistoryPublicationInput> {
  const captured = await capture(
    { id: 7, slug: 'bitget_futures' },
    [
      {
        pageIndex: 1,
        url: BITGET_POSITION_HISTORY_URL,
        fetchedAt,
        payload: {
          contract: BITGET_HISTORY_PAGE_ENVELOPE_CONTRACT,
          historyTraderIdentity: capturedExchangeTraderId,
          request: { pageNo: 1, pageSize: 20, traderUid: capturedExchangeTraderId },
          response: { code: '00000', data: { rows: rawRows, nextFlag: false } },
        },
      },
    ],
    terminalClaim([{ segment_id: 'default', reason: 'reported_end', page_ordinal: 1 }]),
    bitgetPositionHistoryTerminalVerifier,
    capturedExchangeTraderId
  )
  const rows = positionRows(
    parseBitgetHistory(
      captured.artifact.pages[0].payload,
      'position_history',
      parseCtx('bitget_futures')
    )
  ).map((row, rowIndex) => ({ pageOrdinal: 1, sourceRowOrdinal: rowIndex + 1, row }))
  return inputFor(captured, { id: 7, slug: 'bitget_futures', adapter_slug: 'bitget' }, rows)
}

async function binanceInput(): Promise<PrepareVerifiedPositionHistoryPublicationInput> {
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
  }
  const page = (sort: 'CLOSING' | 'OPENING', at: string): RawPage => ({
    pageIndex: 1,
    url: BINANCE_POSITION_HISTORY_URL,
    fetchedAt: at,
    payload: {
      contract: BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT,
      portfolioId: exchangeTraderId,
      request: { pageNumber: 1, pageSize: 50, portfolioId: exchangeTraderId, sort },
      response: { code: '000000', success: true, data: { list: [raw], total: 1 } },
      sort,
    },
  })
  const captured = await capture(
    { id: 8, slug: 'binance_futures' },
    [page('CLOSING', fetchedAt), page('OPENING', '2026-08-03T10:00:01.000Z')],
    terminalClaim([
      { segment_id: 'closing', reason: 'reported_end', page_ordinal: 1 },
      { segment_id: 'opening', reason: 'reported_end', page_ordinal: 2 },
    ]),
    binancePositionHistoryTerminalVerifier
  )
  const rows = positionRows(
    parseBinanceHistory(
      captured.artifact.pages[0].payload,
      'position_history',
      parseCtx('binance_futures')
    )
  ).map((row, rowIndex) => ({ pageOrdinal: 1, sourceRowOrdinal: rowIndex + 1, row }))
  return inputFor(captured, { id: 8, slug: 'binance_futures', adapter_slug: 'binance' }, rows)
}

async function okxInput(): Promise<PrepareVerifiedPositionHistoryPublicationInput> {
  const raw = {
    subPosId: 'sub-position-1',
    instId: 'BTC-USDT-SWAP',
    ccy: 'USDT',
    instType: 'SWAP',
    posSide: 'long',
    openTime: openedMs,
    closeTime: closedMs,
    lever: '5',
    subPos: '2',
    openAvgPx: '100',
    closeAvgPx: '110',
    pnl: '20',
    pnlRatio: '0.2',
    uniqueCode: exchangeTraderId,
  }
  const firstUrl =
    'https://www.okx.com/api/v5/copytrading/public-subpositions-history?' +
    `instType=SWAP&limit=100&uniqueCode=${exchangeTraderId}`
  const secondUrl = `${firstUrl}&after=sub-position-1`
  const captured = await capture(
    { id: 9, slug: 'okx_futures' },
    [
      {
        pageIndex: 1,
        url: firstUrl,
        fetchedAt,
        payload: { historyTraderIdentity: exchangeTraderId, data: [raw] },
      },
      {
        pageIndex: 2,
        url: secondUrl,
        fetchedAt: '2026-08-03T10:00:01.000Z',
        payload: { historyTraderIdentity: exchangeTraderId, data: [] },
      },
    ],
    terminalClaim([{ segment_id: 'default', reason: 'empty_page', page_ordinal: 2 }]),
    okxPositionHistoryTerminalVerifier
  )
  const rows = captured.artifact.pages.flatMap((page, pageIndex) =>
    positionRows(
      parseOkxHistory(page.payload, 'position_history', parseCtx('okx_futures', page.fetched_at))
    ).map((row, rowIndex) => ({
      pageOrdinal: pageIndex + 1,
      sourceRowOrdinal: rowIndex + 1,
      row,
    }))
  )
  return inputFor(captured, { id: 9, slug: 'okx_futures', adapter_slug: 'okx' }, rows)
}

async function okxFullFixtureInput(): Promise<PrepareVerifiedPositionHistoryPublicationInput> {
  const fixture = JSON.parse(
    readFileSync(join(__dirname, '../adapters/okx/__tests__/fixtures/history-page.json'), 'utf8')
  ) as { data: Array<Record<string, unknown>> }
  const fixtureIdentity = String(fixture.data[0].uniqueCode)
  const firstUrl =
    'https://www.okx.com/api/v5/copytrading/public-subpositions-history?' +
    `instType=SWAP&limit=100&uniqueCode=${fixtureIdentity}`
  const lastSubPositionId = String(fixture.data.at(-1)?.subPosId)
  const captured = await capture(
    { id: 9, slug: 'okx_futures' },
    [
      {
        pageIndex: 1,
        url: firstUrl,
        fetchedAt,
        payload: { historyTraderIdentity: fixtureIdentity, data: fixture.data },
      },
      {
        pageIndex: 2,
        url: `${firstUrl}&after=${lastSubPositionId}`,
        fetchedAt: '2026-08-03T10:00:01.000Z',
        payload: { historyTraderIdentity: fixtureIdentity, data: [] },
      },
    ],
    terminalClaim([{ segment_id: 'default', reason: 'empty_page', page_ordinal: 2 }]),
    okxPositionHistoryTerminalVerifier,
    fixtureIdentity
  )
  const evidence = buildReviewedPositionHistoryEvidence(captured.artifact, captured.sourceRunId)
  return inputFor(
    captured,
    { id: 9, slug: 'okx_futures', adapter_slug: 'okx' },
    evidence.canonicalRows
  )
}

describe('verified position-history publication preparation', () => {
  it.each([
    ['Bitget', bitgetInput],
    ['Binance', binanceInput],
    ['OKX', okxInput],
  ] as const)(
    're-runs the reviewed %s source verifier before preparing facts',
    async (_name, make) => {
      const prepared = prepareVerifiedPositionHistoryPublication(await make())

      expect(isPreparedVerifiedPositionHistoryPublication(prepared)).toBe(true)
      expect(prepared.rows).toHaveLength(1)
      expect(prepared.rowBindings[0]).toMatchObject({
        binding_ordinal: 1,
        classification: 'canonical_materialized',
        fact_canonical_json: expect.any(String),
        fact_ordinal: 1,
        fact_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        page_ordinal: 1,
        source_row_ordinal: 1,
        page_payload_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        page_fetched_at: fetchedAt,
        raw_row_canonical_json: expect.any(String),
        raw_row_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      })
      expect(prepared.bindingSetSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(prepared.publicationSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(Object.isFrozen(prepared)).toBe(true)
      expect(Object.isFrozen(prepared.rows[0].raw)).toBe(true)
    }
  )

  it('prepares a canonical fact containing valid surrogate pairs without changing RAW bytes', async () => {
    const prepared = prepareVerifiedPositionHistoryPublication(
      await bitgetInput([
        bitgetRaw({
          symbolDisplayName: 'BTC🚀USDT',
          note: 'valid🚀value',
          ['asset🚀key']: 'USDT',
        }),
      ])
    )

    expect(prepared.rows[0].symbol).toBe('BTC🚀USDT')
    expect(prepared.rows[0].raw).toMatchObject({
      symbolDisplayName: 'BTC🚀USDT',
      note: 'valid🚀value',
      ['asset🚀key']: 'USDT',
    })
    expect(JSON.parse(prepared.rowBindings[0].raw_row_canonical_json)).toEqual(prepared.rows[0].raw)
  })

  it.each([
    ['a RAW string value', () => bitgetInput([bitgetRaw({ note: 'unsafe\0value' })])],
    ['a RAW object key', () => bitgetInput([bitgetRaw({ ['unsafe\0key']: 'value' })])],
    ['the outer identity', () => bitgetInput([bitgetRaw()], 'leader\0identity')],
    ['an empty capture identity', () => bitgetInput([], 'leader\0identity')],
  ] as const)('does not prepare a publication containing NUL in %s', async (_label, make) => {
    const input = await make()

    expect(() => prepareVerifiedPositionHistoryPublication(input)).toThrow(
      'PostgreSQL JSONB cannot represent'
    )
  })

  it('projects exactly sixteen snake-case fact keys and materializes a missing optional return', async () => {
    const raw = bitgetRaw()
    delete raw.returnRate
    const fact = prepareVerifiedPositionHistoryPublication(await bitgetInput([raw])).rows[0]

    expect(Object.keys(fact).sort()).toEqual(FACT_KEYS)
    expect(fact.source_fact_id).toBe('order-1')
    expect(fact.source_return).toBeNull()
    expect(fact).not.toHaveProperty('kind')
    expect(fact).not.toHaveProperty('currency')
  })

  it('rejects forged prepared objects at both RPC and receipt boundaries', async () => {
    const prepared = prepareVerifiedPositionHistoryPublication(await bitgetInput())
    const forged = { ...prepared } as PreparedVerifiedPositionHistoryPublication

    expect(isPreparedVerifiedPositionHistoryPublication(forged)).toBe(false)
    expect(() => prepareVerifiedPositionHistoryRpcCall(forged)).toThrow(
      'was not produced by the verified preparation boundary'
    )
    expect(() => validateVerifiedPositionHistoryPublicationReceipt(forged, {})).toThrow(
      'was not produced by the verified preparation boundary'
    )
  })

  it('builds a canonical RPC evidence envelope without weakening the sixteen-key facts', async () => {
    const prepared = prepareVerifiedPositionHistoryPublication(await bitgetInput())
    const call = prepareVerifiedPositionHistoryRpcCall(prepared)
    const payload = JSON.parse(call.values[3])
    const bindings = JSON.parse(payload.bindings_canonical_json)
    const binding = bindings[0]
    const fact = JSON.parse(binding.fact_canonical_json)
    const raw = JSON.parse(binding.raw_row_canonical_json)

    expect(call.text).toBe(PUBLISH_VERIFIED_POSITION_HISTORY_SQL)
    expect(call.text).toContain('$4::text')
    expect(call.values.slice(0, 3)).toEqual([501, prepared.sourceRunId, null])
    expect(Object.keys(payload).sort()).toEqual(RPC_PAYLOAD_KEYS)
    expect(payload).toMatchObject({
      contract: VERIFIED_POSITION_HISTORY_RPC_PAYLOAD_CONTRACT,
      source_contract: BITGET_POSITION_HISTORY_SOURCE_CONTRACT,
      source_run_id: prepared.sourceRunId,
      raw_object_id: 501,
      history_kind: 'position_history',
      binding_set_sha256: prepared.bindingSetSha256,
    })
    expect(payload).not.toHaveProperty('publication_sha256')
    expect(payload).not.toHaveProperty('rows')
    expect(Object.keys(binding).sort()).toEqual(ROW_BINDING_KEYS)
    expect(binding).toMatchObject({
      page_ordinal: 1,
      source_row_ordinal: 1,
      page_payload_sha256: prepared.rowBindings[0].page_payload_sha256,
      page_fetched_at: fetchedAt,
      fact_sha256: prepared.rowBindings[0].fact_sha256,
    })
    expect(Object.keys(fact).sort()).toEqual(FACT_KEYS)
    expect(raw).toEqual(fact.raw)
    expect(sha256Utf8(binding.fact_canonical_json)).toBe(binding.fact_sha256)
    expect(sha256Utf8(binding.raw_row_canonical_json)).toBe(binding.raw_row_sha256)
    expect(sha256Utf8(payload.bindings_canonical_json)).toBe(payload.binding_set_sha256)
    expect(sha256Utf8(call.values[3])).toBe(prepared.publicationSha256)
    expect(call.values[3]).toBe(prepared.rpcPayloadCanonicalJson)
  })

  it('binds the complete real OKX fixture as two facts plus one explicit partial omission', async () => {
    const input = await okxFullFixtureInput()
    const prepared = prepareVerifiedPositionHistoryPublication(input)
    const bindings = JSON.parse(prepared.rpcPayload.bindings_canonical_json) as Array<
      Record<string, unknown>
    >

    expect(input.rows).toHaveLength(2)
    expect(prepared.rows).toHaveLength(2)
    expect(bindings).toHaveLength(3)
    expect(bindings.map((binding) => binding.classification)).toEqual([
      'source_partial_omitted',
      'canonical_materialized',
      'canonical_materialized',
    ])
    expect(bindings.map((binding) => binding.binding_ordinal)).toEqual([1, 2, 3])
    expect(bindings.map((binding) => binding.fact_ordinal)).toEqual([null, 1, 2])
    expect(bindings[0]).toMatchObject({
      fact_canonical_json: null,
      fact_sha256: null,
      page_ordinal: 1,
      source_row_ordinal: 1,
    })
    expect(JSON.parse(String(bindings[0].raw_row_canonical_json))).toMatchObject({
      closeTime: '',
      uniqueCode: input.acquisition.trader.exchange_trader_id,
    })
  })

  it('rejects missing, duplicate, cross-page, false-partial and fact-shape binding attacks', async () => {
    const input = await okxFullFixtureInput()
    const evidence = buildReviewedPositionHistoryEvidence(input.acquisition, input.sourceRunId)
    const prepared = prepareVerifiedPositionHistoryPublication(input)
    const bindings = JSON.parse(JSON.stringify(prepared.rowBindings)) as Array<
      Record<string, unknown>
    >

    expect(validateVerifiedPositionHistoryBindingSet(bindings, evidence)).toHaveLength(3)
    expect(() => validateVerifiedPositionHistoryBindingSet(bindings.slice(1), evidence)).toThrow(
      'binding count does not exactly match'
    )

    const duplicate = JSON.parse(JSON.stringify(bindings)) as Array<Record<string, unknown>>
    duplicate[1] = { ...duplicate[0], binding_ordinal: 2 }
    expect(() => validateVerifiedPositionHistoryBindingSet(duplicate, evidence)).toThrow(
      'exact manifest coordinate order'
    )

    const crossPage = JSON.parse(JSON.stringify(bindings)) as Array<Record<string, unknown>>
    crossPage[0].page_ordinal = 2
    expect(() => validateVerifiedPositionHistoryBindingSet(crossPage, evidence)).toThrow(
      'exact manifest coordinate order'
    )

    const partialWithFact = JSON.parse(JSON.stringify(bindings)) as Array<Record<string, unknown>>
    partialWithFact[0].fact_ordinal = 1
    partialWithFact[0].fact_canonical_json = partialWithFact[1].fact_canonical_json
    partialWithFact[0].fact_sha256 = partialWithFact[1].fact_sha256
    expect(() => validateVerifiedPositionHistoryBindingSet(partialWithFact, evidence)).toThrow(
      'partial binding must not carry a materialized fact'
    )

    const materializedWithoutFact = JSON.parse(JSON.stringify(bindings)) as Array<
      Record<string, unknown>
    >
    materializedWithoutFact[1].fact_ordinal = null
    materializedWithoutFact[1].fact_canonical_json = null
    materializedWithoutFact[1].fact_sha256 = null
    expect(() =>
      validateVerifiedPositionHistoryBindingSet(materializedWithoutFact, evidence)
    ).toThrow('materialized binding must carry an exact fact')

    const falsePartial = JSON.parse(JSON.stringify(bindings)) as Array<Record<string, unknown>>
    const falsePartialRaw = JSON.parse(String(falsePartial[0].raw_row_canonical_json)) as Record<
      string,
      unknown
    >
    falsePartialRaw.closeTime = String(Number(falsePartialRaw.openTime) + 1_000)
    const falsePartialCanonicalRaw = strictCanonicalJson(falsePartialRaw)
    const falsePartialRawSha256 = sha256Utf8(falsePartialCanonicalRaw)
    falsePartial[0].raw_row_canonical_json = falsePartialCanonicalRaw
    falsePartial[0].raw_row_sha256 = falsePartialRawSha256
    const falsePartialEvidence = {
      ...evidence,
      pageManifest: evidence.pageManifest.map((page, pageIndex) =>
        pageIndex === 0
          ? {
              ...page,
              source_rows: page.source_rows.map((sourceRow, rowIndex) =>
                rowIndex === 0
                  ? { ...sourceRow, source_row_sha256: falsePartialRawSha256 }
                  : sourceRow
              ),
            }
          : page
      ),
    }
    expect(() =>
      validateVerifiedPositionHistoryBindingSet(falsePartial, falsePartialEvidence)
    ).toThrow('does not carry exact OKX omission evidence')
  })

  it('never accepts source-partial classification for a non-OKX manifest', async () => {
    const input = await bitgetInput()
    const evidence = buildReviewedPositionHistoryEvidence(input.acquisition, input.sourceRunId)
    const prepared = prepareVerifiedPositionHistoryPublication(input)
    const binding = {
      ...prepared.rowBindings[0],
      classification: 'source_partial_omitted',
      fact_canonical_json: null,
      fact_ordinal: null,
      fact_sha256: null,
    }
    const forgedEvidence = {
      ...evidence,
      pageManifest: evidence.pageManifest.map((page, pageIndex) =>
        pageIndex === 0
          ? {
              ...page,
              source_rows: page.source_rows.map((sourceRow, rowIndex) =>
                rowIndex === 0
                  ? { ...sourceRow, classification: 'source_partial_omitted' as const }
                  : sourceRow
              ),
            }
          : page
      ),
    }

    expect(() => validateVerifiedPositionHistoryBindingSet([binding], forgedEvidence)).toThrow(
      'source partial omission is allowed only for reviewed OKX history'
    )
  })

  it.each([
    [
      'non-canonical closedAt',
      (input: PrepareVerifiedPositionHistoryPublicationInput) => {
        const row = input.rows[0].row as ParsedPositionHistoryRow
        input.rows = [{ ...input.rows[0], row: { ...row, closedAt: '2026-08-03T09:00:00Z' } }]
      },
      'closedAt must be a canonical',
    ],
    [
      'openedAt after closedAt',
      (input: PrepareVerifiedPositionHistoryPublicationInput) => {
        const row = input.rows[0].row as ParsedPositionHistoryRow
        input.rows = [
          {
            ...input.rows[0],
            row: { ...row, openedAt: '2026-08-03T09:30:00.000Z' },
          },
        ]
      },
      'openedAt must not follow closedAt',
    ],
    [
      'future closedAt',
      (input: PrepareVerifiedPositionHistoryPublicationInput) => {
        const row = input.rows[0].row as ParsedPositionHistoryRow
        input.rows = [
          {
            ...input.rows[0],
            row: { ...row, closedAt: '2026-08-03T11:00:00.000Z' },
          },
        ]
      },
      'closedAt must not follow its bound page fetchedAt',
    ],
    [
      'non-finite number',
      (input: PrepareVerifiedPositionHistoryPublicationInput) => {
        const row = input.rows[0].row as ParsedPositionHistoryRow
        input.rows = [{ ...input.rows[0], row: { ...row, realizedPnl: Number.NaN } }]
      },
      'is not position_history',
    ],
    [
      'padded symbol',
      (input: PrepareVerifiedPositionHistoryPublicationInput) => {
        const row = input.rows[0].row as ParsedPositionHistoryRow
        input.rows = [{ ...input.rows[0], row: { ...row, symbol: ' BTCUSDT ' } }]
      },
      'symbol must be trimmed',
    ],
  ] as const)('rejects %s before an RPC call', async (_label, mutate, message) => {
    const input = await bitgetInput()
    mutate(input)
    expect(() => prepareVerifiedPositionHistoryPublication(input)).toThrow(message)
  })

  it('rejects partial or unrecognized lifecycle limitations', async () => {
    const input = await bitgetInput()
    const row = input.rows[0].row as ParsedPositionHistoryRow
    input.rows = [
      {
        ...input.rows[0],
        row: { ...row, limitations: ['source_lifecycle_marker_partial'] },
      },
    ]

    expect(() => prepareVerifiedPositionHistoryPublication(input)).toThrow(
      'partial, missing, or unrecognized lifecycle evidence'
    )
  })

  it('recomputes the reviewed source identity and dedupe hash instead of trusting input', async () => {
    const hashDrift = await bitgetInput()
    const row = hashDrift.rows[0].row as ParsedPositionHistoryRow
    hashDrift.rows = [
      {
        ...hashDrift.rows[0],
        row: { ...row, dedupeHash: '0'.repeat(row.dedupeHash.length) },
      },
    ]
    expect(() => prepareVerifiedPositionHistoryPublication(hashDrift)).toThrow(
      'dedupeHash does not match the reviewed parser formula'
    )

    const identityDrift = await bitgetInput()
    const identityRow = identityDrift.rows[0].row as ParsedPositionHistoryRow
    const identitySources = { ...identityRow.fieldSources }
    delete identitySources.sourceFactId
    identityDrift.rows = [
      {
        ...identityDrift.rows[0],
        row: {
          ...identityRow,
          sourceFactId: null,
          fieldSources: identitySources,
          limitations: ['source_fact_id_missing'],
        },
      },
    ]
    expect(() => prepareVerifiedPositionHistoryPublication(identityDrift)).toThrow(
      'sourceFactId must be non-empty canonical text'
    )
  })

  it('requires each source field path to match its exact reviewed allowlist', async () => {
    const input = await bitgetInput()
    const row = input.rows[0].row as ParsedPositionHistoryRow
    input.rows = [
      {
        ...input.rows[0],
        row: {
          ...row,
          fieldSources: {
            ...row.fieldSources,
            realizedPnl: { fieldPaths: ['data.rows[].achievedProfits'] },
          },
        },
      },
    ]

    expect(() => prepareVerifiedPositionHistoryPublication(input)).toThrow(
      'realizedPnl field source is not exactly reviewed'
    )
  })

  it('requires the input rows to be the complete per-page parser replay in exact order', async () => {
    const omitted = await bitgetInput()
    omitted.rows = []
    expect(() => prepareVerifiedPositionHistoryPublication(omitted)).toThrow(
      'input row count does not exactly match'
    )

    const added = await bitgetInput()
    added.rows = [...added.rows, added.rows[0]]
    expect(() => prepareVerifiedPositionHistoryPublication(added)).toThrow(
      'input row count does not exactly match'
    )

    const crossedPage = await okxInput()
    crossedPage.rows = [{ ...crossedPage.rows[0], pageOrdinal: 2 }]
    expect(() => prepareVerifiedPositionHistoryPublication(crossedPage)).toThrow(
      'page ordinal does not match reviewed parser order'
    )

    const crossedRow = await bitgetInput()
    crossedRow.rows = [{ ...crossedRow.rows[0], sourceRowOrdinal: 2 }]
    expect(() => prepareVerifiedPositionHistoryPublication(crossedRow)).toThrow(
      'source row ordinal does not match reviewed parser order'
    )

    const first = bitgetRaw()
    const second = bitgetRaw({ orderNo: 'order-2' })
    const reordered = await bitgetInput([first, second])
    reordered.rows = [
      { ...reordered.rows[0], row: reordered.rows[1].row },
      { ...reordered.rows[1], row: reordered.rows[0].row },
    ]
    expect(() => prepareVerifiedPositionHistoryPublication(reordered)).toThrow(
      'does not exactly match reviewed parser output'
    )
  })

  it('materializes Binance CLOSING rows once while retaining overlapping OPENING evidence', async () => {
    const input = await binanceInput()
    expect(input.acquisition.pages).toHaveLength(2)
    expect(input.rows).toHaveLength(1)
    expect(prepareVerifiedPositionHistoryPublication(input).rowBindings).toEqual([
      expect.objectContaining({ page_ordinal: 1 }),
    ])

    const openingRows = positionRows(
      parseBinanceHistory(
        input.acquisition.pages[1].payload,
        'position_history',
        parseCtx('binance_futures', input.acquisition.pages[1].fetched_at)
      )
    )
    input.rows = [
      ...input.rows,
      ...openingRows.map((row, rowIndex) => ({
        pageOrdinal: 2,
        sourceRowOrdinal: rowIndex + 1,
        row,
      })),
    ]
    expect(() => prepareVerifiedPositionHistoryPublication(input)).toThrow(
      'input row count does not exactly match'
    )
  })

  it('fails closed when a source envelope candidate is silently skipped for missing symbol', async () => {
    const raw = bitgetRaw()
    delete raw.symbolDisplayName
    const input = await bitgetInput([raw])
    expect(input.rows).toHaveLength(0)

    expect(() => prepareVerifiedPositionHistoryPublication(input)).toThrow(
      'reviewed parser did not account for every source candidate'
    )
  })

  it('rejects oversized evidence pages before verifier or parser replay can materialize them', async () => {
    const firstUrl =
      'https://www.okx.com/api/v5/copytrading/public-subpositions-history?' +
      `instType=SWAP&limit=100&uniqueCode=${exchangeTraderId}`
    const rawRows = Array.from({ length: 101 }, (_, index) => ({
      ccy: 'USDT',
      subPosId: `oversized-${index + 1}`,
      instId: 'BTC-USDT-SWAP',
      instType: 'SWAP',
      posSide: 'long',
      openTime: openedMs,
      closeTime: closedMs,
      lever: '5',
      subPos: '2',
      openAvgPx: '100',
      closeAvgPx: '110',
      pnl: '20',
      pnlRatio: '0.2',
      uniqueCode: exchangeTraderId,
    }))
    const captured = await capture(
      { id: 9, slug: 'okx_futures' },
      [
        {
          pageIndex: 1,
          url: firstUrl,
          fetchedAt,
          payload: { historyTraderIdentity: exchangeTraderId, data: rawRows },
        },
        {
          pageIndex: 2,
          url: `${firstUrl}&after=oversized-101`,
          fetchedAt: '2026-08-03T10:00:01.000Z',
          payload: { historyTraderIdentity: exchangeTraderId, data: [] },
        },
      ],
      terminalClaim([{ segment_id: 'default', reason: 'empty_page', page_ordinal: 2 }]),
      okxPositionHistoryTerminalVerifier
    )
    const input = inputFor(captured, { id: 9, slug: 'okx_futures', adapter_slug: 'okx' }, [])

    expect(() => prepareVerifiedPositionHistoryPublication(input)).toThrow(
      'exceeds reviewed page size 100'
    )
  })

  it('allows an empty publication only when the reviewed canonical source envelope is empty', async () => {
    const input = await bitgetInput([])
    const prepared = prepareVerifiedPositionHistoryPublication(input)

    expect(prepared.rows).toEqual([])
    expect(prepared.rowBindings).toEqual([])
  })

  it('rejects an OKX source fact repeated across pages even when closeTime differs', async () => {
    const firstUrl =
      'https://www.okx.com/api/v5/copytrading/public-subpositions-history?' +
      `instType=SWAP&limit=100&uniqueCode=${exchangeTraderId}`
    const nextUrl = `${firstUrl}&after=duplicate-sub-position`
    const raw = {
      ccy: 'USDT',
      subPosId: 'duplicate-sub-position',
      instId: 'BTC-USDT-SWAP',
      instType: 'SWAP',
      posSide: 'long',
      openTime: openedMs,
      closeTime: closedMs,
      lever: '5',
      subPos: '2',
      openAvgPx: '100',
      closeAvgPx: '110',
      pnl: '20',
      pnlRatio: '0.2',
      uniqueCode: exchangeTraderId,
    }
    const captured = await capture(
      { id: 9, slug: 'okx_futures' },
      [
        {
          pageIndex: 1,
          url: firstUrl,
          fetchedAt,
          payload: { historyTraderIdentity: exchangeTraderId, data: [raw] },
        },
        {
          pageIndex: 2,
          url: nextUrl,
          fetchedAt: '2026-08-03T10:00:01.000Z',
          payload: {
            historyTraderIdentity: exchangeTraderId,
            data: [{ ...raw, closeTime: String(Date.parse(closedAt) - 60_000) }],
          },
        },
        {
          pageIndex: 3,
          url: nextUrl,
          fetchedAt: '2026-08-03T10:00:02.000Z',
          payload: { historyTraderIdentity: exchangeTraderId, data: [] },
        },
      ],
      terminalClaim([{ segment_id: 'default', reason: 'empty_page', page_ordinal: 3 }]),
      okxPositionHistoryTerminalVerifier
    )
    const rows = captured.artifact.pages.flatMap((page, pageIndex) =>
      positionRows(
        parseOkxHistory(page.payload, 'position_history', parseCtx('okx_futures', page.fetched_at))
      ).map((row, rowIndex) => ({
        pageOrdinal: pageIndex + 1,
        sourceRowOrdinal: rowIndex + 1,
        row,
      }))
    )
    const input = inputFor(captured, { id: 9, slug: 'okx_futures', adapter_slug: 'okx' }, rows)

    expect(() => prepareVerifiedPositionHistoryPublication(input)).toThrow(
      'exact reviewed terminal evidence'
    )
  })

  it('rejects a row whose RAW object is absent from the declared acquisition page', async () => {
    const input = await bitgetInput()
    const row = input.rows[0].row as ParsedPositionHistoryRow
    input.rows = [
      {
        ...input.rows[0],
        row: { ...row, raw: { ...row.raw, unexpected: true } },
      },
    ]

    expect(() => prepareVerifiedPositionHistoryPublication(input)).toThrow(
      'RAW value is not present in its bound page'
    )
  })

  it('rejects unsupported source, adapter drift, verifier drift, and RAW receipt drift', async () => {
    const unsupported = await bitgetInput()
    unsupported.source = { ...unsupported.source, slug: 'future_futures' }
    expect(() => prepareVerifiedPositionHistoryPublication(unsupported)).toThrow('is not reviewed')

    const adapterDrift = await bitgetInput()
    adapterDrift.source = { ...adapterDrift.source, adapter_slug: 'binance' }
    expect(() => prepareVerifiedPositionHistoryPublication(adapterDrift)).toThrow(
      'does not match bitget'
    )

    const valid = await bitgetInput()
    const fakeVerifier: SelectedHistoryTerminalVerifier = {
      contract: 'arena.ingest.history-terminal-verifier.fake.position_history@1',
      verify: () => ({ verified: true, scanTerminalState: 'exhausted' }),
    }
    const recaptured = await capture(
      valid.acquisition.source,
      valid.acquisition.pages.map((page) => ({
        pageIndex: page.stored_page_index,
        url: page.url,
        fetchedAt: page.fetched_at,
        payload: page.payload,
      })),
      terminalClaim(valid.acquisition.termination.claim_observations),
      fakeVerifier
    )
    const verifierDrift = {
      ...valid,
      acquisition: recaptured.artifact,
      sourceRunId: recaptured.sourceRunId,
      rawObject: {
        ...valid.rawObject,
        contentHash: recaptured.sourceRunId,
        storagePath:
          `bitget_futures/history_trust/position_history/${recaptured.sourceRunId}/` +
          `event_history_${recaptured.sourceRunId}.json.gz`,
      },
    }
    expect(() => prepareVerifiedPositionHistoryPublication(verifierDrift)).toThrow(
      'exact reviewed terminal evidence'
    )

    const rawDrift = await bitgetInput()
    rawDrift.rawObject = { ...rawDrift.rawObject, contentHash: 'f'.repeat(64) }
    expect(() => prepareVerifiedPositionHistoryPublication(rawDrift)).toThrow(
      'RAW object receipt does not match'
    )
  })
})

describe('verified position-history publication receipt', () => {
  async function prepared() {
    return prepareVerifiedPositionHistoryPublication(await bitgetInput())
  }

  function ownerReceipt(
    publication: PreparedVerifiedPositionHistoryPublication,
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      publicationId: 101,
      publicationSha256: publication.publicationSha256,
      sourceRunId: publication.sourceRunId,
      rawObjectId: publication.rawObjectId,
      stateId: 101,
      cursorAfter: '2026-08-03 09:00:00+00',
      observedAt: '2026-08-03 10:00:00+00',
      factsAdded: 1,
      factsReused: 0,
      replayed: false,
      ...overrides,
    }
  }

  it('accepts and canonicalizes the exact owner RPC receipt', async () => {
    const publication = await prepared()
    const receipt = validateVerifiedPositionHistoryPublicationReceipt(
      publication,
      ownerReceipt(publication)
    )

    expect(receipt).toEqual({
      publicationId: 101,
      publicationSha256: publication.publicationSha256,
      sourceRunId: publication.sourceRunId,
      rawObjectId: 501,
      stateId: 101,
      cursorAfter: closedAt,
      observedAt: fetchedAt,
      factsAdded: 1,
      factsReused: 0,
      replayed: false,
    })
    expect(Object.isFrozen(receipt)).toBe(true)
  })

  it('accepts only exact replay counts', async () => {
    const publication = await prepared()
    expect(
      validateVerifiedPositionHistoryPublicationReceipt(
        publication,
        ownerReceipt(publication, { factsAdded: 0, factsReused: 1, replayed: true })
      )
    ).toMatchObject({ replayed: true, factsAdded: 0, factsReused: 1 })

    expect(() =>
      validateVerifiedPositionHistoryPublicationReceipt(
        publication,
        ownerReceipt(publication, { replayed: true })
      )
    ).toThrow('replayed receipt fact counts are not exact')
  })

  it.each([
    ['extra field', { extra: true }, 'inexact field set'],
    ['wrong cursor', { cursorAfter: openedAt }, 'cursorAfter does not match'],
    [
      'wrong observed time',
      { observedAt: '2026-08-03T10:00:01.000Z' },
      'observedAt does not match',
    ],
    ['wrong counts', { factsAdded: 0 }, 'fact counts do not match'],
    ['wrong state binding', { stateId: 202 }, 'stateId does not match publicationId'],
    [
      'wrong publication digest',
      { publicationSha256: '0'.repeat(64) },
      'publicationSha256 does not match',
    ],
    ['wrong source run', { sourceRunId: 'f'.repeat(64) }, 'sourceRunId does not match'],
    ['wrong RAW object', { rawObjectId: 502 }, 'rawObjectId does not match'],
  ] as const)('rejects receipt %s', async (_label, override, message) => {
    const publication = await prepared()
    expect(() =>
      validateVerifiedPositionHistoryPublicationReceipt(
        publication,
        ownerReceipt(publication, override)
      )
    ).toThrow(message)
  })
})
