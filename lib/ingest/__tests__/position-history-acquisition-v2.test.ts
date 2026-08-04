import {
  HISTORY_TERMINAL_CLAIM_CONTRACT,
  captureHistoryAcquisition,
  type HistoryAcquisitionArtifact,
  type HistoryTerminalClaim,
} from '@/lib/ingest/history-acquisition'
import {
  POSITION_HISTORY_ACQUISITION_ARTIFACT_V2_CONTRACT,
  buildPositionHistoryAcquisitionArtifactV2,
  parsePositionHistoryAcquisitionArtifactV2,
  positionHistoryAcquisitionArtifactV2SourceRunId,
  revalidatePositionHistoryAcquisitionArtifactV2,
} from '@/lib/ingest/position-history-acquisition-v2'
import { strictCanonicalSha256 } from '@/lib/ingest/strict-canonical-json'
import {
  BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT,
  BINANCE_POSITION_HISTORY_URL,
} from '@/lib/ingest/adapters/binance/history-contract'
import { binancePositionHistoryTerminalVerifier } from '@/lib/ingest/adapters/binance/history-terminal'
import type { RawPage } from '@/lib/ingest/core/types'

const exchangeTraderId = 'portfolio-1'

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function row(_fixtureId: string, ordinal = 0, pnl: string = '12.5'): Record<string, unknown> {
  const opened = Date.parse('2026-07-02T00:00:00.000Z') - ordinal * 120_000
  return {
    id: opened,
    type: 'UM',
    symbol: 'BTCUSDT',
    side: 'Long',
    status: 'All Closed',
    opened,
    closed: opened + 60_000,
    roi: '0.1',
    leverage: '10',
    closedVolume: '2',
    avgCost: '60000',
    avgClosePrice: '61000',
    closingPnl: pnl,
  }
}

async function captured(rows: Array<Record<string, unknown>>) {
  const payload = {
    contract: BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT,
    portfolioId: exchangeTraderId,
    sort: 'CLOSING',
    request: {
      pageNumber: 1,
      pageSize: 50,
      portfolioId: exchangeTraderId,
      sort: 'CLOSING',
    },
    response: {
      code: '000000',
      success: true,
      data: { list: rows, total: rows.length },
    },
  }
  const claim: HistoryTerminalClaim = {
    contract: HISTORY_TERMINAL_CLAIM_CONTRACT,
    observations: [{ segment_id: 'closing', reason: 'reported_end', page_ordinal: 1 }],
  }
  async function* stream(): AsyncGenerator<RawPage, HistoryTerminalClaim, void> {
    yield {
      pageIndex: 1,
      payload,
      url: BINANCE_POSITION_HISTORY_URL,
      fetchedAt: '2026-08-03T12:00:01.000Z',
    }
    return claim
  }
  return captureHistoryAcquisition({
    source: { id: 1, slug: 'binance_futures' },
    traderId: 2,
    exchangeTraderId,
    kind: 'position_history',
    cursor: '2026-07-01T00:00:00.000Z',
    attemptStartedAt: '2026-08-03T12:00:00.000Z',
    stream: stream(),
    terminalVerifier: binancePositionHistoryTerminalVerifier,
  })
}

function acquisitionAnchor(acquisition: HistoryAcquisitionArtifact) {
  return {
    sourceRunId: strictCanonicalSha256(acquisition),
    sourceId: acquisition.source.id,
    sourceSlug: acquisition.source.slug,
    traderId: acquisition.trader.id,
    exchangeTraderId: acquisition.trader.exchange_trader_id,
  }
}

function verifiedV2(acquisition: HistoryAcquisitionArtifact) {
  const built = buildPositionHistoryAcquisitionArtifactV2({
    acquisition,
    expectedAcquisition: acquisitionAnchor(acquisition),
  })
  if (built.state !== 'verified') {
    throw new Error(`expected verified v2 acquisition, got ${built.reason}`)
  }
  return built
}

function factSetSha(
  facts: Array<{ source_fact_id: string; canonical_fact_sha256: string }>
): string {
  return strictCanonicalSha256(
    facts.map((fact) => ({
      source_fact_id: fact.source_fact_id,
      canonical_fact_sha256: fact.canonical_fact_sha256,
    }))
  )
}

describe('position-history acquisition artifact v2', () => {
  it('wraps the exact @1 acquisition and candidate ledger into a deterministic proof', async () => {
    const acquisition = (await captured([row('fact-1')])).artifact
    const built = verifiedV2(acquisition)
    const rebuilt = verifiedV2(acquisition)

    expect(built.artifact).toMatchObject({
      contract: POSITION_HISTORY_ACQUISITION_ARTIFACT_V2_CONTRACT,
      acquisition,
      acquisition_source_run_id: strictCanonicalSha256(acquisition),
      candidate_ledger: {
        acquisition_source_run_id: strictCanonicalSha256(acquisition),
        source_id: 1,
        trader_id: 2,
        exchange_trader_id: exchangeTraderId,
        observed_candidate_count: 1,
      },
    })
    expect(built.artifact.candidate_ledger_sha256).toBe(
      strictCanonicalSha256(built.artifact.candidate_ledger)
    )
    expect(built.sourceRunId).toBe(positionHistoryAcquisitionArtifactV2SourceRunId(built.artifact))
    expect(rebuilt).toEqual(built)
    expect(Object.isFrozen(built.artifact)).toBe(true)
    expect(Object.isFrozen(built.artifact.acquisition.pages[0].payload)).toBe(true)
  })

  it('requires an external immutable @1 acquisition anchor during upgrade', async () => {
    const acquisition = (await captured([row('fact-1')])).artifact

    expect(
      buildPositionHistoryAcquisitionArtifactV2({
        acquisition,
        expectedAcquisition: { ...acquisitionAnchor(acquisition), sourceRunId: '0'.repeat(64) },
      })
    ).toEqual({ state: 'unavailable', reason: 'acquisition_anchor_mismatch' })
  })

  it('keeps unregistered sources RAW-only even when their @1 shape is valid', async () => {
    const acquisition = jsonClone((await captured([])).artifact)
    acquisition.source.slug = 'unreviewed_futures'

    expect(
      buildPositionHistoryAcquisitionArtifactV2({
        acquisition,
        expectedAcquisition: acquisitionAnchor(acquisition),
      })
    ).toEqual({ state: 'unavailable', reason: 'source_fact_contract_unavailable' })
  })

  it('does not reinterpret a legacy @1 acquisition as @2', async () => {
    const acquisition = (await captured([])).artifact
    expect(() => parsePositionHistoryAcquisitionArtifactV2(acquisition)).toThrow()
  })

  it('strictly rejects nested acquisition and candidate-ledger digest tampering', async () => {
    const acquisition = (await captured([row('fact-1')])).artifact
    const built = verifiedV2(acquisition)
    const acquisitionDigest = jsonClone(built.artifact)
    acquisitionDigest.acquisition_source_run_id = '0'.repeat(64)
    const ledgerDigest = jsonClone(built.artifact)
    ledgerDigest.candidate_ledger_sha256 = '0'.repeat(64)

    expect(() => parsePositionHistoryAcquisitionArtifactV2(acquisitionDigest)).toThrow()
    expect(() => parsePositionHistoryAcquisitionArtifactV2(ledgerDigest)).toThrow()
  })

  it('rejects unknown outer keys instead of treating them as future trust claims', async () => {
    const acquisition = (await captured([row('fact-1')])).artifact
    const built = verifiedV2(acquisition)
    const withClaim = Object.assign(jsonClone(built.artifact), { parser_complete: true })

    expect(() => parsePositionHistoryAcquisitionArtifactV2(withClaim)).toThrow()
  })

  it('replays the complete proof only under its immutable outer source-run identity', async () => {
    const acquisition = (await captured([row('fact-1')])).artifact
    const built = verifiedV2(acquisition)

    expect(
      revalidatePositionHistoryAcquisitionArtifactV2({
        artifact: built.artifact,
        expectedSourceRunId: built.sourceRunId,
      })
    ).toMatchObject({
      verified: true,
      sourceRunId: built.sourceRunId,
      candidateLedgerSha256: built.artifact.candidate_ledger_sha256,
    })
    expect(
      revalidatePositionHistoryAcquisitionArtifactV2({
        artifact: built.artifact,
        expectedSourceRunId: '0'.repeat(64),
      })
    ).toEqual({ verified: false, reason: 'position_history_v2_source_run_mismatch' })
    expect(
      revalidatePositionHistoryAcquisitionArtifactV2({
        artifact: built.artifact,
        expectedSourceRunId: built.artifact.acquisition_source_run_id,
      })
    ).toEqual({ verified: false, reason: 'position_history_v2_source_run_mismatch' })
    expect(
      revalidatePositionHistoryAcquisitionArtifactV2({
        artifact: built.artifact,
        expectedSourceRunId: 'not-a-sha',
      })
    ).toEqual({ verified: false, reason: 'position_history_v2_source_run_invalid' })
  })

  it('semantically verifies a captured zero-candidate artifact instead of inferring empty', async () => {
    const acquisition = (await captured([])).artifact
    const built = verifiedV2(acquisition)

    expect(built.artifact.candidate_ledger).toMatchObject({
      observed_candidate_count: 0,
      unique_source_fact_count: 0,
      source_facts: [],
    })
    expect(
      revalidatePositionHistoryAcquisitionArtifactV2({
        artifact: built.artifact,
        expectedSourceRunId: built.sourceRunId,
      })
    ).toMatchObject({ verified: true, sourceRunId: built.sourceRunId })
  })

  it('rejects a structurally rehashed forged terminal envelope during semantic replay', async () => {
    const acquisition = (await captured([row('fact-1')])).artifact
    const built = verifiedV2(acquisition)
    const forged = jsonClone(built.artifact)
    ;(forged.acquisition.pages[0].payload as { portfolioId: string }).portfolioId = 'another-trader'
    forged.acquisition.pages[0].payload_sha256 = strictCanonicalSha256(
      forged.acquisition.pages[0].payload
    )
    forged.acquisition_source_run_id = strictCanonicalSha256(forged.acquisition)
    forged.candidate_ledger.acquisition_source_run_id = forged.acquisition_source_run_id
    forged.candidate_ledger_sha256 = strictCanonicalSha256(forged.candidate_ledger)
    const forgedSourceRunId = strictCanonicalSha256(forged)

    expect(parsePositionHistoryAcquisitionArtifactV2(forged)).toBeDefined()
    expect(
      revalidatePositionHistoryAcquisitionArtifactV2({
        artifact: forged,
        expectedSourceRunId: forgedSourceRunId,
      })
    ).toEqual({
      verified: false,
      reason: 'candidate_ledger_revalidation_failed:terminal_evidence_revalidation_failed',
    })
  })

  it('rejects a fully self-consistent candidate omission even under the recomputed outer hash', async () => {
    const acquisition = (await captured([row('fact-1', 0), row('fact-2', 1)])).artifact
    const built = verifiedV2(acquisition)
    const omitted = jsonClone(built.artifact)
    const removedFactId =
      omitted.candidate_ledger.segments[0].pages[0].occurrences.pop()!.source_fact_id
    omitted.candidate_ledger.segments[0].pages[0].candidate_count = 1
    omitted.candidate_ledger.observed_candidate_count = 1
    omitted.candidate_ledger.source_facts = omitted.candidate_ledger.source_facts.filter(
      (fact) => fact.source_fact_id !== removedFactId
    )
    omitted.candidate_ledger.unique_source_fact_count = 1
    omitted.candidate_ledger.fact_set_sha256 = factSetSha(omitted.candidate_ledger.source_facts)
    omitted.candidate_ledger_sha256 = strictCanonicalSha256(omitted.candidate_ledger)
    const omittedSourceRunId = strictCanonicalSha256(omitted)

    expect(parsePositionHistoryAcquisitionArtifactV2(omitted)).toBeDefined()
    expect(
      revalidatePositionHistoryAcquisitionArtifactV2({
        artifact: omitted,
        expectedSourceRunId: omittedSourceRunId,
      })
    ).toEqual({
      verified: false,
      reason: 'candidate_ledger_revalidation_failed:source_fact_ledger_mismatch',
    })
  })

  it('rejects simultaneous artifact and ledger replacement under the prior immutable outer anchor', async () => {
    const firstAcquisition = (await captured([row('fact-1', 0, '1')])).artifact
    const secondAcquisition = (await captured([row('fact-1', 0, '2')])).artifact
    const first = verifiedV2(firstAcquisition)
    const replacement = verifiedV2(secondAcquisition)

    expect(
      revalidatePositionHistoryAcquisitionArtifactV2({
        artifact: replacement.artifact,
        expectedSourceRunId: first.sourceRunId,
      })
    ).toEqual({ verified: false, reason: 'position_history_v2_source_run_mismatch' })
  })
})
