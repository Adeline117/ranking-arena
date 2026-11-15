import { LeaderboardCaptureUpstreamError } from '../capture'
import {
  allowlistedPublicRequest,
  captureReplayLeaderboard,
  collectionMeta,
  requireEnvelopeValue,
} from '../replay-capture'
import type { SourceRow } from '../../core/types'
import type { FetchSession, ReplayRequestTemplate } from '../types'

const session = { paced: async <T>(fn: () => Promise<T>) => fn() } as unknown as FetchSession
const src = { meta: {} } as SourceRow

const meta = collectionMeta({
  label: 'test',
  assertSuccess: requireEnvelopeValue('test', ['code'], [0]),
  list: ['data', 'rows'],
  total: ['data', 'total'],
})

function board(rows: number, total: unknown, code = 0) {
  return { code, data: { rows: Array.from({ length: rows }, (_, i) => ({ id: i })), total } }
}

function capture(responses: unknown[], callerPages?: number) {
  const requests: ReplayRequestTemplate[] = []
  let call = 0
  return {
    requests,
    result: captureReplayLeaderboard(
      {
        session,
        fetcher: async (request) => {
          requests.push(request)
          return { status: 200, json: responses[call++] }
        },
        src: { ...src, meta: callerPages ? { max_pages: callerPages } : {} },
        label: 'test',
      },
      {
        buildRequest: (pageIndex) => ({
          url: `https://board.example/list?page=${pageIndex}&size=2&tf=30&token=SECRET`,
          method: 'GET',
          headers: { cookie: 'SECRET' },
        }),
        publicRequest: { query: ['page', 'size', 'tf'] },
        pageBinding: { location: 'query', key: 'page' },
        extractMeta: meta,
        pageSize: 2,
      }
    ),
  }
}

describe('captureReplayLeaderboard', () => {
  it('pages until the reported population and persists only allowlisted request fields', async () => {
    const { result, requests } = capture([board(2, '3'), board(1, 3)])
    const captured = await result

    expect(requests).toHaveLength(2)
    expect(captured.terminationReason).toBe('reported_population_reached')
    expect(captured.sourcePages.map((page) => page.rawPage.url)).toEqual([
      'https://board.example/list?page=1&size=2&tf=30',
      'https://board.example/list?page=2&size=2&tf=30',
    ])
    expect(JSON.stringify(captured)).not.toContain('SECRET')
    expect(captured.sourcePages.map((page) => page.sourceReports.population)).toEqual([
      { state: 'reported', value: 3 },
      { state: 'reported', value: 3 },
    ])
  })

  it('records a failed envelope or a missing row array as upstream error, never an empty page', async () => {
    for (const response of [board(0, 0, 500), { code: 0, data: {} }]) {
      const { result } = capture([response])
      const error = await result.catch((cause: unknown) => cause)
      expect(error).toBeInstanceOf(LeaderboardCaptureUpstreamError)
      expect((error as LeaderboardCaptureUpstreamError).capture.terminationReason).toBe(
        'upstream_error'
      )
    }
  })

  it('treats meta.max_pages as an explicit caller limit', async () => {
    const captured = await capture([board(2, 10)], 1).result
    expect(captured.terminationReason).toBe('caller_limit')
  })
})

describe('allowlistedPublicRequest', () => {
  it('requires every allowlisted POST body field and drops the rest', () => {
    const project = allowlistedPublicRequest({ body: ['page', 'size'] })
    const request = {
      url: 'https://board.example/list',
      method: 'POST' as const,
      headers: {},
      body: { page: 1, size: 2, extra: 'x' },
    }
    expect(project(request)).toEqual({
      method: 'POST',
      url: 'https://board.example/list',
      body: { page: 1, size: 2 },
    })
    expect(() => project({ ...request, body: { page: 1 } })).toThrow('size is missing')
  })
})
