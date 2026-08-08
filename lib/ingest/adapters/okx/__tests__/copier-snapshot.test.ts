import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ParsedCopierRow, SourceRow } from '../../../core/types'
import type { FetchSession } from '../../../fetch/types'
import { captureHistoryAcquisition } from '../../../history-acquisition'
import { okxCopierHistoryUrl } from '../copier-snapshot'
import { okxAdapter } from '../index'

const UNIQUE_CODE = 'F503A5D5F1F6989F'
const PARSED_AT = '2026-08-03T10:00:00.000Z'

type Dict = Record<string, unknown>

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: 34,
    slug: 'okx_futures',
    exchange_id: 9,
    product_type: 'futures',
    trader_kind_scope: 'human',
    adapter_slug: 'okx',
    leaderboard_url: null,
    timeframes_native: [90],
    timeframes_derived: [7, 30],
    tf_label_map: {},
    expected_count: 200,
    deep_profile_topn: 100,
    positions_topn: 100,
    profile_cache_ttl: '6 hours',
    copier_table_depth: 'top10',
    currency: 'USDT',
    page_size: 20,
    pagination_kind: 'numeric',
    cadence_tier_a: '4 hours',
    cadence_tier_b: '12 hours',
    cadence_tier_d: '1 hour',
    fetch_region: 'vps_sg',
    rate_budget_ms: 500,
    phase: 3,
    serving_mode: 'serving',
    status: 'active',
    meta: { inst_type: 'SWAP' },
    ...overrides,
  }
}

function session(): FetchSession {
  return {
    sourceSlug: 'okx_futures',
    paced: async <T>(fn: () => Promise<T>) => fn(),
  } as FetchSession
}

function httpOk(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as Response
}

function verifier(src = source()) {
  const selected = okxAdapter.verifyCopierSnapshot?.(src)
  if (!selected) throw new Error('expected the reviewed OKX copier verifier')
  return selected
}

async function capture(payload: unknown, exchangeTraderId = UNIQUE_CODE) {
  global.fetch = jest.fn(async () => httpOk(payload)) as jest.MockedFunction<typeof fetch>
  const src = source()
  const selected = verifier(src)
  return captureHistoryAcquisition({
    source: src,
    traderId: 99,
    exchangeTraderId,
    kind: 'copiers',
    cursor: null,
    attemptStartedAt: new Date(Date.now() - 1_000).toISOString(),
    stream: okxAdapter.getHistory(session(), src, exchangeTraderId, 'copiers', null),
    terminalVerifier: { contract: selected.contract, verify: selected.verifyTerminal },
  })
}

function parseRows(pages: Awaited<ReturnType<typeof capture>>['pages']): ParsedCopierRow[] {
  return pages
    .flatMap((page) =>
      okxAdapter.parseHistory(page.payload, 'copiers', {
        sourceSlug: 'okx_futures',
        currency: 'USDT',
        tfLabelMap: {},
        scrapedAt: PARSED_AT,
        meta: { inst_type: 'SWAP' },
      })
    )
    .filter((row): row is ParsedCopierRow => row.kind === 'copiers')
}

describe('OKX copier snapshot authority', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  it('selects only the canonical futures SWAP USDT top-10 contract', () => {
    expect(verifier()).toMatchObject({
      contract: 'arena.ingest.history-terminal-verifier.okx.copiers@2',
    })
    expect(okxAdapter.verifyCopierSnapshot?.(source({ status: 'inactive' }))).toBeNull()
    expect(okxAdapter.verifyCopierSnapshot?.(source({ serving_mode: 'shadow' }))).toBeNull()
    expect(okxAdapter.verifyCopierSnapshot?.(source({ trader_kind_scope: 'bot' }))).toBeNull()
    expect(okxAdapter.verifyCopierSnapshot?.(source({ copier_table_depth: 'full' }))).toBeNull()
    expect(okxAdapter.verifyCopierSnapshot?.(source({ currency: 'USDC' }))).toBeNull()
    expect(
      okxAdapter.verifyCopierSnapshot?.(
        source({ meta: { inst_type: 'SWAP', endpoints: { base: 'https://proxy.example.test' } } })
      )
    ).toBeNull()
    expect(
      okxAdapter.verifyCopierSnapshot?.(
        source({ slug: 'okx_spot', product_type: 'spot', meta: { inst_type: 'SPOT' } })
      )
    ).toBeNull()
  })

  it('retains the complete success envelope and proves populated parser conservation', async () => {
    const payload = fixture('copy-traders.json')
    const acquisition = await capture(payload)

    expect(acquisition.error).toBeNull()
    expect(acquisition.pages).toHaveLength(1)
    expect(acquisition.pages[0]).toMatchObject({
      pageIndex: 1,
      url: okxCopierHistoryUrl(UNIQUE_CODE),
      payload,
    })
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'verified',
      claim_observations: [{ segment_id: 'default', reason: 'snapshot_complete', page_ordinal: 1 }],
      scan_terminal_state: 'exhausted',
      blocker_reasons: [],
    })

    const rows = parseRows(acquisition.pages)
    const capturedBlock = (acquisition.pages[0].payload as { data: Array<{ copyTraders: Dict[] }> })
      .data[0]
    expect(rows).toHaveLength(10)
    rows.forEach((row, index) => expect(row.raw).toBe(capturedBlock.copyTraders[index]))
    expect(rows[0].raw).not.toHaveProperty('copy_total_pnl')
    expect(rows[0].raw).not.toHaveProperty('copy_trader_num_chg')
    expect(capturedBlock).toMatchObject({
      copyTotalPnl: '4915.5927501606778108',
      copyTraderNumChg: '284',
      copyTraderNumChgRatio: '2.4912',
    })
    expect(
      verifier().verifyConservation({
        exchangeTraderId: UNIQUE_CODE,
        parserClock: PARSED_AT,
        pages: acquisition.pages,
        rows,
      })
    ).toEqual({ verified: true, envelopeRowCount: 10 })
  })

  it.each([
    ['empty data array', fixture('copy-traders-empty.json')],
    [
      'empty reviewed block',
      (() => {
        const value = clone<{ data: Array<Dict> }>(fixture('copy-traders.json'))
        value.data[0].copyTraders = []
        return value
      })(),
    ],
  ])('proves an explicit successful %s snapshot', async (_label, payload) => {
    const acquisition = await capture(payload)
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'verified',
      scan_terminal_state: 'exhausted',
    })
    const rows = parseRows(acquisition.pages)
    expect(rows).toEqual([])
    expect(
      verifier().verifyConservation({
        exchangeTraderId: UNIQUE_CODE,
        parserClock: PARSED_AT,
        pages: acquisition.pages,
        rows,
      })
    ).toEqual({ verified: true, envelopeRowCount: 0 })
  })

  it('stores and verifies the complete encoded request URL', async () => {
    const exchangeTraderId = 'F503 A/5'
    const acquisition = await capture(fixture('copy-traders-empty.json'), exchangeTraderId)

    expect(acquisition.pages[0].url).toBe(okxCopierHistoryUrl(exchangeTraderId))
    expect(global.fetch).toHaveBeenCalledWith(
      okxCopierHistoryUrl(exchangeTraderId),
      expect.any(Object)
    )
    expect(acquisition.artifact.termination.evidence_state).toBe('verified')
  })

  it.each([
    [
      'currency',
      (block: Dict) => {
        block.ccy = 'USDC'
      },
    ],
    [
      'total PnL type',
      (block: Dict) => {
        block.copyTotalPnl = 4915
      },
    ],
    [
      'trader-count change value',
      (block: Dict) => {
        block.copyTraderNumChg = 'NaN'
      },
    ],
    [
      'trader-count ratio canonical form',
      (block: Dict) => {
        block.copyTraderNumChgRatio = ' 2.4912'
      },
    ],
    [
      'missing aggregate field',
      (block: Dict) => {
        delete block.copyTotalPnl
      },
    ],
  ] as const)('rejects capture-level aggregate envelope drift: %s', async (_label, mutate) => {
    const payload = clone<{ data: Dict[] }>(fixture('copy-traders.json'))
    mutate(payload.data[0])
    const acquisition = await capture(payload)

    expect(acquisition.pages).toHaveLength(1)
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'rejected',
      scan_terminal_state: 'unknown',
      blocker_reasons: ['terminal_claim_rejected'],
    })
    expect(
      verifier().verifyConservation({
        exchangeTraderId: UNIQUE_CODE,
        parserClock: PARSED_AT,
        pages: acquisition.pages,
        rows: parseRows(acquisition.pages),
      })
    ).toEqual({ verified: false })
  })

  it.each([
    [
      'top-level total',
      (payload: Dict) => {
        payload.total = 10
      },
    ],
    [
      'block cursor',
      (payload: Dict) => {
        const block = (payload.data as Dict[])[0]
        block.cursor = 'next'
      },
    ],
    [
      'block hasNext',
      (payload: Dict) => {
        const block = (payload.data as Dict[])[0]
        block.hasNext = false
      },
    ],
    [
      'block total',
      (payload: Dict) => {
        const block = (payload.data as Dict[])[0]
        block.total = 10
      },
    ],
    [
      'list-item cursor',
      (payload: Dict) => {
        const block = (payload.data as Dict[])[0]
        const firstRow = (block.copyTraders as Dict[])[0]
        firstRow.cursor = 'next'
      },
    ],
  ] as const)('rejects %s pagination drift', async (_label, mutate) => {
    const payload = clone<Dict>(fixture('copy-traders.json'))
    mutate(payload)
    const acquisition = await capture(payload)

    expect(acquisition.pages).toHaveLength(1)
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'rejected',
      scan_terminal_state: 'unknown',
      blocker_reasons: ['terminal_claim_rejected'],
    })
  })

  it.each([
    ['non-success code', { code: '50011', data: [], msg: 'busy' }],
    ['missing data list', { code: '0', data: null, msg: '' }],
    ['extra top-level field', { code: '0', data: [], msg: '', success: true }],
    [
      'non-canonical label',
      (() => {
        const value = clone<{ data: Array<{ copyTraders: Dict[] }> }>(fixture('copy-traders.json'))
        value.data[0].copyTraders[0].nickName = ' padded '
        return value
      })(),
    ],
  ])('rejects parser-empty or malformed success drift: %s', async (_label, payload) => {
    const acquisition = await capture(payload)
    expect(acquisition.pages).toHaveLength(1)
    expect(acquisition.artifact.termination.evidence_state).toBe('rejected')
  })

  it.each([
    ['snapshot timestamp', (row: ParsedCopierRow) => ({ ...row, ts: '2026-08-03T10:00:01.000Z' })],
    [
      'copier label',
      (row: ParsedCopierRow) => ({ ...row, copierLabel: `${row.copierLabel}-drift` }),
    ],
    ['copier PnL', (row: ParsedCopierRow) => ({ ...row, copierPnl: (row.copierPnl ?? 0) + 1 })],
    ['copier invested', (row: ParsedCopierRow) => ({ ...row, copierInvested: 1 })],
    [
      'copy duration',
      (row: ParsedCopierRow) => ({
        ...row,
        copyDurationDays: (row.copyDurationDays ?? 0) + 1,
      }),
    ],
  ] as const)('rejects parsed projection drift independently: %s', async (_label, mutate) => {
    const acquisition = await capture(fixture('copy-traders.json'))
    const rows = parseRows(acquisition.pages)
    const selected = verifier()
    const verify = (candidate: readonly ParsedCopierRow[]) =>
      selected.verifyConservation({
        exchangeTraderId: UNIQUE_CODE,
        parserClock: PARSED_AT,
        pages: acquisition.pages,
        rows: candidate,
      })

    expect(verify(rows.map((row, index) => (index === 0 ? mutate(row) : row)))).toEqual({
      verified: false,
    })
  })

  it('requires the exact candidate RAW reference, not a deep-equal clone or derived object', async () => {
    const acquisition = await capture(fixture('copy-traders.json'))
    const rows = parseRows(acquisition.pages)
    const selected = verifier()
    const verify = (candidate: readonly ParsedCopierRow[]) =>
      selected.verifyConservation({
        exchangeTraderId: UNIQUE_CODE,
        parserClock: PARSED_AT,
        pages: acquisition.pages,
        rows: candidate,
      })

    expect(
      verify(rows.map((row, index) => (index === 0 ? { ...row, raw: clone(row.raw) } : row)))
    ).toEqual({ verified: false })
    expect(
      verify(
        rows.map((row, index) =>
          index === 0
            ? {
                ...row,
                raw: {
                  ...row.raw,
                  copy_total_pnl: '4915.5927501606778108',
                  copy_trader_num_chg: '284',
                },
              }
            : row
        )
      )
    ).toEqual({ verified: false })
  })

  it('rejects row-count and source-order drift independently', async () => {
    const acquisition = await capture(fixture('copy-traders.json'))
    const rows = parseRows(acquisition.pages)
    const selected = verifier()
    const verify = (candidate: readonly ParsedCopierRow[]) =>
      selected.verifyConservation({
        exchangeTraderId: UNIQUE_CODE,
        parserClock: PARSED_AT,
        pages: acquisition.pages,
        rows: candidate,
      })

    expect(verify(rows.slice(1))).toEqual({ verified: false })
    expect(verify([...rows, rows[0]])).toEqual({ verified: false })
    expect(verify([...rows].reverse())).toEqual({ verified: false })
    expect(verify(rows.map((row) => ({ ...row, ts: '2000-01-01T00:00:00.000Z' })))).toEqual({
      verified: false,
    })
  })

  it('rejects expected-hash drift and duplicate hashes independently', async () => {
    const acquisition = await capture(fixture('copy-traders.json'))
    const rows = parseRows(acquisition.pages)
    const selected = verifier()
    const verify = (candidate: readonly ParsedCopierRow[]) =>
      selected.verifyConservation({
        exchangeTraderId: UNIQUE_CODE,
        parserClock: PARSED_AT,
        pages: acquisition.pages,
        rows: candidate,
      })

    expect(
      verify(
        rows.map((row, index) =>
          index === 0 ? { ...row, dedupeHash: '0'.repeat(row.dedupeHash.length) } : row
        )
      )
    ).toEqual({ verified: false })
    expect(
      verify(
        rows.map((row, index) => (index === 1 ? { ...row, dedupeHash: rows[0].dedupeHash } : row))
      )
    ).toEqual({ verified: false })
  })
})
