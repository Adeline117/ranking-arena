import type { LeaderboardExhaustionDeclaration } from '../../acquisition-exhaustion'
import type { SourceRow } from '../../core/types'
import { attemptBoundEvidenceForCapture } from '../../testing/attempt-bound-evidence'
import { LeaderboardCaptureUpstreamError, type LeaderboardCapture } from '../capture'
import { captureReplayLeaderboard, collectionMeta, requireEnvelopeValue } from '../replay-capture'
import type { FetchSession, ReplayRequestTemplate } from '../types'

const session = { paced: async <T>(fn: () => Promise<T>) => fn() } as unknown as FetchSession
const PAGE_SIZE = 2
const source = {
  id: 41,
  slug: 'synthetic_futures',
  adapter_slug: 'synthetic',
  page_size: PAGE_SIZE,
  pagination_kind: 'numeric',
} as const

const flagDeclaration: LeaderboardExhaustionDeclaration = {
  completeness_mode: 'exhausted',
  list_path: ['data', 'rows'],
  row_key_path: ['uid'],
  end_signal: { kind: 'flag', path: ['data', 'nextFlag'], end_values: [false] },
  board_version: { kind: 'token', path: ['data', 'dataVer'] },
  max_duplicate_rows: 0,
}

interface PageSpec {
  uids: Array<string | number>
  nextFlag?: unknown
  pages?: number
  dataVer?: string
  total?: number
}

function page(spec: PageSpec) {
  const data: Record<string, unknown> = { rows: spec.uids.map((uid) => ({ uid, roi: '1' })) }
  if ('nextFlag' in spec) data.nextFlag = spec.nextFlag
  if (spec.pages !== undefined) data.pages = spec.pages
  if (spec.dataVer !== undefined) data.dataVer = spec.dataVer
  if (spec.total !== undefined) data.total = spec.total
  return { code: 0, data }
}

type Answer = { status: number; json: unknown }

async function run(
  answers: Answer[],
  exhaustion: LeaderboardExhaustionDeclaration
): Promise<{ capture: LeaderboardCapture; requests: ReplayRequestTemplate[] }> {
  const requests: ReplayRequestTemplate[] = []
  let call = 0
  const capture = await captureReplayLeaderboard(
    {
      session,
      fetcher: async (request) => {
        requests.push(request)
        const answer = answers[call++]
        if (!answer) throw new Error('unexpected request')
        return answer
      },
      src: { meta: {} } as SourceRow,
      label: 'synthetic',
    },
    {
      buildRequest: (pageIndex, { firstPagePayload }) => {
        const ver = (firstPagePayload as { data?: { dataVer?: string } } | null)?.data?.dataVer
        return {
          url: `https://board.example/list?page=${pageIndex}&size=${PAGE_SIZE}${ver ? `&dataVer=${ver}` : ''}`,
          method: 'GET',
          headers: { cookie: 'SECRET' },
        }
      },
      publicRequest: { query: ['page', 'size', 'dataVer'] },
      pageBinding: { location: 'query', key: 'page' },
      extractMeta: collectionMeta({
        label: 'synthetic',
        assertSuccess: requireEnvelopeValue('synthetic', ['code'], [0]),
        list: ['data', 'rows'],
        total: ['data', 'total'],
      }),
      pageSize: PAGE_SIZE,
      exhaustion,
    }
  )
  return { capture, requests }
}

const ok = (spec: PageSpec): Answer => ({ status: 200, json: page(spec) })

function evidence(
  capture: LeaderboardCapture,
  registered: LeaderboardExhaustionDeclaration | null,
  accepted?: number
) {
  const keys = capture.completeness?.row_keys
  return attemptBoundEvidenceForCapture({
    capture,
    source,
    timeframe: 30,
    acceptedPopulation: accepted ?? keys?.distinct ?? 0,
    rejectedRowCount: 0,
    registeredExhaustion: registered,
  })
}

describe('exhausted completeness capture', () => {
  it('binds a flag-terminated, version-stable board as complete and trust-bound', async () => {
    const { capture, requests } = await run(
      [
        ok({ uids: ['a', 'b'], nextFlag: true, dataVer: 'v1' }),
        ok({ uids: ['c', 'd'], nextFlag: true, dataVer: 'v1' }),
        ok({ uids: ['e'], nextFlag: false, dataVer: 'v1' }),
      ],
      flagDeclaration
    )

    expect(capture.terminationReason).toBe('end_signal_reached')
    // Page 2+ carry page one's version token, and it is persisted in RAW.
    expect(requests[1].url).toContain('dataVer=v1')
    expect(capture.sourcePages[1].rawPage.url).toContain('dataVer=v1')
    expect(JSON.stringify(capture)).not.toContain('SECRET')
    expect(capture.completeness?.pages.map((p) => [p.row_count, p.end_signal_value])).toEqual([
      [2, true],
      [2, true],
      [1, false],
    ])
    expect(capture.completeness?.pages.map((p) => p.request_sha256)).toEqual(
      capture.sourcePages.map((p) => p.requestSha256)
    )

    const result = evidence(capture, flagDeclaration)
    expect(result).toMatchObject({ completenessMode: 'exhausted', trustBound: true })
    expect(result.projection).toMatchObject({
      terminalState: 'complete',
      populationState: 'verified',
      populationReportState: 'unknown',
      reportedPopulation: null,
      acceptedPopulation: 5,
      deduplicatedRowCount: 0,
    })
  })

  it('fails closed when a page lacks the declared end signal', async () => {
    const error = await run(
      [ok({ uids: ['a', 'b'], nextFlag: true, dataVer: 'v1' }), ok({ uids: ['c'], dataVer: 'v1' })],
      flagDeclaration
    ).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(LeaderboardCaptureUpstreamError)
    const failed = (error as LeaderboardCaptureUpstreamError).capture as LeaderboardCapture
    expect(failed.terminationReason).toBe('upstream_error')
    expect(failed.completeness).toBeUndefined()
  })

  it('refuses a reported population in exhausted mode (that board belongs to the total mode)', async () => {
    const error = await run(
      [ok({ uids: ['a'], nextFlag: false, dataVer: 'v1', total: 1 })],
      flagDeclaration
    ).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(LeaderboardCaptureUpstreamError)
  })

  it('does not verify a board whose version token changes between pages', async () => {
    const { capture } = await run(
      [
        ok({ uids: ['a', 'b'], nextFlag: true, dataVer: 'v1' }),
        ok({ uids: ['c'], nextFlag: false, dataVer: 'v2' }),
      ],
      flagDeclaration
    )
    const result = evidence(capture, flagDeclaration)
    expect(result.trustBound).toBe(false)
    expect(result.projection.terminalState).toBe('unknown')
  })

  it('rejects cross-page duplicates above the allowance and accepts them within it', async () => {
    const answers = [
      ok({ uids: ['a', 'b'], nextFlag: true, dataVer: 'v1' }),
      ok({ uids: ['b'], nextFlag: false, dataVer: 'v1' }),
    ]
    const strict = await run(answers, flagDeclaration)
    expect(strict.capture.completeness?.row_keys).toEqual({
      observed: 3,
      distinct: 2,
      duplicate: 1,
    })
    expect(evidence(strict.capture, flagDeclaration).trustBound).toBe(false)

    const tolerant = { ...flagDeclaration, max_duplicate_rows: 1 }
    const allowed = await run(answers, tolerant)
    const result = evidence(allowed.capture, tolerant)
    expect(result.trustBound).toBe(true)
    expect(result.projection.deduplicatedRowCount).toBe(1)
    // Accepted rows must equal the distinct keys: an undeduplicated parse fails.
    expect(evidence(allowed.capture, tolerant, 3).trustBound).toBe(false)
  })

  it('requires the declaration the source registered', async () => {
    const { capture } = await run(
      [ok({ uids: ['a'], nextFlag: false, dataVer: 'v1' })],
      flagDeclaration
    )
    expect(evidence(capture, null).trustBound).toBe(false)
    const other = {
      ...flagDeclaration,
      end_signal: { ...flagDeclaration.end_signal, end_values: [false, 0] },
    }
    expect(evidence(capture, other as LeaderboardExhaustionDeclaration).trustBound).toBe(false)
  })

  describe('first_page_reread stability', () => {
    const reread: LeaderboardExhaustionDeclaration = {
      ...flagDeclaration,
      end_signal: { kind: 'short_page' },
      board_version: { kind: 'first_page_reread' },
    }

    it('binds when page one re-read yields identical row keys', async () => {
      const { capture, requests } = await run(
        [ok({ uids: ['a', 'b'] }), ok({ uids: ['c'] }), ok({ uids: ['a', 'b'] })],
        reread
      )
      expect(capture.terminationReason).toBe('short_page')
      expect(requests.map((r) => new URL(r.url).searchParams.get('page'))).toEqual(['1', '2', '1'])
      // The re-read is evidence, not a source page.
      expect(capture.sourcePages).toHaveLength(2)
      expect(evidence(capture, reread).trustBound).toBe(true)
    })

    it('does not verify when the board moved or the re-read failed', async () => {
      const moved = await run(
        [ok({ uids: ['a', 'b'] }), ok({ uids: ['c'] }), ok({ uids: ['x', 'a'] })],
        reread
      )
      expect(evidence(moved.capture, reread).trustBound).toBe(false)

      const failed = await run(
        [ok({ uids: ['a', 'b'] }), ok({ uids: ['c'] }), { status: 503, json: null }],
        reread
      )
      expect(failed.capture.completeness?.board_version).toEqual({
        kind: 'first_page_reread',
        reread: null,
      })
      expect(evidence(failed.capture, reread).trustBound).toBe(false)
    })
  })

  it('binds a page-count board that stops exactly at the reported page count', async () => {
    const pageCount: LeaderboardExhaustionDeclaration = {
      ...flagDeclaration,
      end_signal: { kind: 'page_count', path: ['data', 'pages'] },
    }
    const { capture, requests } = await run(
      [
        ok({ uids: ['a', 'b'], pages: 2, dataVer: 'v1' }),
        ok({ uids: ['c', 'd'], pages: 2, dataVer: 'v1' }),
      ],
      pageCount
    )
    expect(requests).toHaveLength(2)
    expect(capture.terminationReason).toBe('end_signal_reached')
    expect(evidence(capture, pageCount).trustBound).toBe(true)
  })

  it('refuses to build a manifest whose completeness block skips a page', async () => {
    const { capture } = await run(
      [
        ok({ uids: ['a', 'b'], nextFlag: true, dataVer: 'v1' }),
        ok({ uids: ['c'], nextFlag: false, dataVer: 'v1' }),
      ],
      flagDeclaration
    )
    const gapped = {
      ...capture,
      completeness: { ...capture.completeness!, pages: capture.completeness!.pages.slice(1) },
    }
    expect(() => evidence(gapped, flagDeclaration)).toThrow(/completeness pages must bind/)
  })
})
