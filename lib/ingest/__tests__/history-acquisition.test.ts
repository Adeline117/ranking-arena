import {
  HISTORY_TERMINAL_CLAIM_CONTRACT,
  captureHistoryAcquisition,
  historyAcquisitionSourceRunId,
  parseHistoryAcquisitionArtifact,
  type HistoryTerminalClaim,
  type HistoryTerminalVerifier,
} from '@/lib/ingest/history-acquisition'
import { strictCanonicalSha256 } from '@/lib/ingest/strict-canonical-json'
import type { RawPage } from '@/lib/ingest/core/types'

const startedAt = '2026-08-03T12:00:00.000Z'
const cursor = '2026-07-01T00:00:00.000Z'
const verifierContract = 'arena.ingest.history-terminal-verifier.test.position_history@1'

function selectedVerifier(verify: HistoryTerminalVerifier) {
  return { contract: verifierContract, verify }
}

function page(pageIndex: number, payload: unknown = { rows: [{ id: pageIndex }] }): RawPage {
  return {
    pageIndex,
    payload,
    url: `https://example.test/history?page=${pageIndex}`,
    fetchedAt: `2026-08-03T12:00:0${pageIndex}.000Z`,
  }
}

function claim(
  reason: HistoryTerminalClaim['observations'][number]['reason'],
  pageOrdinal: number,
  segmentId = 'default'
): HistoryTerminalClaim {
  return {
    contract: HISTORY_TERMINAL_CLAIM_CONTRACT,
    observations: [{ segment_id: segmentId, reason, page_ordinal: pageOrdinal }],
  }
}

function input(
  stream: AsyncIterable<RawPage>,
  patch: Partial<Parameters<typeof captureHistoryAcquisition>[0]> = {}
): Parameters<typeof captureHistoryAcquisition>[0] {
  return {
    source: { id: 1, slug: 'okx_futures' },
    traderId: 22,
    exchangeTraderId: 'trader-1',
    kind: 'position_history',
    cursor,
    attemptStartedAt: startedAt,
    stream,
    ...patch,
  }
}

async function* returned(
  pages: RawPage[],
  terminal?: unknown
): AsyncGenerator<RawPage, unknown, void> {
  for (const rawPage of pages) yield rawPage
  return terminal
}

describe('history acquisition terminal evidence', () => {
  it('keeps a normal generator return unknown instead of inventing completeness', async () => {
    const capture = await captureHistoryAcquisition(input(returned([page(1)])))

    expect(capture.error).toBeNull()
    expect(capture.artifact.termination).toEqual({
      evidence_state: 'missing',
      claim_observations: [],
      verifier_contract: null,
      scan_terminal_state: 'unknown',
      terminal_cursor_value: null,
      overlap_event_at: null,
      blocker_reasons: ['terminal_claim_missing'],
    })
    expect(capture.sourceRunId).toBe(historyAcquisitionSourceRunId(capture.artifact))
  })

  it('binds captured payloads and coordinates into a deterministic source run', async () => {
    const first = await captureHistoryAcquisition(input(returned([page(1)])))
    const second = await captureHistoryAcquisition(input(returned([page(1)])))
    const changed = await captureHistoryAcquisition(
      input(returned([page(1, { rows: [{ id: 'changed' }] })]))
    )

    expect(first.sourceRunId).toBe(second.sourceRunId)
    expect(changed.sourceRunId).not.toBe(first.sourceRunId)
    expect(first.artifact.pages[0].payload_sha256).toBe(
      strictCanonicalSha256({ rows: [{ id: 1 }] })
    )
  })

  it.each(['empty_page', 'short_page', 'reported_end', 'snapshot_complete'] as const)(
    'accepts verified %s only through the selected verifier',
    async (reason) => {
      const capture = await captureHistoryAcquisition(
        input(returned([page(1)], claim(reason, 1)), {
          terminalVerifier: selectedVerifier(({ claim: terminalClaim, pages }) =>
            terminalClaim.observations[0].reason === reason && pages.length === 1
              ? { verified: true, scanTerminalState: 'exhausted' }
              : { verified: false }
          ),
        })
      )

      expect(capture.artifact.termination).toMatchObject({
        evidence_state: 'verified',
        claim_observations: [{ segment_id: 'default', reason, page_ordinal: 1 }],
        verifier_contract: verifierContract,
        scan_terminal_state: 'exhausted',
        blocker_reasons: [],
      })
    }
  )

  it('preserves independently proven terminal observations for a multi-segment crawl', async () => {
    const compositeClaim: HistoryTerminalClaim = {
      contract: HISTORY_TERMINAL_CLAIM_CONTRACT,
      observations: [
        { segment_id: 'closing', reason: 'short_page', page_ordinal: 1 },
        { segment_id: 'opening', reason: 'empty_page', page_ordinal: 2 },
      ],
    }
    const capture = await captureHistoryAcquisition(
      input(returned([page(1), page(1, { rows: [] })], compositeClaim), {
        cursor: null,
        terminalVerifier: selectedVerifier(({ claim: terminalClaim }) =>
          terminalClaim.observations.map((observation) => observation.segment_id).join(',') ===
          'closing,opening'
            ? { verified: true, scanTerminalState: 'exhausted' }
            : { verified: false }
        ),
      })
    )

    expect(capture.artifact.termination).toMatchObject({
      evidence_state: 'verified',
      claim_observations: compositeClaim.observations,
      scan_terminal_state: 'exhausted',
      blocker_reasons: [],
    })
  })

  it('requires verifier-extracted overlap time at or before the stored cursor', async () => {
    const valid = await captureHistoryAcquisition(
      input(returned([page(1)], claim('cursor_overlap', 1)), {
        terminalVerifier: selectedVerifier(() => ({
          verified: true,
          scanTerminalState: 'cursor_overlap',
          overlapEventAt: '2026-06-30T23:59:59.999Z',
        })),
      })
    )
    const late = await captureHistoryAcquisition(
      input(returned([page(1)], claim('cursor_overlap', 1)), {
        terminalVerifier: selectedVerifier(() => ({
          verified: true,
          scanTerminalState: 'cursor_overlap',
          overlapEventAt: '2026-07-01T00:00:00.001Z',
        })),
      })
    )

    expect(valid.artifact.termination).toMatchObject({
      evidence_state: 'verified',
      scan_terminal_state: 'cursor_overlap',
      terminal_cursor_value: cursor,
      overlap_event_at: '2026-06-30T23:59:59.999Z',
    })
    expect(late.artifact.termination).toMatchObject({
      evidence_state: 'rejected',
      scan_terminal_state: 'unknown',
      blocker_reasons: ['terminal_claim_rejected'],
    })
  })

  it('does not trust a valid adapter claim when no verifier is registered', async () => {
    const capture = await captureHistoryAcquisition(
      input(returned([page(1)], claim('short_page', 1)))
    )

    expect(capture.artifact.termination).toMatchObject({
      evidence_state: 'verifier_missing',
      claim_observations: [{ segment_id: 'default', reason: 'short_page', page_ordinal: 1 }],
      scan_terminal_state: 'unknown',
      blocker_reasons: ['terminal_verifier_missing'],
    })
  })

  it('rejects malformed, dangling, or verifier-rejected claims', async () => {
    const extraField = await captureHistoryAcquisition(
      input(
        returned([page(1)], {
          ...claim('short_page', 1),
          complete: true,
        })
      )
    )
    const dangling = await captureHistoryAcquisition(
      input(returned([page(1)], claim('short_page', 2)))
    )
    const rejected = await captureHistoryAcquisition(
      input(returned([page(1)], claim('short_page', 1)), {
        terminalVerifier: selectedVerifier(() => ({ verified: false })),
      })
    )

    expect(extraField.artifact.termination.evidence_state).toBe('invalid')
    expect(dangling.artifact.termination.evidence_state).toBe('invalid')
    expect(rejected.artifact.termination.evidence_state).toBe('rejected')
  })

  it('makes a caller cap dominate and never pulls the next page', async () => {
    let pulled = 0
    let closed = false
    async function* stream(): AsyncGenerator<RawPage, HistoryTerminalClaim, void> {
      try {
        pulled += 1
        yield page(1)
        pulled += 1
        yield page(2)
        pulled += 1
        yield page(3)
        return claim('short_page', 3)
      } finally {
        closed = true
      }
    }

    const capture = await captureHistoryAcquisition(
      input(stream(), {
        callerPageCap: 2,
        terminalVerifier: selectedVerifier(() => ({
          verified: true,
          scanTerminalState: 'exhausted',
        })),
      })
    )

    expect(pulled).toBe(2)
    expect(closed).toBe(true)
    expect(capture.pages).toHaveLength(2)
    expect(capture.artifact.termination).toEqual({
      evidence_state: 'caller_limited',
      claim_observations: [],
      verifier_contract: null,
      scan_terminal_state: 'partial',
      terminal_cursor_value: null,
      overlap_event_at: null,
      blocker_reasons: ['caller_limit'],
    })
  })

  it('preserves captured pages but never serializes an upstream error message', async () => {
    const secretError = new Error('authorization=secret')
    async function* stream(): AsyncGenerator<RawPage, HistoryTerminalClaim, void> {
      yield page(1)
      throw secretError
    }

    const capture = await captureHistoryAcquisition(input(stream()))

    expect(capture.error).toBe(secretError)
    expect(capture.pages).toHaveLength(1)
    expect(capture.artifact.termination.evidence_state).toBe('upstream_error')
    expect(JSON.stringify(capture.artifact)).not.toContain('secret')
  })

  it('fails closed when a verifier throws without leaking its message', async () => {
    const verifierError = new Error('raw-token-secret')
    const capture = await captureHistoryAcquisition(
      input(returned([page(1)], claim('short_page', 1)), {
        terminalVerifier: selectedVerifier(() => {
          throw verifierError
        }),
      })
    )

    expect(capture.error).toBe(verifierError)
    expect(capture.artifact.termination.evidence_state).toBe('rejected')
    expect(JSON.stringify(capture.artifact)).not.toContain('raw-token-secret')
  })

  it('rejects malformed verifier output even when TypeScript structural typing allows it', async () => {
    const capture = await captureHistoryAcquisition(
      input(returned([page(1)], claim('short_page', 1)), {
        terminalVerifier: selectedVerifier(() => ({
          verified: true,
          scanTerminalState: 'exhausted',
          complete: true,
        })),
      })
    )

    expect(capture.artifact.termination.evidence_state).toBe('rejected')
  })

  it('gives the verifier immutable canonical pages and claims', async () => {
    const capture = await captureHistoryAcquisition(
      input(returned([page(1)], claim('short_page', 1)), {
        terminalVerifier: selectedVerifier(({ claim: terminalClaim, pages }) => {
          const payload = pages[0].payload
          expect(Reflect.set(pages, 1, page(2))).toBe(false)
          expect(Reflect.set(terminalClaim.observations[0], 'reason', 'cursor_overlap')).toBe(false)
          if (payload !== null && typeof payload === 'object') {
            expect(Reflect.set(payload, 'forged', true)).toBe(false)
          }
          return { verified: true, scanTerminalState: 'exhausted' }
        }),
      })
    )

    expect(capture.artifact.termination.evidence_state).toBe('verified')
    expect(capture.artifact.pages[0].payload).toEqual({ rows: [{ id: 1 }] })
  })

  it('returns a partial artifact for malformed pages without hashing the rejected page', async () => {
    const badIndex = await captureHistoryAcquisition(
      input(returned([{ ...page(1), pageIndex: 0 }]))
    )
    const credentialUrl = await captureHistoryAcquisition(
      input(returned([{ ...page(1), url: 'https://user:secret@example.test/history' }]))
    )
    const invalidPayload = await captureHistoryAcquisition(
      input(returned([page(1, { value: undefined })]))
    )
    const preAttemptTimestamp = await captureHistoryAcquisition(
      input(returned([{ ...page(1), fetchedAt: '2026-08-03T11:59:59.999Z' }]))
    )

    for (const capture of [badIndex, credentialUrl, invalidPayload, preAttemptTimestamp]) {
      expect(capture.artifact.termination.evidence_state).toBe('upstream_error')
      expect(capture.pages).toHaveLength(0)
      expect(capture.error).toBeInstanceOf(Error)
    }
    expect(JSON.stringify(credentialUrl.artifact)).not.toContain('secret')
  })

  it('detects payload mutation when an artifact is replayed', async () => {
    const capture = await captureHistoryAcquisition(input(returned([page(1)])))
    const forged = {
      ...capture.artifact,
      pages: capture.artifact.pages.map((artifactPage, index) =>
        index === 0 ? { ...artifactPage, payload: { rows: [{ id: 'forged' }] } } : artifactPage
      ),
    }

    expect(() => parseHistoryAcquisitionArtifact(forged)).toThrow(
      'payload digest does not match canonical payload'
    )
  })
})
