import type { SourceAdapter } from '../../core/adapter'
import type { ParseCtx, RawPage, SourceRow } from '../../core/types'
import type { FetchSession } from '../../fetch/types'
import { bitunixAdapter } from '../bitunix'
import { btccAdapter } from '../btcc'
import { lbankAdapter } from '../lbank'

type Candidate = Record<string, unknown>

interface AdapterCase {
  name: string
  adapter: SourceAdapter
  src: SourceRow
  limit: number
  needsWarmSession: boolean
  candidate(index: number): Candidate
  missingIdentityCandidate: Candidate
  payload(records: Candidate[], total: number | null, pageIndex: number): unknown
  errorPayload: unknown
  malformedPathPayload: unknown
}

function source(adapterSlug: 'lbank' | 'btcc' | 'bitunix', id: number): SourceRow {
  return {
    id,
    slug: `${adapterSlug}_futures`,
    exchange_id: id,
    product_type: 'futures',
    trader_kind_scope: 'human',
    adapter_slug: adapterSlug,
    leaderboard_url: `https://${adapterSlug}.example.invalid/copiers`,
    timeframes_native: [30],
    timeframes_derived: [],
    tf_label_map: {},
    expected_count: null,
    deep_profile_topn: 20,
    positions_topn: 20,
    profile_cache_ttl: '6 hours',
    copier_table_depth: 'full',
    currency: 'USDT',
    page_size: 20,
    pagination_kind: 'numeric',
    cadence_tier_a: '4 hours',
    cadence_tier_b: '12 hours',
    cadence_tier_d: '1 hour',
    fetch_region: 'local',
    rate_budget_ms: 1,
    phase: 2,
    serving_mode: 'serving',
    status: 'active',
    meta: {
      copier_max_pages: 5,
      endpoints: { copiers: `https://${adapterSlug}.example.invalid/api/copiers` },
    },
  }
}

function testContext(src: SourceRow): ParseCtx {
  return {
    sourceSlug: src.slug,
    currency: src.currency,
    tfLabelMap: src.tf_label_map,
    scrapedAt: '2026-08-04T12:00:00.000Z',
    meta: src.meta,
  }
}

function queuedSession(payloads: unknown[], needsWarmSession: boolean) {
  const calls: Array<{ method: 'GET' | 'POST'; url: string; body?: unknown }> = []
  let responseIndex = 0
  const nextResponse = () => {
    if (responseIndex >= payloads.length) throw new Error('unexpected extra copier page request')
    const payload = payloads[responseIndex]
    responseIndex += 1
    return {
      status: () => 200,
      json: async () => payload,
    }
  }
  const api = {
    get: jest.fn(async (url: string) => {
      calls.push({ method: 'GET', url })
      return nextResponse()
    }),
    post: jest.fn(async (url: string, options?: { data?: unknown }) => {
      calls.push({ method: 'POST', url, body: options?.data })
      return nextResponse()
    }),
  }
  const session = {
    sourceSlug: 'copier-pagination-test',
    api: async () => api,
    paced: async <T>(run: () => Promise<T>) => run(),
    ...(needsWarmSession
      ? {
          page: async () => ({ goto: jest.fn(async () => null) }),
          capture: async () => ({
            first: async () => ({
              template: {
                url: 'https://lbank.example.invalid/warm',
                method: 'GET' as const,
                headers: {},
              },
              responseJson: {},
              status: 200,
            }),
            all: () => [],
            dispose: jest.fn(),
          }),
        }
      : {}),
  } as FetchSession

  return { session, calls }
}

async function collectCopierPages(
  adapter: SourceAdapter,
  session: FetchSession,
  src: SourceRow
): Promise<RawPage[]> {
  const pages: RawPage[] = []
  for await (const page of adapter.getHistory(session, src, 'trader-123', 'copiers', null)) {
    pages.push(page)
  }
  return pages
}

const cases: AdapterCase[] = [
  {
    name: 'LBank',
    adapter: lbankAdapter,
    src: source('lbank', 37),
    limit: 20,
    needsWarmSession: true,
    candidate: (index) => ({
      name: `LB****${index}`,
      totalProfit: String(index),
      followDays: index + 1,
    }),
    missingIdentityCandidate: { totalProfit: '9', followDays: 2 },
    payload: (records, total) => ({
      code: 200,
      data: { records, ...(total === null ? {} : { total }) },
    }),
    errorPayload: { code: 500, data: { records: [] } },
    malformedPathPayload: { code: 200, data: { records: {}, total: 0 } },
  },
  {
    name: 'BTCC',
    adapter: btccAdapter,
    src: source('btcc', 23),
    limit: 50,
    needsWarmSession: false,
    candidate: (index) => ({
      userId: index + 1,
      nickName: `bt****${index}@example.invalid`,
      followTime: 1_770_000_000_000 + index,
      cumulativeNetProfit: index,
    }),
    missingIdentityCandidate: {
      nickName: 'missing-id@example.invalid',
      followTime: 1_770_000_000_000,
      cumulativeNetProfit: 9,
    },
    payload: (rows, total, pageIndex) => ({
      code: 200,
      rows,
      ...(total === null ? {} : { total }),
      pageNum: pageIndex,
    }),
    errorPayload: { code: 500, rows: [] },
    malformedPathPayload: { code: 200, rows: {}, total: 0 },
  },
  {
    name: 'Bitunix',
    adapter: bitunixAdapter,
    src: source('bitunix', 24),
    limit: 20,
    needsWarmSession: false,
    candidate: (index) => ({
      uid: index + 1,
      nickname: `bu****${index}@example.invalid`,
      followAmount: '10',
      day: 1,
      followDate: '2026-08-04T00:00:00.000Z',
      pl: String(index),
    }),
    missingIdentityCandidate: {
      nickname: 'missing-id@example.invalid',
      followAmount: '10',
      day: 1,
      followDate: '2026-08-04T00:00:00.000Z',
      pl: '9',
    },
    payload: (records, total, pageIndex) => ({
      code: 0,
      success: true,
      data: {
        records,
        ...(total === null ? {} : { total }),
        page: pageIndex,
      },
    }),
    errorPayload: { code: 1, success: false, data: { records: [] } },
    malformedPathPayload: {
      code: 0,
      success: true,
      data: { records: {}, total: 0, totalPage: 1, page: 1 },
    },
  },
]

describe.each(cases)('$name copier pagination', (adapterCase) => {
  it('continues after a full RAW page even when the parser skips one identity-less row', async () => {
    const firstPageRecords = Array.from({ length: adapterCase.limit }, (_, index) =>
      adapterCase.candidate(index)
    )
    firstPageRecords[adapterCase.limit - 1] = adapterCase.missingIdentityCandidate
    const secondPageRecords = [
      adapterCase.candidate(adapterCase.limit),
      adapterCase.candidate(adapterCase.limit + 1),
    ]
    const total = adapterCase.limit + secondPageRecords.length
    const firstPayload = adapterCase.payload(firstPageRecords, total, 1)
    const secondPayload = adapterCase.payload(secondPageRecords, total, 2)
    const { session, calls } = queuedSession(
      [firstPayload, secondPayload],
      adapterCase.needsWarmSession
    )

    expect(
      adapterCase.adapter.parseHistory(firstPayload, 'copiers', testContext(adapterCase.src))
    ).toHaveLength(adapterCase.limit - 1)

    const pages = await collectCopierPages(adapterCase.adapter, session, adapterCase.src)

    expect(pages.map((page) => page.pageIndex)).toEqual([1, 2])
    expect(calls).toHaveLength(2)
  })

  it('uses cumulative RAW candidates when the source forces a smaller page size', async () => {
    const pageCounts = [9, 9, 7]
    let candidateIndex = 0
    const payloads = pageCounts.map((count, pageIndex) => {
      const records = Array.from({ length: count }, () => {
        const candidate = adapterCase.candidate(candidateIndex)
        candidateIndex += 1
        return candidate
      })
      return adapterCase.payload(records, 25, pageIndex + 1)
    })
    const { session, calls } = queuedSession(payloads, adapterCase.needsWarmSession)

    const pages = await collectCopierPages(adapterCase.adapter, session, adapterCase.src)

    expect(pages.map((page) => page.pageIndex)).toEqual([1, 2, 3])
    expect(calls).toHaveLength(3)
  })

  it('uses a genuinely short RAW page only as fallback when total metadata is absent', async () => {
    const records = [adapterCase.candidate(0), adapterCase.candidate(1)]
    const payload = adapterCase.payload(records, null, 1)
    const { session, calls } = queuedSession([payload], adapterCase.needsWarmSession)

    const pages = await collectCopierPages(adapterCase.adapter, session, adapterCase.src)

    expect(pages.map((page) => page.pageIndex)).toEqual([1])
    expect(calls).toHaveLength(1)
  })

  it('stops when a full RAW candidate page reaches the reported total', async () => {
    const records = Array.from({ length: adapterCase.limit }, (_, index) =>
      adapterCase.candidate(index)
    )
    const payload = adapterCase.payload(records, adapterCase.limit, 1)
    const { session, calls } = queuedSession([payload], adapterCase.needsWarmSession)

    const pages = await collectCopierPages(adapterCase.adapter, session, adapterCase.src)

    expect(pages.map((page) => page.pageIndex)).toEqual([1])
    expect(calls).toHaveLength(1)
  })

  it('fails closed when an empty RAW page still reports more candidates', async () => {
    const payload = adapterCase.payload([], 1, 1)
    const { session } = queuedSession([payload], adapterCase.needsWarmSession)
    const iterator = adapterCase.adapter
      .getHistory(session, adapterCase.src, 'trader-123', 'copiers', null)
      [Symbol.asyncIterator]()

    await expect(iterator.next()).rejects.toThrow('copier empty page still claims continuation')
  })

  it('stops cleanly when an empty RAW page agrees with the reported total', async () => {
    const payload = adapterCase.payload([], 0, 1)
    const { session, calls } = queuedSession([payload], adapterCase.needsWarmSession)

    await expect(
      collectCopierPages(adapterCase.adapter, session, adapterCase.src)
    ).resolves.toEqual([])
    expect(calls).toHaveLength(1)
  })

  it.each([
    ['a non-success envelope', adapterCase.errorPayload],
    ['a malformed candidate path', adapterCase.malformedPathPayload],
  ])('fails closed for %s', async (_reason, payload) => {
    const { session } = queuedSession([payload], adapterCase.needsWarmSession)
    const iterator = adapterCase.adapter
      .getHistory(session, adapterCase.src, 'trader-123', 'copiers', null)
      [Symbol.asyncIterator]()

    await expect(iterator.next()).rejects.toThrow('copier candidate conservation failed')
  })
})

describe('Bitunix copier totalPage continuation', () => {
  it('continues through a short RAW page while totalPage explicitly has another page', async () => {
    const adapterCase = cases.find((candidate) => candidate.name === 'Bitunix')
    if (!adapterCase) throw new Error('Bitunix test case is missing')
    const firstPayload = {
      code: 0,
      success: true,
      data: {
        records: [adapterCase.candidate(0), adapterCase.candidate(1)],
        totalPage: 2,
        page: 1,
      },
    }
    const secondPayload = {
      code: 0,
      success: true,
      data: {
        records: [adapterCase.candidate(2)],
        totalPage: 2,
        page: 2,
      },
    }
    const { session, calls } = queuedSession([firstPayload, secondPayload], false)

    const pages = await collectCopierPages(adapterCase.adapter, session, adapterCase.src)

    expect(pages.map((page) => page.pageIndex)).toEqual([1, 2])
    expect(calls).toHaveLength(2)
  })

  it('fails closed when an empty RAW page still has a later totalPage', async () => {
    const adapterCase = cases.find((candidate) => candidate.name === 'Bitunix')
    if (!adapterCase) throw new Error('Bitunix test case is missing')
    const payload = {
      code: 0,
      success: true,
      data: { records: [], totalPage: 2, page: 1 },
    }
    const { session } = queuedSession([payload], false)
    const iterator = adapterCase.adapter
      .getHistory(session, adapterCase.src, 'trader-123', 'copiers', null)
      [Symbol.asyncIterator]()

    await expect(iterator.next()).rejects.toThrow('copier empty page still claims continuation')
  })
})
