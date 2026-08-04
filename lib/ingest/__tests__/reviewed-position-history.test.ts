import {
  BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT,
  BINANCE_POSITION_HISTORY_URL,
} from '@/lib/ingest/adapters/binance/history-contract'
import { binancePositionHistoryTerminalVerifier } from '@/lib/ingest/adapters/binance/history-terminal'
import {
  BITGET_HISTORY_PAGE_ENVELOPE_CONTRACT,
  BITGET_POSITION_HISTORY_URL,
  bitgetPositionHistoryTerminalVerifier,
} from '@/lib/ingest/adapters/bitget/history-terminal'
import { okxPositionHistoryTerminalVerifier } from '@/lib/ingest/adapters/okx/history-terminal'
import type { RawPage } from '@/lib/ingest/core/types'
import {
  captureHistoryAcquisition,
  HISTORY_TERMINAL_CLAIM_CONTRACT,
  type CapturedHistoryAcquisition,
  type HistoryTerminalClaim,
  type SelectedHistoryTerminalVerifier,
} from '@/lib/ingest/history-acquisition'
import {
  buildReviewedPositionHistoryEvidence,
  POSITION_HISTORY_PAGE_MANIFEST_KEYS,
  POSITION_HISTORY_PUBLICATION_EVIDENCE_CONTRACT,
  POSITION_HISTORY_RAW_META_KEYS,
  POSITION_HISTORY_SOURCE_ROW_MANIFEST_KEYS,
  positionHistoryPublicationRawMeta,
  REVIEWED_POSITION_HISTORY_CONTRACTS,
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
  verifier: SelectedHistoryTerminalVerifier
): Promise<CapturedHistoryAcquisition> {
  async function* stream(): AsyncGenerator<RawPage, HistoryTerminalClaim, void> {
    for (const page of pages) yield page
    return claim
  }
  return captureHistoryAcquisition({
    source,
    traderId,
    exchangeTraderId,
    kind: 'position_history',
    cursor: null,
    attemptStartedAt,
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
  verifier: SelectedHistoryTerminalVerifier = bitgetPositionHistoryTerminalVerifier
): Promise<CapturedHistoryAcquisition> {
  return capture(
    { id: 7, slug: 'bitget_futures' },
    [
      {
        pageIndex: 1,
        url: BITGET_POSITION_HISTORY_URL,
        fetchedAt,
        payload: {
          contract: BITGET_HISTORY_PAGE_ENVELOPE_CONTRACT,
          historyTraderIdentity: exchangeTraderId,
          request: { pageNo: 1, pageSize: 20, traderUid: exchangeTraderId },
          response: { code: '00000', data: { rows, nextFlag: false } },
        },
      },
    ],
    terminalClaim([{ segment_id: 'default', reason: 'reported_end', page_ordinal: 1 }]),
    verifier
  )
}

async function binanceCapture(): Promise<CapturedHistoryAcquisition> {
  const raw = {
    id: 'position-1',
    symbol: 'BTCUSDT',
    side: 'Long',
    status: 'All Closed',
    opened: openedMs,
    closed: closedMs,
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
  return capture(
    { id: 8, slug: 'binance_futures' },
    [page('CLOSING', fetchedAt), page('OPENING', '2026-08-03T10:00:01.000Z')],
    terminalClaim([
      { segment_id: 'closing', reason: 'reported_end', page_ordinal: 1 },
      { segment_id: 'opening', reason: 'reported_end', page_ordinal: 2 },
    ]),
    binancePositionHistoryTerminalVerifier
  )
}

async function okxCapture(): Promise<CapturedHistoryAcquisition> {
  const raw = {
    subPosId: 'sub-position-1',
    instId: 'BTC-USDT-SWAP',
    posSide: 'long',
    openTime: openedMs,
    closeTime: closedMs,
    lever: '5',
    subPos: '2',
    openAvgPx: '100',
    closeAvgPx: '110',
    pnl: '20',
    pnlRatio: '0.2',
  }
  const firstUrl =
    'https://www.okx.com/api/v5/copytrading/public-subpositions-history?' +
    `instType=SWAP&limit=100&uniqueCode=${exchangeTraderId}`
  return capture(
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
        url: `${firstUrl}&after=sub-position-1`,
        fetchedAt: '2026-08-03T10:00:01.000Z',
        payload: { historyTraderIdentity: exchangeTraderId, data: [] },
      },
    ],
    terminalClaim([{ segment_id: 'default', reason: 'empty_page', page_ordinal: 2 }]),
    okxPositionHistoryTerminalVerifier
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

  it('uses one reviewed registry for source, adapter, parser, verifier, page-size, and paths', () => {
    expect(REVIEWED_POSITION_HISTORY_CONTRACTS.binance_futures).toMatchObject({
      adapterSlug: 'binance',
      pageSize: 50,
    })
    expect(REVIEWED_POSITION_HISTORY_CONTRACTS.bitget_futures).toMatchObject({
      adapterSlug: 'bitget',
      pageSize: 20,
    })
    expect(REVIEWED_POSITION_HISTORY_CONTRACTS.okx_futures).toMatchObject({
      adapterSlug: 'okx',
      pageSize: 100,
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
