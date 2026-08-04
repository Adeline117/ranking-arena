import { createHash } from 'node:crypto'

import {
  BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT,
  BINANCE_POSITION_HISTORY_URL,
} from '@/lib/ingest/adapters/binance/history-contract'
import { binancePositionHistoryTerminalVerifier } from '@/lib/ingest/adapters/binance/history-terminal'
import { okxPositionHistoryTerminalVerifier } from '@/lib/ingest/adapters/okx/history-terminal'
import type { RawPage } from '@/lib/ingest/core/types'
import {
  captureHistoryAcquisition,
  HISTORY_TERMINAL_CLAIM_CONTRACT,
  type HistoryTerminalClaim,
} from '@/lib/ingest/history-acquisition'
import {
  buildPositionHistoryAcquisitionArtifactV2,
  type BuiltPositionHistoryAcquisitionArtifactV2,
} from '@/lib/ingest/position-history-acquisition-v2'
import { strictCanonicalSha256 } from '@/lib/ingest/strict-canonical-json'
import {
  buildTokenTradeShadowPlan,
  DA2_SHADOW_WRITER_CANARY_BLOCKER,
  type TokenTradeShadowEvidenceSnapshot,
} from '@/lib/ingest/token-trade-shadow-plan'

const ATTEMPT_STARTED_AT = '2026-08-03T11:59:59.000Z'
const FIRST_FETCHED_AT = '2026-08-03T12:00:00.000Z'
const LAST_FETCHED_AT = '2026-08-03T12:00:01.000Z'
const BINANCE_TRADER = 'portfolio-1'
const OKX_TRADER = 'okx-trader-1'
const BINANCE_BASE_OPENED_AT = Date.parse('2026-07-02T00:00:00.000Z')

type VerifiedV2 = Extract<BuiltPositionHistoryAcquisitionArtifactV2, { state: 'verified' }>

function sha1(...fields: string[]): string {
  return createHash('sha1').update(fields.join('|')).digest('hex')
}

function binanceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const opened = typeof overrides.opened === 'number' ? overrides.opened : BINANCE_BASE_OPENED_AT
  return {
    type: 'UM',
    symbol: 'BTCUSDT',
    side: 'Long',
    status: 'All Closed',
    opened,
    closed: opened + 60_000,
    roi: '0.1',
    leverage: '10',
    closedVolume: '2',
    avgCost: '60000.000',
    avgClosePrice: '61000',
    closingPnl: '0',
    ...overrides,
    // The reviewed Binance contract uses the positive millisecond `opened`
    // epoch as the position id. Keep the fixture incapable of drifting the
    // two coordinates independently when a test overrides the timestamp.
    id: opened,
  }
}

function binancePage(
  sort: 'CLOSING' | 'OPENING',
  rows: readonly Record<string, unknown>[],
  fetchedAt: string
): RawPage {
  return {
    pageIndex: 1,
    payload: {
      contract: BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT,
      portfolioId: BINANCE_TRADER,
      sort,
      request: { pageNumber: 1, pageSize: 50, portfolioId: BINANCE_TRADER, sort },
      response: {
        code: '000000',
        success: true,
        data: { list: rows, total: rows.length },
      },
    },
    url: BINANCE_POSITION_HISTORY_URL,
    fetchedAt,
  }
}

async function captureBinance(rows: readonly Record<string, unknown>[]) {
  const claim: HistoryTerminalClaim = {
    contract: HISTORY_TERMINAL_CLAIM_CONTRACT,
    observations: [
      { segment_id: 'closing', reason: 'reported_end', page_ordinal: 1 },
      { segment_id: 'opening', reason: 'reported_end', page_ordinal: 2 },
    ],
  }
  async function* stream(): AsyncGenerator<RawPage, HistoryTerminalClaim, void> {
    yield binancePage('CLOSING', rows, FIRST_FETCHED_AT)
    yield binancePage('OPENING', rows, LAST_FETCHED_AT)
    return claim
  }

  return captureHistoryAcquisition({
    source: { id: 1, slug: 'binance_futures' },
    traderId: 11,
    exchangeTraderId: BINANCE_TRADER,
    kind: 'position_history',
    cursor: null,
    attemptStartedAt: ATTEMPT_STARTED_AT,
    stream: stream(),
    terminalVerifier: binancePositionHistoryTerminalVerifier,
  })
}

async function buildBinanceV2(rows: readonly Record<string, unknown>[]): Promise<VerifiedV2> {
  const capture = await captureBinance(rows)
  const built = buildPositionHistoryAcquisitionArtifactV2({
    acquisition: capture.artifact,
    expectedAcquisition: {
      sourceRunId: capture.sourceRunId,
      sourceId: 1,
      sourceSlug: 'binance_futures',
      traderId: 11,
      exchangeTraderId: BINANCE_TRADER,
    },
  })
  if (built.state !== 'verified') {
    throw new Error(`expected verified Binance v2 acquisition, got ${built.reason}`)
  }
  return built
}

function okxRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uniqueCode: OKX_TRADER,
    instType: 'SWAP',
    ccy: 'USDT',
    subPosId: 'sub-position-1',
    instId: 'ETH-USDT-SWAP',
    posSide: 'long',
    openTime: String(Date.parse('2026-07-02T00:00:00.000Z')),
    closeTime: String(Date.parse('2026-07-02T00:01:00.000Z')),
    pnlRatio: '0.1',
    lever: '3',
    subPos: '2',
    openAvgPx: '3000',
    closeAvgPx: '3100',
    pnl: '12.50',
    ...overrides,
  }
}

async function buildOkxV2(rows: readonly Record<string, unknown>[]): Promise<VerifiedV2> {
  const after = rows.length > 0 ? String(rows.at(-1)?.subPosId) : null
  const firstUrl =
    'https://www.okx.com/api/v5/copytrading/public-subpositions-history' +
    `?instType=SWAP&limit=100&uniqueCode=${OKX_TRADER}`
  const claim: HistoryTerminalClaim = {
    contract: HISTORY_TERMINAL_CLAIM_CONTRACT,
    observations: [
      {
        segment_id: 'default',
        reason: 'empty_page',
        page_ordinal: rows.length > 0 ? 2 : 1,
      },
    ],
  }
  async function* stream(): AsyncGenerator<RawPage, HistoryTerminalClaim, void> {
    if (rows.length > 0) {
      yield {
        pageIndex: 1,
        payload: { data: rows, historyTraderIdentity: OKX_TRADER },
        url: firstUrl,
        fetchedAt: FIRST_FETCHED_AT,
      }
      yield {
        pageIndex: 2,
        payload: { data: [], historyTraderIdentity: OKX_TRADER },
        url: `${firstUrl}&after=${after}`,
        fetchedAt: LAST_FETCHED_AT,
      }
    } else {
      yield {
        pageIndex: 1,
        payload: { data: [], historyTraderIdentity: OKX_TRADER },
        url: firstUrl,
        fetchedAt: LAST_FETCHED_AT,
      }
    }
    return claim
  }

  const capture = await captureHistoryAcquisition({
    source: { id: 2, slug: 'okx_futures' },
    traderId: 22,
    exchangeTraderId: OKX_TRADER,
    kind: 'position_history',
    cursor: null,
    attemptStartedAt: ATTEMPT_STARTED_AT,
    stream: stream(),
    terminalVerifier: okxPositionHistoryTerminalVerifier,
  })
  const built = buildPositionHistoryAcquisitionArtifactV2({
    acquisition: capture.artifact,
    expectedAcquisition: {
      sourceRunId: capture.sourceRunId,
      sourceId: 2,
      sourceSlug: 'okx_futures',
      traderId: 22,
      exchangeTraderId: OKX_TRADER,
    },
  })
  if (built.state !== 'verified') {
    throw new Error(`expected verified OKX v2 acquisition, got ${built.reason}`)
  }
  return built
}

function lockedEvidence(built: VerifiedV2, rawObjectId = 41) {
  const sourceRunId = built.sourceRunId
  const sourceSlug = built.artifact.acquisition.source.slug
  return Object.freeze({
    contract: built.artifact.contract,
    trustScope: 'acquisition_and_source_facts' as const,
    acquisitionSourceRunId: built.artifact.acquisition_source_run_id,
    pointerSnapshot: Object.freeze({
      rawObjectId,
      sourceRunId,
      storagePath:
        `${sourceSlug}/history_trust/position_history/${sourceRunId}/` +
        `event_history_${sourceRunId}.json.gz`,
      fetchedAt:
        built.artifact.acquisition.pages.at(-1)?.fetched_at ??
        built.artifact.acquisition.attempt_started_at,
    }),
    candidateLedgerSha256: built.artifact.candidate_ledger_sha256,
    artifact: built.artifact,
  }) satisfies TokenTradeShadowEvidenceSnapshot
}

describe('token trade shadow projection plan', () => {
  it('projects a reviewed Binance fact with the outer run and parser-compatible identity', async () => {
    const built = await buildBinanceV2([binanceRow()])
    const plan = buildTokenTradeShadowPlan(lockedEvidence(built))
    const sourceFactId = JSON.stringify([
      BINANCE_TRADER,
      String(BINANCE_BASE_OPENED_AT),
      'BTCUSDT',
      'Long',
    ])

    expect(plan).toMatchObject({
      state: 'planned',
      persisted: false,
      rankEligible: false,
      sourceRunId: built.sourceRunId,
      acquisitionSourceRunId: built.artifact.acquisition_source_run_id,
      candidateLedgerSha256: built.artifact.candidate_ledger_sha256,
      factSetSha256: built.artifact.candidate_ledger.fact_set_sha256,
      observedCandidateCount: 2,
      uniqueSourceFactCount: 1,
      plannedFactCount: 1,
      unsupportedFactCount: 0,
    })
    expect(plan.sourceRunId).not.toBe(plan.acquisitionSourceRunId)
    expect(plan.facts[0]).toMatchObject({
      sourceContractId: 'binance-futures-position-history@1',
      sourceRunId: built.sourceRunId,
      sourceRowIdentity: sourceFactId,
      positionDedupeHash: sha1(
        'binance_ph',
        BINANCE_TRADER,
        String(BINANCE_BASE_OPENED_AT),
        'BTCUSDT',
        'Long'
      ),
      sourceSymbol: 'BTCUSDT',
      sourceAssetLocator: 'BTCUSDT',
      assetId: 'crypto:btc',
      normalizedToken: 'BTC',
      entryPrice: '60000.000',
      exitPrice: '61000',
      realizedPnlSource: '0',
      pnlTrustState: 'source_owned',
      priceTrustState: 'source_owned',
      costBasisTrustState: 'source_owned',
      fxRateToUsd: null,
      fxTrustState: 'unknown',
      rankEligible: false,
    })
    expect(plan.facts[0].declaredBlockerReasons).toContain(DA2_SHADOW_WRITER_CANARY_BLOCKER)
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.facts[0])).toBe(true)
  })

  it('projects OKX with the exact reviewed locator and parser-compatible SHA-1', async () => {
    const built = await buildOkxV2([okxRow()])
    const plan = buildTokenTradeShadowPlan(lockedEvidence(built, 42))

    expect(plan).toMatchObject({ state: 'planned', plannedFactCount: 1, rankEligible: false })
    expect(plan.facts[0]).toMatchObject({
      sourceContractId: 'okx-futures-position-history@1',
      sourceRawObjectId: 42,
      sourceRowIdentity: JSON.stringify([OKX_TRADER, 'sub-position-1']),
      positionDedupeHash: sha1('okx_ph', OKX_TRADER, 'sub-position-1'),
      sourceSymbol: 'ETH-USDT-SWAP',
      sourceAssetLocator: 'ETH-USDT-SWAP',
      assetId: 'crypto:eth',
      normalizedToken: 'ETH',
      realizedPnlSource: '12.50',
    })
  })

  it('keeps zero PnL but downgrades non-positive or absent prices to unknown', async () => {
    const built = await buildBinanceV2([
      binanceRow({ avgCost: '0', avgClosePrice: '-1', closingPnl: '0' }),
    ])
    const plan = buildTokenTradeShadowPlan(lockedEvidence(built))

    expect(plan.facts[0]).toMatchObject({
      entryPrice: null,
      exitPrice: null,
      realizedPnlSource: '0',
      pnlTrustState: 'source_owned',
      priceTrustState: 'unknown',
      costBasisTrustState: 'unknown',
    })
    expect(plan.facts[0].declaredBlockerReasons).toEqual(
      expect.arrayContaining(['source_entry_price_unknown', 'source_exit_price_unknown'])
    )

    const unknownPnl = buildTokenTradeShadowPlan(
      lockedEvidence(await buildBinanceV2([binanceRow({ closingPnl: null })]))
    )
    expect(unknownPnl.facts[0]).toMatchObject({
      realizedPnlSource: null,
      pnlTrustState: 'unknown',
    })
    expect(unknownPnl.facts[0].declaredBlockerReasons).toContain('source_realized_pnl_unknown')
  })

  it('matches every migration-reviewed CEX asset without ticker guessing', async () => {
    const mappings = [
      ['ADA', 'crypto:ada'],
      ['ATOM', 'crypto:atom'],
      ['AVAX', 'crypto:avax'],
      ['BNB', 'crypto:bnb'],
      ['BTC', 'crypto:btc'],
      ['DOGE', 'crypto:doge'],
      ['DOT', 'crypto:dot'],
      ['ETH', 'crypto:eth'],
      ['LINK', 'crypto:link'],
      ['LTC', 'crypto:ltc'],
      ['MATIC', 'crypto:matic'],
      ['NEAR', 'crypto:near'],
      ['SOL', 'crypto:sol'],
      ['UNI', 'crypto:uni'],
      ['XRP', 'crypto:xrp'],
    ] as const
    const newest = Date.parse('2026-07-02T00:00:00.000Z')
    const rows = mappings.map(([ticker], index) => {
      const opened = newest - index * 120_000
      return binanceRow({
        symbol: `${ticker}USDT`,
        opened,
        closed: opened + 60_000,
      })
    })
    const plan = buildTokenTradeShadowPlan(lockedEvidence(await buildBinanceV2(rows)))

    expect(plan).toMatchObject({
      state: 'planned',
      plannedFactCount: mappings.length,
      unsupportedFactCount: 0,
    })
    expect(
      Object.fromEntries(plan.facts.map((fact) => [fact.normalizedToken, fact.assetId]))
    ).toEqual(Object.fromEntries(mappings))
  })

  it('suppresses every mapped fact when one exact asset mapping is unsupported', async () => {
    const unsupportedOpenedAt = BINANCE_BASE_OPENED_AT - 120_000
    const built = await buildBinanceV2([
      binanceRow(),
      binanceRow({
        symbol: 'PEPEUSDT',
        opened: unsupportedOpenedAt,
        closed: unsupportedOpenedAt + 60_000,
      }),
    ])
    const plan = buildTokenTradeShadowPlan(lockedEvidence(built))

    expect(plan).toMatchObject({
      state: 'partial',
      reason: 'unsupported_asset_mapping',
      observedCandidateCount: 4,
      uniqueSourceFactCount: 2,
      plannedFactCount: 0,
      unsupportedFactCount: 1,
      facts: [],
    })
    expect(plan.unsupportedFacts).toEqual([
      {
        sourceFactId: JSON.stringify([
          BINANCE_TRADER,
          String(unsupportedOpenedAt),
          'PEPEUSDT',
          'Long',
        ]),
        sourceSymbol: 'PEPEUSDT',
      },
    ])
    expect(plan.blockerReasons).toEqual(
      expect.arrayContaining(['projection_run_receipt_required', 'unsupported_asset_mapping'])
    )
  })

  it('reports verified empty as unpersisted until a run receipt can tombstone older facts', async () => {
    const built = await buildOkxV2([])
    const plan = buildTokenTradeShadowPlan(lockedEvidence(built))

    expect(plan).toMatchObject({
      state: 'verified_empty',
      persisted: false,
      rankEligible: false,
      reason: 'true_empty_requires_projection_run_receipt',
      observedCandidateCount: 0,
      uniqueSourceFactCount: 0,
      plannedFactCount: 0,
      facts: [],
    })
    expect(plan.blockerReasons).toContain('projection_run_receipt_required')
  })

  it('rejects a close timestamp later than the locked observation clock', async () => {
    const capture = await captureBinance([
      binanceRow({ closed: Date.parse('2026-08-03T12:00:02.000Z') }),
    ])

    expect(capture.artifact.termination).toMatchObject({
      evidence_state: 'rejected',
      blocker_reasons: ['terminal_claim_rejected'],
      scan_terminal_state: 'unknown',
    })
    expect(
      buildPositionHistoryAcquisitionArtifactV2({
        acquisition: capture.artifact,
        expectedAcquisition: {
          sourceRunId: capture.sourceRunId,
          sourceId: 1,
          sourceSlug: 'binance_futures',
          traderId: 11,
          exchangeTraderId: BINANCE_TRADER,
        },
      })
    ).toEqual({
      state: 'unavailable',
      reason: 'verified_position_history_artifact_required',
    })
  })

  it('rejects nested/outer run confusion and any outer source-run drift', async () => {
    const built = await buildBinanceV2([binanceRow()])
    const evidence = lockedEvidence(built)

    expect(
      buildTokenTradeShadowPlan({
        ...evidence,
        acquisitionSourceRunId: '0'.repeat(64),
      })
    ).toMatchObject({ state: 'unavailable', reason: 'nested_source_run_mismatch' })
    expect(
      buildTokenTradeShadowPlan({
        ...evidence,
        pointerSnapshot: {
          ...evidence.pointerSnapshot,
          sourceRunId: built.artifact.acquisition_source_run_id,
        },
      })
    ).toMatchObject({
      state: 'unavailable',
      reason: 'outer_source_run_invalid:position_history_v2_source_run_mismatch',
    })
  })

  it('retains the candidate fact-set digest instead of inventing a projection digest', async () => {
    const built = await buildOkxV2([okxRow()])
    const plan = buildTokenTradeShadowPlan(lockedEvidence(built))

    expect(plan.factSetSha256).toBe(
      strictCanonicalSha256(
        built.artifact.candidate_ledger.source_facts.map((fact) => ({
          source_fact_id: fact.source_fact_id,
          canonical_fact_sha256: fact.canonical_fact_sha256,
        }))
      )
    )
  })
})
