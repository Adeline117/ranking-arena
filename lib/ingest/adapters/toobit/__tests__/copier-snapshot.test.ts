import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ParsedCopierRow, SourceRow } from '../../../core/types'
import type { FetchSession } from '../../../fetch/types'
import { captureHistoryAcquisition } from '../../../history-acquisition'
import { toobitCopierDetailUrl, toobitCopierFollowersUrl } from '../copier-snapshot'
import { toobitAdapter } from '../index'

const LEADER_ID = '668939882'
const PARSED_AT = '2026-08-03T10:00:00.000Z'

type Dict = Record<string, unknown>

function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8')) as T
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function detailFixture(): Dict {
  return fixture<{ detail: Dict }>('profile-bundle.json').detail
}

function detailData(payload: Dict): Dict {
  return payload.data as Dict
}

function followerRows(payload: Dict): Dict[] {
  return payload.data as Dict[]
}

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: 46,
    slug: 'toobit_futures',
    exchange_id: 15,
    product_type: 'futures',
    trader_kind_scope: 'human',
    adapter_slug: 'toobit',
    leaderboard_url: 'https://www.toobit.com/en-US/copytrading',
    timeframes_native: [7, 30, 90],
    timeframes_derived: [],
    tf_label_map: {},
    expected_count: 1_587,
    deep_profile_topn: 100,
    positions_topn: 100,
    profile_cache_ttl: '6 hours',
    copier_table_depth: 'full',
    currency: 'USDT',
    page_size: 6,
    pagination_kind: 'numeric',
    cadence_tier_a: '4 hours',
    cadence_tier_b: '12 hours',
    cadence_tier_d: '1 hour',
    fetch_region: 'vps_sg',
    rate_budget_ms: 500,
    phase: 3,
    serving_mode: 'serving',
    status: 'active',
    meta: {},
    ...overrides,
  }
}

function session(): FetchSession {
  return {
    sourceSlug: 'toobit_futures',
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

function installFetch(
  detailPayload: unknown,
  followersPayload: unknown,
  exchangeTraderId = LEADER_ID
) {
  const fetchMock = jest.fn(async (input: unknown) => {
    const url = String(input)
    if (url === toobitCopierDetailUrl(exchangeTraderId)) return httpOk(detailPayload)
    if (url === toobitCopierFollowersUrl(exchangeTraderId)) return httpOk(followersPayload)
    throw new Error(`unexpected Toobit request: ${url}`)
  })
  global.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

function verifier(src = source()) {
  const selected = toobitAdapter.verifyCopierSnapshot?.(src)
  if (!selected) throw new Error('expected the reviewed Toobit copier verifier')
  return selected
}

async function capture(fetchSession: FetchSession, src = source(), exchangeTraderId = LEADER_ID) {
  const selected = verifier(src)
  return captureHistoryAcquisition({
    source: src,
    traderId: 99,
    exchangeTraderId,
    kind: 'copiers',
    cursor: null,
    attemptStartedAt: new Date(Date.now() - 1_000).toISOString(),
    stream: toobitAdapter.getHistory(fetchSession, src, exchangeTraderId, 'copiers', null),
    terminalVerifier: { contract: selected.contract, verify: selected.verifyTerminal },
  })
}

function parseRows(pages: Awaited<ReturnType<typeof capture>>['pages']): ParsedCopierRow[] {
  return pages
    .flatMap((page) =>
      toobitAdapter.parseHistory(page.payload, 'copiers', {
        sourceSlug: 'toobit_futures',
        currency: 'USDT',
        tfLabelMap: {},
        scrapedAt: PARSED_AT,
        meta: {},
      })
    )
    .filter((row): row is ParsedCopierRow => row.kind === 'copiers')
}

describe('Toobit full copier snapshot authority', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  it('selects only the canonical active-serving futures human USDT full source', () => {
    expect(verifier()).toMatchObject({
      contract: 'arena.ingest.history-terminal-verifier.toobit.copiers@1',
    })
    expect(toobitAdapter.verifyCopierSnapshot?.(source({ status: 'inactive' }))).toBeNull()
    expect(toobitAdapter.verifyCopierSnapshot?.(source({ serving_mode: 'shadow' }))).toBeNull()
    expect(toobitAdapter.verifyCopierSnapshot?.(source({ copier_table_depth: 'top10' }))).toBeNull()
    expect(toobitAdapter.verifyCopierSnapshot?.(source({ currency: 'USDC' }))).toBeNull()
    expect(toobitAdapter.verifyCopierSnapshot?.(source({ adapter_slug: 'another' }))).toBeNull()
    expect(
      toobitAdapter.verifyCopierSnapshot?.(
        source({ meta: { endpoints: { base: 'https://proxy.example.test/copy-trading' } } })
      )
    ).toBeNull()
    expect(
      toobitAdapter.verifyCopierSnapshot?.(
        source({ slug: 'toobit_spot', product_type: 'spot', trader_kind_scope: 'human' })
      )
    ).toBeNull()
  })

  it('captures fresh detail then followers, retains both exact envelopes and proves conservation', async () => {
    const detail = detailFixture()
    const followers = fixture<Dict>('followers.json')
    const fetchMock = installFetch(detail, followers)
    const acquisition = await capture(session())

    expect(acquisition.error).toBeNull()
    expect(acquisition.pages).toHaveLength(2)
    expect(acquisition.pages[0]).toMatchObject({
      pageIndex: 1,
      url: toobitCopierDetailUrl(LEADER_ID),
    })
    expect(acquisition.pages[0].payload).toEqual(detail)
    expect(Object.keys(acquisition.pages[0].payload as Dict).sort()).toEqual(['code', 'data'])
    expect(acquisition.pages[1]).toMatchObject({
      pageIndex: 2,
      url: toobitCopierFollowersUrl(LEADER_ID),
    })
    expect(acquisition.pages[1].payload).toEqual(followers)
    expect(Object.keys(acquisition.pages[1].payload as Dict).sort()).toEqual(['code', 'data'])
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      toobitCopierDetailUrl(LEADER_ID),
      toobitCopierFollowersUrl(LEADER_ID),
    ])
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'verified',
      claim_observations: [{ segment_id: 'default', reason: 'snapshot_complete', page_ordinal: 2 }],
      scan_terminal_state: 'exhausted',
      blocker_reasons: [],
    })

    const rows = parseRows(acquisition.pages)
    expect(rows).toHaveLength(6)
    expect(
      verifier().verifyConservation({
        exchangeTraderId: LEADER_ID,
        pages: acquisition.pages,
        rows,
      })
    ).toEqual({ verified: true, envelopeRowCount: 6 })
  })

  it('proves an explicit successful zero-count full snapshot', async () => {
    const detail = clone(detailFixture())
    detailData(detail).currentFollowerCount = '0'
    const followers = fixture<Dict>('followers-empty.json')
    installFetch(detail, followers)

    const acquisition = await capture(session())
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'verified',
      scan_terminal_state: 'exhausted',
    })
    const rows = parseRows(acquisition.pages)
    expect(rows).toEqual([])
    expect(
      verifier().verifyConservation({
        exchangeTraderId: LEADER_ID,
        pages: acquisition.pages,
        rows,
      })
    ).toEqual({ verified: true, envelopeRowCount: 0 })
  })

  it('binds the encoded request URLs and both envelopes to leaderUserId', async () => {
    const exchangeTraderId = '668 939/882'
    const detail = clone(detailFixture())
    detailData(detail).leaderUserId = exchangeTraderId
    detailData(detail).currentFollowerCount = '0'
    const fetchMock = installFetch(detail, fixture<Dict>('followers-empty.json'), exchangeTraderId)

    const acquisition = await capture(session(), source(), exchangeTraderId)
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      toobitCopierDetailUrl(exchangeTraderId),
      toobitCopierFollowersUrl(exchangeTraderId),
    ])
    expect(acquisition.pages.map((page) => page.url)).toEqual([
      toobitCopierDetailUrl(exchangeTraderId),
      toobitCopierFollowersUrl(exchangeTraderId),
    ])
    expect(acquisition.artifact.termination.evidence_state).toBe('verified')
  })

  it.each([
    ['wrong leader identity', 'another-leader', '100'],
    ['leading-zero current count', '06', '100'],
    ['negative current count', '-1', '100'],
    ['numeric current count', 6, '100'],
    ['leading-zero maximum', '6', '0100'],
    ['current count above maximum', '101', '100'],
  ])('rejects identity/count authority drift: %s', async (_label, currentOrIdentity, maximum) => {
    const detail = clone(detailFixture())
    const data = detailData(detail)
    if (_label === 'wrong leader identity') data.leaderUserId = currentOrIdentity
    else data.currentFollowerCount = currentOrIdentity
    data.maxLeadCount = maximum
    installFetch(detail, fixture<Dict>('followers.json'))

    const acquisition = await capture(session())
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'rejected',
      scan_terminal_state: 'unknown',
      blocker_reasons: ['terminal_claim_rejected'],
    })
  })

  it.each([
    ['detail count below list length', '5'],
    ['detail count above list length', '7'],
  ])('rejects %s', async (_label, count) => {
    const detail = clone(detailFixture())
    detailData(detail).currentFollowerCount = count
    installFetch(detail, fixture<Dict>('followers.json'))

    const acquisition = await capture(session())
    expect(acquisition.artifact.termination.evidence_state).toBe('rejected')
  })

  const malformedEnvelopeCases: Array<readonly [string, (detail: Dict, followers: Dict) => void]> =
    [
      [
        'detail error code',
        (detail) => {
          detail.code = 500
        },
      ],
      [
        'followers error code',
        (_detail, followers) => {
          followers.code = 500
        },
      ],
      [
        'extra detail envelope field',
        (detail) => {
          detail.msg = 'ok'
        },
      ],
      [
        'extra followers envelope field',
        (_detail, followers) => {
          followers.msg = 'ok'
        },
      ],
      [
        'non-list followers data',
        (_detail, followers) => {
          followers.data = { list: followerRows(followers) }
        },
      ],
      [
        'follower item field drift',
        (_detail, followers) => {
          followerRows(followers)[0].cursor = 'next'
        },
      ],
      [
        'follower item type drift',
        (_detail, followers) => {
          followerRows(followers)[0].followRunningMills = 28_284_751_559
        },
      ],
      [
        'masked follower label',
        (_detail, followers) => {
          followerRows(followers)[0].followerNickname = '****'
        },
      ],
    ]

  it.each(malformedEnvelopeCases)(
    'rejects exact envelope/list drift: %s',
    async (_label, mutate) => {
      const detail = clone(detailFixture())
      const followers = clone(fixture<Dict>('followers.json'))
      mutate(detail, followers)
      installFetch(detail, followers)

      const acquisition = await capture(session())
      expect(acquisition.pages).toHaveLength(2)
      expect(acquisition.error).toBeNull()
      expect(acquisition.artifact.termination).toMatchObject({
        evidence_state: 'rejected',
        scan_terminal_state: 'unknown',
        blocker_reasons: ['terminal_claim_rejected'],
      })
    }
  )

  it('rejects duplicate parser hashes even when detail and list counts agree', async () => {
    const detail = clone(detailFixture())
    const followers = clone(fixture<Dict>('followers.json'))
    detailData(detail).currentFollowerCount = '7'
    followerRows(followers).push(clone(followerRows(followers)[0]))
    installFetch(detail, followers)

    const acquisition = await capture(session())
    expect(acquisition.artifact.termination.evidence_state).toBe('verified')
    const rows = parseRows(acquisition.pages)
    expect(rows).toHaveLength(7)
    expect(
      verifier().verifyConservation({
        exchangeTraderId: LEADER_ID,
        pages: acquisition.pages,
        rows,
      })
    ).toEqual({ verified: false })
  })

  it('rejects parser omission, reordering, label/field drift, raw substitution and duplicate hashes', async () => {
    installFetch(detailFixture(), fixture<Dict>('followers.json'))
    const acquisition = await capture(session())
    const rows = parseRows(acquisition.pages)
    const selected = verifier()
    const verify = (candidate: readonly ParsedCopierRow[]) =>
      selected.verifyConservation({
        exchangeTraderId: LEADER_ID,
        pages: acquisition.pages,
        rows: candidate,
      })

    expect(verify(rows.slice(1))).toEqual({ verified: false })
    expect(verify([...rows].reverse())).toEqual({ verified: false })
    expect(
      verify(rows.map((row, index) => (index === 0 ? { ...row, copierLabel: 'changed' } : row)))
    ).toEqual({ verified: false })
    expect(
      verify(rows.map((row, index) => (index === 0 ? { ...row, copierPnl: 999 } : row)))
    ).toEqual({ verified: false })
    expect(
      verify(
        rows.map((row, index) => (index === 0 ? { ...row, raw: { ...(row.raw as Dict) } } : row))
      )
    ).toEqual({ verified: false })
    expect(
      verify(
        rows.map((row, index) => (index === 1 ? { ...row, dedupeHash: rows[0].dedupeHash } : row))
      )
    ).toEqual({ verified: false })
  })

  it('performs both network requests again on the same session instead of memoizing detail', async () => {
    const fetchMock = installFetch(detailFixture(), fixture<Dict>('followers.json'))
    const sharedSession = session()

    expect((await capture(sharedSession)).artifact.termination.evidence_state).toBe('verified')
    expect((await capture(sharedSession)).artifact.termination.evidence_state).toBe('verified')
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      toobitCopierDetailUrl(LEADER_ID),
      toobitCopierFollowersUrl(LEADER_ID),
      toobitCopierDetailUrl(LEADER_ID),
      toobitCopierFollowersUrl(LEADER_ID),
    ])
  })
})
