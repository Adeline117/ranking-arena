import {
  MEILISEARCH_SYNC_PAGE_SIZE,
  syncPublicRankingsToMeilisearch,
  toMeilisearchTraderDocument,
  type MeilisearchSyncSqlClient,
} from '../meilisearch-sync'

function rankRow(season: string, rank: number, overrides: Record<string, unknown> = {}) {
  return {
    source: 'binance_futures',
    source_trader_id: `t-${rank}`,
    season_id: season,
    handle: `h${rank}`,
    avatar_url: null,
    roi: '12.5',
    pnl: '1000.00',
    arena_score: '70.10',
    win_rate: '55.00',
    max_drawdown: null,
    followers: '3',
    rank: String(rank),
    trader_type: null,
    source_as_of: '2026-11-12T00:00:00.000000Z',
    ...overrides,
  }
}

function fakeResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
  }
}

function harness(rowsBySeason: Record<string, ReturnType<typeof rankRow>[]>) {
  const statements: Array<{ text: string; values?: readonly unknown[] }> = []
  let released: boolean | undefined
  const client: MeilisearchSyncSqlClient = {
    async query<Row>(text: string, values?: readonly unknown[]) {
      statements.push({ text, values })
      if (!text.includes('public_ranked_leaderboard')) return { rows: [] as Row[] }
      const [season, afterRank, limit] = values as [string, number, number]
      const rows = (rowsBySeason[season] ?? [])
        .filter((row) => Number(row.rank) > afterRank)
        .slice(0, limit)
      return { rows: rows as unknown as Row[] }
    },
    release(destroy) {
      released = destroy ?? false
    },
  }
  const requests: Array<{ url: string; method: string; body: unknown }> = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url, method: String(init.method), body: JSON.parse(String(init.body)) })
    return fakeResponse(202, { taskUid: requests.length })
  }) as unknown as typeof fetch
  return { client, statements, requests, fetchImpl, released: () => released }
}

describe('toMeilisearchTraderDocument', () => {
  it('keeps the live compound id format and numeric fields', () => {
    const doc = toMeilisearchTraderDocument(
      rankRow('90D', 1, { source_trader_id: '0xAb:c' }),
      '90D'
    )
    expect(doc.id).toBe('binance_futures--0xAb_c--90D')
    expect(doc).toMatchObject({ rank: 1, roi: 12.5, arena_score: 70.1, max_drawdown: null })
  })

  it('refuses a row from another season or without a rank', () => {
    expect(() => toMeilisearchTraderDocument(rankRow('7D', 1), '90D')).toThrow(/season/)
    expect(() => toMeilisearchTraderDocument(rankRow('90D', 0), '90D')).toThrow(/rank/)
  })
})

describe('syncPublicRankingsToMeilisearch', () => {
  it('reads every season from the sealed view in one read-only snapshot, then uploads', async () => {
    const many = Array.from({ length: MEILISEARCH_SYNC_PAGE_SIZE + 2 }, (_, index) =>
      rankRow('90D', index + 1)
    )
    const h = harness({ '7D': [rankRow('7D', 1)], '30D': [], '90D': many })
    const result = await syncPublicRankingsToMeilisearch({
      connect: async () => h.client,
      meiliUrl: 'https://meili.example/',
      meiliAdminKey: 'k',
      fetchImpl: h.fetchImpl,
    })
    expect(result).toEqual({
      ok: true,
      traders: MEILISEARCH_SYNC_PAGE_SIZE + 3,
      seasons: { '7D': 1, '30D': 0, '90D': MEILISEARCH_SYNC_PAGE_SIZE + 2 },
      errors: {},
    })
    expect(h.statements[0].text).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    expect(h.statements[h.statements.length - 1].text).toBe('COMMIT')
    expect(h.statements.some((s) => /leaderboard_ranks\b/.test(s.text))).toBe(false)
    expect(h.released()).toBe(false)
    expect(h.requests[0]).toMatchObject({
      url: 'https://meili.example/indexes/traders/settings/filterable-attributes',
      method: 'PUT',
    })
    expect(h.requests.slice(1).every((r) => r.url.endsWith('/indexes/traders/documents'))).toBe(
      true
    )
  })

  it('fails closed (no upload) when the sealed read fails', async () => {
    const h = harness({})
    const failing: MeilisearchSyncSqlClient = {
      async query<Row>(text: string) {
        if (text.includes('public_ranked_leaderboard')) throw new Error('boom')
        return { rows: [] as Row[] }
      },
      release: h.client.release,
    }
    await expect(
      syncPublicRankingsToMeilisearch({
        connect: async () => failing,
        meiliUrl: 'https://m',
        meiliAdminKey: 'k',
        fetchImpl: h.fetchImpl,
      })
    ).rejects.toThrow('boom')
    expect(h.requests).toHaveLength(0)
  })

  it('throws when Meilisearch rejects an upload', async () => {
    const h = harness({ '7D': [rankRow('7D', 1)] })
    const rejecting = (async () => fakeResponse(500, 'nope')) as unknown as typeof fetch
    await expect(
      syncPublicRankingsToMeilisearch({
        connect: async () => h.client,
        meiliUrl: 'https://m',
        meiliAdminKey: 'k',
        fetchImpl: rejecting,
      })
    ).rejects.toThrow(/500/)
  })

  it('refuses to run without configuration', async () => {
    await expect(
      syncPublicRankingsToMeilisearch({
        connect: async () => {
          throw new Error('must not connect')
        },
        meiliUrl: '',
        meiliAdminKey: '',
      })
    ).rejects.toThrow(/not configured/)
  })
})
