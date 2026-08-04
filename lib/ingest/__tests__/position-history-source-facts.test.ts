import {
  HISTORY_ACQUISITION_ARTIFACT_CONTRACT,
  parseHistoryAcquisitionArtifact,
  type HistoryAcquisitionArtifact,
} from '@/lib/ingest/history-acquisition'
import {
  POSITION_HISTORY_SOURCE_FACT_LEDGER_CONTRACT,
  buildPositionHistorySourceFactEvidence,
  parsePositionHistorySourceFactLedger,
  revalidatePositionHistorySourceFactLedger,
} from '@/lib/ingest/position-history-source-facts'
import {
  STRICT_CANONICAL_JSON_CONTRACT,
  strictCanonicalSha256,
} from '@/lib/ingest/strict-canonical-json'
import {
  BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT,
  BINANCE_POSITION_HISTORY_URL,
} from '@/lib/ingest/adapters/binance/history-contract'
import { BINANCE_POSITION_HISTORY_TERMINAL_VERIFIER_CONTRACT } from '@/lib/ingest/adapters/binance/history-terminal'
import { BINANCE_POSITION_HISTORY_SOURCE_FACT_CONTRACT } from '@/lib/ingest/adapters/binance/position-history-source-facts'

const exchangeTraderId = 'portfolio-1'

type BinanceCandidate = Record<string, unknown> & {
  id: number
  type: 'UM'
  symbol: string
  side: string
  status: string
  opened: number
  closed: number
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function row(
  _fixtureId: string,
  ordinal = 0,
  patch: Record<string, unknown> = {}
): BinanceCandidate {
  const opened = Date.parse('2026-07-02T00:00:00.000Z') - ordinal * 120_000
  return {
    id: opened,
    type: 'UM',
    symbol: 'BTCUSDT',
    side: 'Long',
    status: 'All Closed',
    opened,
    closed: opened + 60_000,
    roi: '0.125000000000000001',
    leverage: '25',
    closedVolume: '2.5',
    avgCost: '60000.123456789012345678',
    avgClosePrice: '61000.123456789012345678',
    closingPnl: '2500.123456789012345678',
    ...patch,
  }
}

function pagePayload(
  sort: 'CLOSING' | 'OPENING',
  pageNumber: number,
  rows: BinanceCandidate[],
  total: number
): Record<string, unknown> {
  return {
    contract: BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT,
    portfolioId: exchangeTraderId,
    sort,
    request: {
      pageNumber,
      pageSize: 50,
      portfolioId: exchangeTraderId,
      sort,
    },
    response: {
      code: '000000',
      success: true,
      data: { list: rows, total },
    },
  }
}

function artifact(input: {
  closing: BinanceCandidate[][]
  opening?: BinanceCandidate[][]
  cursor?: string | null
}): HistoryAcquisitionArtifact {
  const cursor = input.cursor === undefined ? '2026-07-01T00:00:00.000Z' : input.cursor
  const segments: Array<{
    id: 'closing' | 'opening'
    sort: 'CLOSING' | 'OPENING'
    pages: BinanceCandidate[][]
  }> = [{ id: 'closing', sort: 'CLOSING', pages: input.closing }]
  if (cursor === null) {
    if (!input.opening) throw new Error('Binance genesis fixtures require opening pages')
    segments.push({ id: 'opening', sort: 'OPENING', pages: input.opening })
  }

  let captureOrdinal = 0
  const pages: Array<Record<string, unknown>> = []
  const observations: Array<{
    segment_id: string
    reason: 'reported_end'
    page_ordinal: number
  }> = []
  for (const segment of segments) {
    const total = segment.pages.reduce((sum, candidates) => sum + candidates.length, 0)
    segment.pages.forEach((candidates, localIndex) => {
      captureOrdinal += 1
      const payload = pagePayload(segment.sort, localIndex + 1, candidates, total)
      pages.push({
        ordinal: captureOrdinal,
        stored_page_index: localIndex + 1,
        url: BINANCE_POSITION_HISTORY_URL,
        fetched_at: `2026-08-03T12:00:${String(captureOrdinal).padStart(2, '0')}.000Z`,
        payload_sha256: strictCanonicalSha256(payload),
        payload,
      })
    })
    observations.push({
      segment_id: segment.id,
      reason: 'reported_end',
      page_ordinal: captureOrdinal,
    })
  }

  return parseHistoryAcquisitionArtifact({
    contract: HISTORY_ACQUISITION_ARTIFACT_CONTRACT,
    serialization_contract: STRICT_CANONICAL_JSON_CONTRACT,
    source: { id: 1, slug: 'binance_futures' },
    trader: { id: 2, exchange_trader_id: exchangeTraderId },
    history_kind: 'position_history',
    attempt_started_at: '2026-08-03T12:00:00.000Z',
    starting_cursor: cursor,
    capture_config: { caller_page_cap: null },
    pages,
    termination: {
      evidence_state: 'verified',
      claim_observations: observations,
      verifier_contract: BINANCE_POSITION_HISTORY_TERMINAL_VERIFIER_CONTRACT,
      scan_terminal_state: 'exhausted',
      terminal_cursor_value: null,
      overlap_event_at: null,
      blocker_reasons: [],
    },
  })
}

function verifiedEvidence(rawArtifact: unknown) {
  const evidence = buildPositionHistorySourceFactEvidence({ artifact: rawArtifact })
  if (evidence.state !== 'verified') {
    throw new Error(`expected verified source facts, got ${evidence.reason}`)
  }
  return evidence
}

function acquisitionAnchor(rawArtifact: HistoryAcquisitionArtifact) {
  return {
    sourceRunId: strictCanonicalSha256(rawArtifact),
    sourceId: rawArtifact.source.id,
    sourceSlug: rawArtifact.source.slug,
    traderId: rawArtifact.trader.id,
    exchangeTraderId: rawArtifact.trader.exchange_trader_id,
  }
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

describe('position-history framework-owned source fact ledger', () => {
  it('proves true empty only after the closed-registry terminal verifier replays captured RAW', () => {
    const rawArtifact = artifact({ closing: [[]], opening: [[]], cursor: null })
    const evidence = verifiedEvidence(rawArtifact)

    expect(evidence.ledger).toMatchObject({
      contract: POSITION_HISTORY_SOURCE_FACT_LEDGER_CONTRACT,
      acquisition_contract: HISTORY_ACQUISITION_ARTIFACT_CONTRACT,
      acquisition_source_run_id: strictCanonicalSha256(rawArtifact),
      source_id: 1,
      source_slug: 'binance_futures',
      trader_id: 2,
      exchange_trader_id: exchangeTraderId,
      terminal_verifier_contract: BINANCE_POSITION_HISTORY_TERMINAL_VERIFIER_CONTRACT,
      source_fact_contract: BINANCE_POSITION_HISTORY_SOURCE_FACT_CONTRACT,
      observed_candidate_count: 0,
      unique_source_fact_count: 0,
      segments: [
        {
          segment_id: 'closing',
          candidate_path: ['response', 'data', 'list'],
          pages: [{ page_ordinal: 1, candidate_count: 0, occurrences: [] }],
        },
        {
          segment_id: 'opening',
          candidate_path: ['response', 'data', 'list'],
          pages: [{ page_ordinal: 2, candidate_count: 0, occurrences: [] }],
        },
      ],
      source_facts: [],
    })
    expect(evidence.ledger.fact_set_sha256).toBe(strictCanonicalSha256([]))
    expect(Object.isFrozen(evidence.ledger)).toBe(true)
    expect(Object.isFrozen(evidence.ledger.segments[0].pages[0])).toBe(true)
  })

  it('uses the closed-registry path even when the payload exposes an empty alternate array', () => {
    const rawArtifact = artifact({ closing: [[row('fact-1')]] })
    const payload = rawArtifact.pages[0].payload as {
      response: { data: Record<string, unknown> }
    }
    const forgedArtifact = jsonClone(rawArtifact)
    ;(
      forgedArtifact.pages[0].payload as { response: { data: Record<string, unknown> } }
    ).response.data.empty = []
    forgedArtifact.pages[0].payload_sha256 = strictCanonicalSha256(forgedArtifact.pages[0].payload)
    const evidence = verifiedEvidence(forgedArtifact)

    expect(payload.response.data.list).toHaveLength(1)
    expect(evidence.ledger.observed_candidate_count).toBe(1)
    expect(evidence.ledger.segments[0].candidate_path).toEqual(['response', 'data', 'list'])
  })

  it('reruns terminal verification instead of trusting a hand-authored verified label', () => {
    const forged = jsonClone(artifact({ closing: [[]] }))
    ;(forged.pages[0].payload as { portfolioId: string }).portfolioId = 'another-trader'
    forged.pages[0].payload_sha256 = strictCanonicalSha256(forged.pages[0].payload)

    expect(buildPositionHistorySourceFactEvidence({ artifact: forged })).toEqual({
      state: 'unavailable',
      reason: 'terminal_evidence_revalidation_failed',
    })
  })

  it('rejects parsed artifacts whose source and verifier have no reviewed registry entry', () => {
    const forged = jsonClone(artifact({ closing: [[]] }))
    forged.source.slug = 'unreviewed_futures'

    expect(buildPositionHistorySourceFactEvidence({ artifact: forged })).toEqual({
      state: 'unavailable',
      reason: 'source_fact_contract_unavailable',
    })
  })

  it('enumerates every global page and candidate before parser projection', () => {
    const first = row('fact-1', 0)
    const second = row('fact-2', 1)
    const evidence = verifiedEvidence(artifact({ closing: [[first], [second]] }))

    expect(evidence.ledger.observed_candidate_count).toBe(2)
    expect(evidence.ledger.unique_source_fact_count).toBe(2)
    expect(evidence.ledger.segments[0].pages).toEqual([
      {
        page_ordinal: 1,
        candidate_count: 1,
        occurrences: [
          expect.objectContaining({
            row_ordinal: 1,
            raw_candidate_sha256: strictCanonicalSha256(first),
          }),
        ],
      },
      {
        page_ordinal: 2,
        candidate_count: 1,
        occurrences: [
          expect.objectContaining({
            row_ordinal: 1,
            raw_candidate_sha256: strictCanonicalSha256(second),
          }),
        ],
      },
    ])
  })

  it('binds Binance genesis segments to global ordinals and collapses only exact facts', () => {
    const closing = row('same', 0, { view: 'closing' })
    const opening = row('same', 0, { view: 'opening' })
    const rawArtifact = artifact({ closing: [[closing]], opening: [[opening]], cursor: null })
    const evidence = verifiedEvidence(rawArtifact)

    expect(rawArtifact.pages.map((page) => page.stored_page_index)).toEqual([1, 1])
    expect(evidence.ledger.observed_candidate_count).toBe(2)
    expect(evidence.ledger.unique_source_fact_count).toBe(1)
    expect(evidence.ledger.segments.map((segment) => segment.pages[0].page_ordinal)).toEqual([1, 2])
    expect(
      evidence.ledger.segments.map(
        (segment) => segment.pages[0].occurrences[0].raw_candidate_sha256
      )
    ).toEqual([strictCanonicalSha256(closing), strictCanonicalSha256(opening)])
    expect(
      new Set(
        evidence.ledger.segments.map(
          (segment) => segment.pages[0].occurrences[0].canonical_fact_sha256
        )
      ).size
    ).toBe(1)
    expect(
      revalidatePositionHistorySourceFactLedger({
        artifact: rawArtifact,
        ledger: evidence.ledger,
        expectedAcquisition: acquisitionAnchor(rawArtifact),
      })
    ).toEqual({ verified: true, ledgerSha256: evidence.ledgerSha256 })
  })

  it('rejects same-id cross-segment economic conflicts missed by terminal set comparison', () => {
    const rawArtifact = artifact({
      closing: [[row('same', 0, { closingPnl: '1.000000000000000001' })]],
      opening: [[row('same', 0, { closingPnl: '1.000000000000000002' })]],
      cursor: null,
    })

    expect(buildPositionHistorySourceFactEvidence({ artifact: rawArtifact })).toEqual({
      state: 'unavailable',
      reason: 'source_fact_cross_segment_conflict',
    })
  })

  it('preserves captured numeric-string spelling when JS numbers would collapse decimals', () => {
    const left = '9007199254740992.000000000000000001'
    const right = '9007199254740992.000000000000000002'
    expect(Number(left)).toBe(Number(right))
    const rawArtifact = artifact({
      closing: [[row('same', 0, { closingPnl: left })]],
      opening: [[row('same', 0, { closingPnl: right })]],
      cursor: null,
    })

    expect(buildPositionHistorySourceFactEvidence({ artifact: rawArtifact })).toEqual({
      state: 'unavailable',
      reason: 'source_fact_cross_segment_conflict',
    })
  })

  it('records decoded JSON numbers without claiming their original wire-token spelling', () => {
    const left = JSON.parse('{"value":9007199254740992.000000000000000001}') as {
      value: number
    }
    const right = JSON.parse('{"value":9007199254740992.000000000000000002}') as {
      value: number
    }
    expect(left.value).toBe(right.value)
    const evidence = verifiedEvidence(
      artifact({
        closing: [[row('same', 0, { closingPnl: left.value })]],
        opening: [[row('same', 0, { closingPnl: right.value })]],
        cursor: null,
      })
    )

    expect(evidence.ledger.source_facts[0].fact.sourceNumericScalars.realizedPnl).toBe(
      String(left.value)
    )
  })

  it('keeps absent economic fields null without inventing price, cost, or PnL', () => {
    const partial = row('fact-1')
    delete partial.roi
    delete partial.leverage
    delete partial.closedVolume
    delete partial.avgCost
    delete partial.avgClosePrice
    delete partial.closingPnl
    const evidence = verifiedEvidence(artifact({ closing: [[partial]] }))

    expect(evidence.ledger.source_facts[0].fact).toMatchObject({
      sourceReturn: null,
      leverage: null,
      size: null,
      entryPrice: null,
      exitPrice: null,
      realizedPnl: null,
      sourceNumericScalars: {
        sourceReturn: null,
        leverage: null,
        size: null,
        entryPrice: null,
        exitPrice: null,
        realizedPnl: null,
      },
    })
  })

  it('recomputes RAW hashes instead of trusting a tampered serialized occurrence', () => {
    const rawArtifact = artifact({ closing: [[row('fact-1')]] })
    const evidence = verifiedEvidence(rawArtifact)
    const tampered = jsonClone(evidence.ledger)
    tampered.segments[0].pages[0].occurrences[0].raw_candidate_sha256 = '0'.repeat(64)

    expect(parsePositionHistorySourceFactLedger(tampered)).toBeDefined()
    expect(
      revalidatePositionHistorySourceFactLedger({
        artifact: rawArtifact,
        ledger: tampered,
        expectedAcquisition: acquisitionAnchor(rawArtifact),
      })
    ).toEqual({ verified: false, reason: 'source_fact_ledger_mismatch' })
  })

  it('detects a fully self-consistent omitted candidate only by replaying RAW', () => {
    const rawArtifact = artifact({ closing: [[row('fact-1', 0), row('fact-2', 1)]] })
    const evidence = verifiedEvidence(rawArtifact)
    const omitted = jsonClone(evidence.ledger)
    const removedFactId = omitted.segments[0].pages[0].occurrences.pop()!.source_fact_id
    omitted.segments[0].pages[0].candidate_count = 1
    omitted.observed_candidate_count = 1
    omitted.source_facts = omitted.source_facts.filter(
      (fact) => fact.source_fact_id !== removedFactId
    )
    omitted.unique_source_fact_count = 1
    omitted.fact_set_sha256 = factSetSha(omitted.source_facts)

    expect(parsePositionHistorySourceFactLedger(omitted)).toBeDefined()
    expect(
      revalidatePositionHistorySourceFactLedger({
        artifact: rawArtifact,
        ledger: omitted,
        expectedAcquisition: acquisitionAnchor(rawArtifact),
      })
    ).toEqual({ verified: false, reason: 'source_fact_ledger_mismatch' })
  })

  it('detects fully self-consistent whole-page and whole-segment omissions on replay', () => {
    const pagedArtifact = artifact({ closing: [[row('fact-1', 0)], [row('fact-2', 1)]] })
    const pagedEvidence = verifiedEvidence(pagedArtifact)
    const pageOmitted = jsonClone(pagedEvidence.ledger)
    const removedPageFactId = pageOmitted.segments[0].pages.pop()!.occurrences[0].source_fact_id
    pageOmitted.observed_candidate_count = 1
    pageOmitted.source_facts = pageOmitted.source_facts.filter(
      (fact) => fact.source_fact_id !== removedPageFactId
    )
    pageOmitted.unique_source_fact_count = 1
    pageOmitted.fact_set_sha256 = factSetSha(pageOmitted.source_facts)

    const dualArtifact = artifact({
      closing: [[row('same', 0, { view: 'closing' })]],
      opening: [[row('same', 0, { view: 'opening' })]],
      cursor: null,
    })
    const dualEvidence = verifiedEvidence(dualArtifact)
    const segmentOmitted = jsonClone(dualEvidence.ledger)
    segmentOmitted.segments.pop()
    segmentOmitted.observed_candidate_count = 1

    expect(parsePositionHistorySourceFactLedger(pageOmitted)).toBeDefined()
    expect(parsePositionHistorySourceFactLedger(segmentOmitted)).toBeDefined()
    expect(
      revalidatePositionHistorySourceFactLedger({
        artifact: pagedArtifact,
        ledger: pageOmitted,
        expectedAcquisition: acquisitionAnchor(pagedArtifact),
      })
    ).toEqual({ verified: false, reason: 'source_fact_ledger_mismatch' })
    expect(
      revalidatePositionHistorySourceFactLedger({
        artifact: dualArtifact,
        ledger: segmentOmitted,
        expectedAcquisition: acquisitionAnchor(dualArtifact),
      })
    ).toEqual({ verified: false, reason: 'source_fact_ledger_mismatch' })
  })

  it('detects payload-only and payload-plus-digest changes against the bound source run', () => {
    const rawArtifact = artifact({ closing: [[row('fact-1')]] })
    const evidence = verifiedEvidence(rawArtifact)
    const staleDigest = jsonClone(rawArtifact)
    ;(
      (staleDigest.pages[0].payload as { response: { data: { list: BinanceCandidate[] } } })
        .response.data.list[0] as BinanceCandidate
    ).closingPnl = '999'
    const reboundDigest = jsonClone(staleDigest)
    reboundDigest.pages[0].payload_sha256 = strictCanonicalSha256(reboundDigest.pages[0].payload)
    const reboundEvidence = verifiedEvidence(reboundDigest)

    expect(
      revalidatePositionHistorySourceFactLedger({
        artifact: staleDigest,
        ledger: evidence.ledger,
        expectedAcquisition: acquisitionAnchor(rawArtifact),
      })
    ).toEqual({ verified: false, reason: 'verified_position_history_artifact_required' })
    expect(
      revalidatePositionHistorySourceFactLedger({
        artifact: reboundDigest,
        ledger: evidence.ledger,
        expectedAcquisition: acquisitionAnchor(rawArtifact),
      })
    ).toEqual({ verified: false, reason: 'source_fact_ledger_mismatch' })
    expect(
      revalidatePositionHistorySourceFactLedger({
        artifact: reboundDigest,
        ledger: reboundEvidence.ledger,
        expectedAcquisition: acquisitionAnchor(rawArtifact),
      })
    ).toEqual({ verified: false, reason: 'acquisition_anchor_mismatch' })
  })

  it('rejects contract drift and control characters during serialized replay', () => {
    const rawArtifact = artifact({ closing: [[row('fact-1')]] })
    const evidence = verifiedEvidence(rawArtifact)
    const contractDrift = jsonClone(evidence.ledger)
    contractDrift.source_fact_contract =
      'arena.ingest.position-history-source-facts.binance.position_history@2'
    const controlCharacter = jsonClone(evidence.ledger)
    controlCharacter.exchange_trader_id = 'portfolio\u0000one'

    expect(parsePositionHistorySourceFactLedger(contractDrift)).toBeDefined()
    expect(
      revalidatePositionHistorySourceFactLedger({
        artifact: rawArtifact,
        ledger: contractDrift,
        expectedAcquisition: acquisitionAnchor(rawArtifact),
      })
    ).toEqual({ verified: false, reason: 'source_fact_contract_unavailable' })
    expect(() => parsePositionHistorySourceFactLedger(controlCharacter)).toThrow()
  })
})
