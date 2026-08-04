import type { HistoryKind, RawPage } from '../core/types'
import {
  buildCopierPublicationLaneArtifact,
  copierPublicationLaneSourceRunId,
  COPIER_PUBLICATION_LANE_ARTIFACT_CONTRACT,
  parseCopierPublicationLaneArtifact,
  type CopierPublicationLane,
} from '../copier-publication-lane-artifact'
import {
  captureHistoryAcquisition,
  HISTORY_TERMINAL_CLAIM_CONTRACT,
  type HistoryAcquisitionArtifact,
  type HistoryTerminalClaim,
} from '../history-acquisition'
import { STRICT_CANONICAL_JSON_CONTRACT, strictCanonicalSha256 } from '../strict-canonical-json'

const attemptStartedAt = '2026-08-03T10:00:00.000Z'
const firstFetchedAt = '2026-08-03T10:00:01.000Z'

function claim(pageOrdinal = 1): HistoryTerminalClaim {
  return {
    contract: HISTORY_TERMINAL_CLAIM_CONTRACT,
    observations: [{ segment_id: 'followers', reason: 'reported_end', page_ordinal: pageOrdinal }],
  }
}

async function acquisition(
  options: {
    kind?: HistoryKind
    pages?: readonly RawPage[]
    cursor?: string | null
    callerPageCap?: number | null
    missingClaim?: boolean
    upstreamError?: boolean
    verifierContract?: string
    verified?: boolean
    exchangeTraderId?: string
  } = {}
): Promise<HistoryAcquisitionArtifact> {
  const pages =
    options.pages ??
    ([
      {
        pageIndex: 1,
        payload: { data: [{ followerId: 'private-1', pnl: '12.5' }], total: 1 },
        url: 'https://example.test/copiers?page=1',
        fetchedAt: firstFetchedAt,
      },
    ] satisfies RawPage[])
  async function* stream(): AsyncGenerator<RawPage, HistoryTerminalClaim | undefined, void> {
    for (const page of pages) yield page
    if (options.upstreamError) throw new Error('upstream failed')
    return options.missingClaim ? undefined : claim(pages.length)
  }
  const captured = await captureHistoryAcquisition({
    source: { id: 34, slug: 'gate_futures' },
    traderId: 101,
    exchangeTraderId: options.exchangeTraderId ?? 'trader-101',
    kind: options.kind ?? 'copiers',
    cursor: options.cursor ?? null,
    attemptStartedAt,
    callerPageCap: options.callerPageCap,
    stream: stream(),
    terminalVerifier: {
      contract:
        options.verifierContract ?? 'arena.ingest.history-terminal-verifier.gate_futures.copiers@1',
      verify: () =>
        options.verified === false
          ? ({ verified: false } as const)
          : ({ verified: true, scanTerminalState: 'exhausted' } as const),
    },
  })
  return captured.artifact
}

async function build(lane: CopierPublicationLane = 'tier_b') {
  return buildCopierPublicationLaneArtifact({ lane, acquisition: await acquisition() })
}

describe('copier publication lane artifact', () => {
  it('binds the entire verified acquisition and separates lane source-run identities', async () => {
    const captured = await acquisition()
    const tierB = buildCopierPublicationLaneArtifact({ lane: 'tier_b', acquisition: captured })
    const tierC = buildCopierPublicationLaneArtifact({ lane: 'tier_c', acquisition: captured })

    expect(tierB).toEqual({
      contract: COPIER_PUBLICATION_LANE_ARTIFACT_CONTRACT,
      serialization_contract: STRICT_CANONICAL_JSON_CONTRACT,
      publication_lane: 'tier_b',
      acquisition_source_run_id: strictCanonicalSha256(captured),
      acquisition: captured,
    })
    expect(tierC.acquisition_source_run_id).toBe(tierB.acquisition_source_run_id)
    expect(copierPublicationLaneSourceRunId(tierC)).not.toBe(
      copierPublicationLaneSourceRunId(tierB)
    )
    expect(copierPublicationLaneSourceRunId(tierB)).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.isFrozen(tierB)).toBe(true)
    expect(Object.isFrozen(tierB.acquisition.pages[0].payload)).toBe(true)
  })

  it('revalidates only the exact wrapper and nested acquisition contracts', async () => {
    const artifact = await build()
    expect(parseCopierPublicationLaneArtifact(artifact)).toEqual(artifact)
    expect(() =>
      parseCopierPublicationLaneArtifact({ ...artifact, publication_ready: true })
    ).toThrow('artifact contract is invalid')
    expect(() =>
      parseCopierPublicationLaneArtifact({
        ...artifact,
        acquisition: { ...artifact.acquisition, publication_ready: true },
      })
    ).toThrow('artifact contract is invalid')
  })

  it('rejects nested acquisition mutation without a matching immutable digest', async () => {
    const artifact = await build()
    const mutated = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>
    const nested = mutated.acquisition as Record<string, unknown>
    const pages = nested.pages as Array<Record<string, unknown>>
    pages[0].url = 'https://example.test/copiers?page=forged'

    expect(() => parseCopierPublicationLaneArtifact(mutated)).toThrow(
      'must be the strict canonical digest of the nested acquisition'
    )
  })

  it.each([
    ['unverified terminal claim', () => acquisition({ verified: false })],
    ['partial upstream failure', () => acquisition({ upstreamError: true })],
    ['missing terminal blocker', () => acquisition({ missingClaim: true })],
    ['empty acquisition', () => acquisition({ pages: [], missingClaim: true })],
    ['non-null cursor', () => acquisition({ cursor: '2026-08-03T09:00:00.000Z' })],
    ['caller page cap', () => acquisition({ callerPageCap: 10 })],
    [
      'non-copier selected verifier',
      () =>
        acquisition({
          verifierContract: 'arena.ingest.history-terminal-verifier.gate_futures.orders@1',
        }),
    ],
    ['non-copier history kind', () => acquisition({ kind: 'orders' })],
    ['jsonb-ineligible subject', () => acquisition({ exchangeTraderId: 'trader\0identity' })],
  ])('rejects %s before it can acquire publication authority', async (_label, makeAcquisition) => {
    const captured = await makeAcquisition()
    expect(() =>
      buildCopierPublicationLaneArtifact({ lane: 'tier_b', acquisition: captured })
    ).toThrow('[ingest] copier publication lane artifact failed:')
  })

  it('rejects an invalid lane and forged acquisition digest', async () => {
    const artifact = await build()
    expect(() =>
      buildCopierPublicationLaneArtifact({
        lane: 'tier_a' as CopierPublicationLane,
        acquisition: artifact.acquisition,
      })
    ).toThrow('artifact contract is invalid')
    expect(() =>
      parseCopierPublicationLaneArtifact({
        ...artifact,
        acquisition_source_run_id: 'f'.repeat(64),
      })
    ).toThrow('must be the strict canonical digest of the nested acquisition')
    expect(() =>
      parseCopierPublicationLaneArtifact({
        ...artifact,
        contract: 'arena.ingest.copier-publication-lane-artifact@2',
      })
    ).toThrow('artifact contract is invalid')
  })
})
