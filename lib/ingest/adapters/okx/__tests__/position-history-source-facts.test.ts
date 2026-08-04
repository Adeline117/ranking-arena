import {
  HISTORY_ACQUISITION_ARTIFACT_CONTRACT,
  parseHistoryAcquisitionArtifact,
  type HistoryAcquisitionArtifact,
} from '@/lib/ingest/history-acquisition'
import {
  buildPositionHistorySourceFactEvidence,
  revalidatePositionHistorySourceFactLedger,
} from '@/lib/ingest/position-history-source-facts'
import {
  STRICT_CANONICAL_JSON_CONTRACT,
  strictCanonicalSha256,
} from '@/lib/ingest/strict-canonical-json'
import { OKX_POSITION_HISTORY_TERMINAL_VERIFIER_CONTRACT } from '../history-terminal'
import { OKX_POSITION_HISTORY_SOURCE_FACT_CONTRACT } from '../position-history-source-facts'

const exchangeTraderId = 'F503A5D5F1F6989F'
const opened = Date.parse('2026-07-02T00:00:00.000Z')
const closed = Date.parse('2026-07-02T01:00:00.000Z')

function row(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subPosId: '3565759517483933696',
    instId: 'BTC-USDT-SWAP',
    uniqueCode: exchangeTraderId,
    instType: 'SWAP',
    ccy: 'USDT',
    posSide: 'short',
    openTime: String(opened),
    closeTime: String(closed),
    pnlRatio: '0.0264676747236307',
    lever: '2E+1',
    subPos: '1.15',
    openAvgPx: '80907.7',
    closeAvgPx: '80741.9',
    pnl: '1.2313272445863314',
    ...patch,
  }
}

function artifact(rows: Record<string, unknown>[]): HistoryAcquisitionArtifact {
  const pages = [
    {
      ordinal: 1,
      stored_page_index: 1,
      url:
        'https://www.okx.com/api/v5/copytrading/public-subpositions-history' +
        `?instType=SWAP&uniqueCode=${exchangeTraderId}&limit=100`,
      fetched_at: '2026-08-03T12:00:01.000Z',
      payload: { data: rows, historyTraderIdentity: exchangeTraderId },
    },
    {
      ordinal: 2,
      stored_page_index: 2,
      url:
        'https://www.okx.com/api/v5/copytrading/public-subpositions-history' +
        `?instType=SWAP&uniqueCode=${exchangeTraderId}&limit=100` +
        `&after=${String(rows.at(-1)?.subPosId ?? '')}`,
      fetched_at: '2026-08-03T12:00:02.000Z',
      payload: { data: [], historyTraderIdentity: exchangeTraderId },
    },
  ].map((page) => ({ ...page, payload_sha256: strictCanonicalSha256(page.payload) }))

  return parseHistoryAcquisitionArtifact({
    contract: HISTORY_ACQUISITION_ARTIFACT_CONTRACT,
    serialization_contract: STRICT_CANONICAL_JSON_CONTRACT,
    source: { id: 9, slug: 'okx_futures' },
    trader: { id: 22, exchange_trader_id: exchangeTraderId },
    history_kind: 'position_history',
    attempt_started_at: '2026-08-03T12:00:00.000Z',
    starting_cursor: null,
    capture_config: { caller_page_cap: null },
    pages,
    termination: {
      evidence_state: 'verified',
      claim_observations: [{ segment_id: 'default', reason: 'empty_page', page_ordinal: 2 }],
      verifier_contract: OKX_POSITION_HISTORY_TERMINAL_VERIFIER_CONTRACT,
      scan_terminal_state: 'exhausted',
      terminal_cursor_value: null,
      overlap_event_at: null,
      blocker_reasons: [],
    },
  })
}

function verifiedEvidence(rawArtifact: HistoryAcquisitionArtifact) {
  const evidence = buildPositionHistorySourceFactEvidence({ artifact: rawArtifact })
  if (evidence.state !== 'verified') {
    throw new Error(`expected verified source facts, got ${evidence.reason}`)
  }
  return evidence
}

describe('OKX position-history source fact contract', () => {
  it('binds every terminally verified RAW row to exact source-owned fields', () => {
    const rawArtifact = artifact([row()])
    const evidence = verifiedEvidence(rawArtifact)

    expect(evidence.ledger).toMatchObject({
      source_slug: 'okx_futures',
      terminal_verifier_contract: OKX_POSITION_HISTORY_TERMINAL_VERIFIER_CONTRACT,
      source_fact_contract: OKX_POSITION_HISTORY_SOURCE_FACT_CONTRACT,
      duplicate_policy: 'forbid',
      require_identical_segment_fact_sets: false,
      observed_candidate_count: 1,
      unique_source_fact_count: 1,
      segments: [
        {
          segment_id: 'default',
          candidate_path: ['data'],
          pages: [
            { page_ordinal: 1, candidate_count: 1 },
            { page_ordinal: 2, candidate_count: 0 },
          ],
        },
      ],
    })
    expect(evidence.ledger.source_facts[0].fact).toEqual({
      sourceFactId: JSON.stringify([exchangeTraderId, '3565759517483933696']),
      sourceLifecycleMarker: String(closed),
      sourceReturn: 0.0264676747236307,
      openedAt: new Date(opened).toISOString(),
      closedAt: new Date(closed).toISOString(),
      symbol: 'BTC-USDT-SWAP',
      side: 'short',
      leverage: 20,
      size: 1.15,
      entryPrice: 80907.7,
      exitPrice: 80741.9,
      realizedPnl: 1.2313272445863314,
      sourceNumericScalars: {
        sourceReturn: '0.0264676747236307',
        leverage: '2E+1',
        size: '1.15',
        entryPrice: '80907.7',
        exitPrice: '80741.9',
        realizedPnl: '1.2313272445863314',
      },
    })
    expect(
      revalidatePositionHistorySourceFactLedger({
        artifact: rawArtifact,
        ledger: evidence.ledger,
        expectedAcquisition: {
          sourceRunId: strictCanonicalSha256(rawArtifact),
          sourceId: 9,
          sourceSlug: 'okx_futures',
          traderId: 22,
          exchangeTraderId,
        },
      })
    ).toEqual({ verified: true, ledgerSha256: evidence.ledgerSha256 })
  })

  it('preserves genuine zero while leaving absent numeric evidence unknown', () => {
    const evidence = verifiedEvidence(
      artifact([
        row({
          pnlRatio: 0,
          pnl: '0',
          lever: null,
          subPos: null,
          openAvgPx: '   ',
          closeAvgPx: {},
        }),
      ])
    )

    expect(evidence.ledger.source_facts[0].fact).toMatchObject({
      sourceReturn: 0,
      leverage: null,
      size: null,
      entryPrice: null,
      exitPrice: null,
      realizedPnl: 0,
      sourceNumericScalars: {
        sourceReturn: '0',
        leverage: null,
        size: null,
        entryPrice: null,
        exitPrice: null,
        realizedPnl: '0',
      },
    })
  })

  it.each([
    ['cross-account row', { uniqueCode: 'another-trader' }],
    ['wrong instrument type', { instType: 'SPOT' }],
    ['wrong settlement currency', { ccy: 'BTC' }],
    ['non-USDT swap', { instId: 'BTC-USDC-SWAP' }],
    ['unsupported side', { posSide: 'net' }],
    ['future close time', { closeTime: String(Date.parse('2026-08-03T12:00:01.001Z')) }],
  ])('rejects %s before source-fact materialization', (_case, patch) => {
    expect(buildPositionHistorySourceFactEvidence({ artifact: artifact([row(patch)]) })).toEqual({
      state: 'unavailable',
      reason: 'terminal_evidence_revalidation_failed',
    })
  })

  it.each([
    ['missing identity', { subPosId: '' }, 'terminal_evidence_revalidation_failed'],
    [
      'partial lifecycle',
      { closeTime: '' },
      'candidate_unavailable:okx_source_fact_identity_or_lifecycle_invalid',
    ],
    ['invalid lifecycle', { closeTime: 0 }, 'terminal_evidence_revalidation_failed'],
    [
      'reversed lifecycle',
      { openTime: String(closed + 1) },
      'terminal_evidence_revalidation_failed',
    ],
  ])('fails closed for %s', (_case, patch, reason) => {
    const rawArtifact = artifact([row(patch)])

    expect(buildPositionHistorySourceFactEvidence({ artifact: rawArtifact })).toEqual({
      state: 'unavailable',
      reason,
    })
  })
})
