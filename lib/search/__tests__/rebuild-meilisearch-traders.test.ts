/**
 * @jest-environment node
 */

import { createHash } from 'node:crypto'
import {
  rebuildMeilisearchTraders,
  type MeilisearchTraderDocument,
} from '@/lib/search/rebuild-meilisearch-traders'

const MEILI_URL = 'https://meili.example'
const MEILI_KEY = 'admin-key'
const CANDIDATE_UID = 'traders_build_test'
const SEASONS = ['7D', '30D', '90D'] as const
const COHORTS = {
  '7D': '11111111-1111-4111-8111-111111111111',
  '30D': '22222222-2222-4222-8222-222222222222',
  '90D': '33333333-3333-4333-8333-333333333333',
} as const

function identityForSeason(season: (typeof SEASONS)[number]): string {
  return `trader-${season.toLowerCase()}`
}

function postgresJsonbIdentityHash(identities: readonly string[]): string {
  const text = `[${identities.map((identity) => JSON.stringify(identity)).join(', ')}]`
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function leaderboardRow(season: (typeof SEASONS)[number]): Record<string, unknown> {
  const identity = identityForSeason(season)
  return {
    source: 'binance_futures',
    source_trader_id: identity,
    handle: identity,
    avatar_url: null,
    season_id: season,
    rank_publication_id: COHORTS[season],
    roi: 12.5,
    pnl: 500,
    arena_score: 88,
    win_rate: 61,
    max_drawdown: 8,
    followers: 20,
    rank: 1,
    trader_type: 'futures',
    computed_at: new Date(Date.now() - 60_000).toISOString(),
  }
}

function databaseHarness(
  options: {
    mutateFinalGeneration?: boolean
    corruptDigest?: boolean
  } = {}
) {
  const rows = new Map(SEASONS.map((season) => [season, [leaderboardRow(season)]] as const))
  const proofCalls = new Map<string, number>()
  const queryCalls: Array<{
    season?: string
    sources?: readonly string[]
    cohort?: string
    from: number
    to: number
  }> = []
  const sourceAsOf = new Date(Date.now() - 60_000).toISOString()
  const recordedAt = new Date(Date.now() - 30_000).toISOString()

  const rpc = jest.fn((name: string, args?: Record<string, unknown>) => {
    if (name === 'arena_freshness_expected_sources') {
      return Promise.resolve({
        data: SEASONS.map((season) => ({
          season_id: season,
          registry_slug: 'binance_perps',
          filter_source: 'binance_futures',
          exchange_name: 'Binance Futures',
        })),
        error: null,
        status: 200,
      })
    }
    if (name === 'arena_leaderboard_publication_proofs') {
      const season = args?.p_season_id as (typeof SEASONS)[number]
      const call = (proofCalls.get(season) ?? 0) + 1
      proofCalls.set(season, call)
      const finalGeneration = options.mutateFinalGeneration && season === '7D' && call >= 3
      return Promise.resolve({
        data: [
          {
            season_id: season,
            source: 'binance_futures',
            source_as_of: sourceAsOf,
            recorded_at: recordedAt,
            score_cohort_id: COHORTS[season],
            rank_mutation_seq: finalGeneration ? 10 : 9,
            current_mutation_seq: finalGeneration ? 10 : 9,
            published_rank_count: 1,
            published_identity_sha256: options.corruptDigest
              ? 'f'.repeat(64)
              : postgresJsonbIdentityHash([identityForSeason(season)]),
            is_sealed: true,
          },
        ],
        error: null,
        status: 200,
      })
    }
    throw new Error(`unexpected RPC ${name}`)
  })

  const from = jest.fn((table: string) => {
    if (table !== 'leaderboard_ranks') throw new Error(`unexpected table ${table}`)
    let season: (typeof SEASONS)[number] | undefined
    let sources: readonly string[] | undefined
    let cohort: string | undefined
    const query = {
      select: jest.fn(() => query),
      eq: jest.fn((field: string, value: unknown) => {
        if (field === 'season_id') season = value as (typeof SEASONS)[number]
        return query
      }),
      in: jest.fn((field: string, value: readonly string[]) => {
        if (field === 'source') sources = value
        return query
      }),
      filter: jest.fn((field: string, operator: string, value: unknown) => {
        if (field !== 'rank_publication_id' || operator !== 'eq') {
          throw new Error('missing publication filter')
        }
        cohort = String(value)
        return query
      }),
      order: jest.fn(() => query),
      abortSignal: jest.fn(() => query),
      range: jest.fn(async (fromOffset: number, toOffset: number) => {
        queryCalls.push({ season, sources, cohort, from: fromOffset, to: toOffset })
        if (!season) throw new Error('missing season')
        const data = rows.get(season) ?? []
        return {
          data: data
            .filter(
              (row) => sources?.includes(String(row.source)) && row.rank_publication_id === cohort
            )
            .slice(fromOffset, toOffset + 1),
          error: null,
        }
      }),
    }
    return query
  })

  return {
    supabase: { rpc, from },
    queryCalls,
    proofCalls,
  }
}

interface InMemoryIndex {
  primaryKey: string
  documents: Map<string, Record<string, unknown>>
}

function meiliHarness(
  options: {
    dropLastUpload?: boolean
    failSettingsTask?: boolean
    processUploadOnce?: boolean
  } = {}
) {
  const indexes = new Map<string, InMemoryIndex>([
    [
      'traders',
      {
        primaryKey: 'id',
        documents: new Map([
          ['retired--old--90D', { id: 'retired--old--90D', season_id: '90D', handle: 'old' }],
        ]),
      },
    ],
  ])
  const tasks = new Map<number, { status: string; reads: number }>()
  const requests: Array<{ method: string; path: string; body: unknown }> = []
  let nextTaskUid = 1
  let swaps = 0

  function task(status = 'succeeded'): Response {
    const taskUid = nextTaskUid
    nextTaskUid += 1
    tasks.set(taskUid, { status, reads: 0 })
    return Response.json({ taskUid, status: 'enqueued' }, { status: 202 })
  }

  const fetchImpl = jest.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    requests.push({ method, path: `${url.pathname}${url.search}`, body })

    if (method === 'GET' && url.pathname.startsWith('/tasks/')) {
      const uid = Number(url.pathname.split('/').at(-1))
      const value = tasks.get(uid)
      if (!value) return Response.json({ message: 'missing task' }, { status: 404 })
      value.reads += 1
      if (options.processUploadOnce && value.status === 'succeeded' && value.reads === 1) {
        return Response.json({ uid, status: 'processing', error: null })
      }
      return Response.json({
        uid,
        status: value.status,
        error: value.status === 'succeeded' ? null : { code: 'task_failed' },
      })
    }

    if (method === 'GET' && /^\/indexes\/[^/]+$/.test(url.pathname)) {
      const uid = decodeURIComponent(url.pathname.split('/').at(-1) ?? '')
      const index = indexes.get(uid)
      return index
        ? Response.json({ uid, primaryKey: index.primaryKey })
        : Response.json({ message: 'not found' }, { status: 404 })
    }

    if (method === 'POST' && url.pathname === '/indexes') {
      const payload = body as { uid: string; primaryKey: string }
      indexes.set(payload.uid, {
        primaryKey: payload.primaryKey,
        documents: new Map(),
      })
      return task()
    }

    const settingsMatch = /^\/indexes\/([^/]+)\/settings$/.exec(url.pathname)
    if (method === 'PUT' && settingsMatch) {
      return task(options.failSettingsTask ? 'failed' : 'succeeded')
    }

    const documentsMatch = /^\/indexes\/([^/]+)\/documents$/.exec(url.pathname)
    if (method === 'POST' && documentsMatch) {
      const uid = decodeURIComponent(documentsMatch[1])
      const index = indexes.get(uid)
      if (!index) return Response.json({ message: 'not found' }, { status: 404 })
      const documents = body as Record<string, unknown>[]
      const accepted = options.dropLastUpload ? documents.slice(0, -1) : documents
      for (const document of accepted) {
        index.documents.set(String(document.id), document)
      }
      return task()
    }

    if (method === 'GET' && documentsMatch) {
      const uid = decodeURIComponent(documentsMatch[1])
      const index = indexes.get(uid)
      if (!index) return Response.json({ message: 'not found' }, { status: 404 })
      const offset = Number(url.searchParams.get('offset') ?? 0)
      const limit = Number(url.searchParams.get('limit') ?? 20)
      const all = [...index.documents.values()]
      return Response.json({
        results: all.slice(offset, offset + limit).map(({ id, season_id }) => ({ id, season_id })),
        offset,
        limit,
        total: all.length,
      })
    }

    if (method === 'POST' && url.pathname === '/swap-indexes') {
      const [{ indexes: pair }] = body as Array<{ indexes: [string, string] }>
      const left = indexes.get(pair[0])
      const right = indexes.get(pair[1])
      if (!left || !right) return Response.json({ message: 'not found' }, { status: 404 })
      indexes.set(pair[0], right)
      indexes.set(pair[1], left)
      swaps += 1
      return task()
    }

    if (method === 'DELETE' && /^\/indexes\/[^/]+$/.test(url.pathname)) {
      const uid = decodeURIComponent(url.pathname.split('/').at(-1) ?? '')
      if (!indexes.has(uid)) {
        return Response.json({ message: 'not found' }, { status: 404 })
      }
      indexes.delete(uid)
      return task()
    }

    return Response.json({ message: 'unexpected request' }, { status: 500 })
  })

  return {
    fetchImpl,
    indexes,
    requests,
    swaps: () => swaps,
  }
}

function input(
  database: ReturnType<typeof databaseHarness>,
  meili: ReturnType<typeof meiliHarness>
) {
  return {
    supabase: database.supabase as never,
    meiliUrl: MEILI_URL,
    meiliAdminKey: MEILI_KEY,
    fetchImpl: meili.fetchImpl,
    candidateUid: CANDIDATE_UID,
    sleep: jest.fn().mockResolvedValue(undefined),
  }
}

describe('rebuildMeilisearchTraders', () => {
  it('publishes only an exhaustively reconciled sealed candidate after every task succeeds', async () => {
    const database = databaseHarness()
    const meili = meiliHarness({ processUploadOnce: true })

    await expect(rebuildMeilisearchTraders(input(database, meili))).resolves.toMatchObject({
      mode: 'authoritative',
      candidate_uid: CANDIDATE_UID,
      task_count: 5,
      evidence: {
        total_count: 3,
        season_counts: { '7D': 1, '30D': 1, '90D': 1 },
      },
    })

    const live = meili.indexes.get('traders')
    expect(live).toBeDefined()
    expect([...live!.documents.keys()].sort()).toEqual([
      'binance_futures--trader-30d--30D',
      'binance_futures--trader-7d--7D',
      'binance_futures--trader-90d--90D',
    ])
    expect(meili.indexes.has(CANDIDATE_UID)).toBe(false)
    expect(meili.swaps()).toBe(1)
    expect(
      meili.requests.filter(({ method, path }) => method === 'GET' && path.startsWith('/tasks/'))
        .length
    ).toBeGreaterThanOrEqual(5)
    expect(database.queryCalls).toHaveLength(6)
    for (const call of database.queryCalls) {
      expect(call.sources).toEqual(['binance_futures'])
      expect(call.cohort).toBe(COHORTS[call.season as keyof typeof COHORTS])
    }
    expect([...database.proofCalls.values()]).toEqual([4, 4, 4])
  })

  it('does not swap when a Meilisearch 202 task later reports failure', async () => {
    const database = databaseHarness()
    const meili = meiliHarness({ failSettingsTask: true })

    await expect(rebuildMeilisearchTraders(input(database, meili))).rejects.toThrow(
      'did not succeed (status: failed)'
    )
    expect(meili.swaps()).toBe(0)
    expect(meili.indexes.has(CANDIDATE_UID)).toBe(false)
    expect(meili.indexes.get('traders')?.documents.has('retired--old--90D')).toBe(true)
  })

  it('rejects a partial candidate identity set and keeps revoked live cleanup atomic', async () => {
    const database = databaseHarness()
    const meili = meiliHarness({ dropLastUpload: true })

    await expect(rebuildMeilisearchTraders(input(database, meili))).rejects.toThrow(
      'season_counts.90D must be positive'
    )
    expect(meili.swaps()).toBe(0)
    expect(meili.indexes.has(CANDIDATE_UID)).toBe(false)
    expect(meili.indexes.get('traders')?.documents.has('retired--old--90D')).toBe(true)
  })

  it('revalidates every source generation after upload and before atomic swap', async () => {
    const database = databaseHarness({ mutateFinalGeneration: true })
    const meili = meiliHarness()

    await expect(rebuildMeilisearchTraders(input(database, meili))).rejects.toThrow(
      'sealed leaderboard generation changed'
    )
    expect(meili.swaps()).toBe(0)
    expect(meili.indexes.has(CANDIDATE_UID)).toBe(false)
  })

  it('checks raw per-source identity digests before contacting Meilisearch', async () => {
    const database = databaseHarness({ corruptDigest: true })
    const meili = meiliHarness()

    await expect(rebuildMeilisearchTraders(input(database, meili))).rejects.toThrow(
      'identities do not match its publication proof'
    )
    expect(meili.fetchImpl).not.toHaveBeenCalled()
    expect(meili.swaps()).toBe(0)
  })
})
