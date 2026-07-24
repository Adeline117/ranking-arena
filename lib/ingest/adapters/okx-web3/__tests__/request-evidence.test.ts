import type { ReplayRequestTemplate } from '../../../fetch/types'
import type { RankingTimeframe } from '../../../core/types'
import {
  OKX_WEB3_LEADERBOARD_LIST_URL,
  buildOkxWeb3LeaderboardListUrl,
  projectOkxWeb3LeaderboardRequest,
} from '../request-evidence'

describe('OKX Web3 leaderboard request evidence', () => {
  it.each([
    [7, '3'],
    [30, '4'],
    [90, '5'],
  ] as const)('builds the exact native %dD period request', (timeframe, periodType) => {
    const first = buildOkxWeb3LeaderboardListUrl({ pageIndex: 1, pageSize: 20, timeframe })
    const second = buildOkxWeb3LeaderboardListUrl({ pageIndex: 2, pageSize: 20, timeframe })

    expect(first).toBe(
      `${OKX_WEB3_LEADERBOARD_LIST_URL}?rankStart=0&rankEnd=20&periodType=${periodType}` +
        '&rankBy=1&label=all&desc=true&chainId=501'
    )
    expect(second).toContain('rankStart=20&rankEnd=40')
  })

  it('canonicalizes only the seven reviewed public query fields', () => {
    const request: ReplayRequestTemplate = {
      url:
        `${OKX_WEB3_LEADERBOARD_LIST_URL}?desc=true&chainId=501&rankEnd=40&label=all` +
        '&rankBy=1&periodType=4&rankStart=20',
      method: 'GET',
      headers: { authorization: 'SUPERSECRET' },
    }

    expect(projectOkxWeb3LeaderboardRequest(request)).toEqual({
      method: 'GET',
      url:
        `${OKX_WEB3_LEADERBOARD_LIST_URL}?rankStart=20&rankEnd=40&periodType=4` +
        '&rankBy=1&label=all&desc=true&chainId=501',
    })
    expect(JSON.stringify(projectOkxWeb3LeaderboardRequest(request))).not.toContain('SUPERSECRET')
  })

  it('rejects unsafe page configuration before constructing a request', () => {
    for (const pageSize of [-0, 0, 1.5, 21, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        buildOkxWeb3LeaderboardListUrl({ pageIndex: 1, pageSize, timeframe: 30 })
      ).toThrow('page size')
    }
    for (const pageIndex of [-0, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        buildOkxWeb3LeaderboardListUrl({ pageIndex, pageSize: 20, timeframe: 30 })
      ).toThrow('page index')
    }
    for (const timeframe of [1, 'toString', '__proto__']) {
      expect(() =>
        buildOkxWeb3LeaderboardListUrl({
          pageIndex: 1,
          pageSize: 20,
          timeframe: timeframe as unknown as RankingTimeframe,
        })
      ).toThrow('timeframe must be 7, 30, or 90 days')
    }
    expect(() =>
      buildOkxWeb3LeaderboardListUrl({
        endpoint: `${OKX_WEB3_LEADERBOARD_LIST_URL}?token=secret`,
        pageIndex: 1,
        pageSize: 20,
        timeframe: 30,
      })
    ).toThrow('must not contain query parameters')
  })

  it.each([
    ['method', { method: 'POST' }],
    ['body', { body: { ignored: true } }],
    ['missing', { url: `${OKX_WEB3_LEADERBOARD_LIST_URL}?rankStart=0` }],
    [
      'duplicate',
      {
        url:
          buildOkxWeb3LeaderboardListUrl({ pageIndex: 1, pageSize: 20, timeframe: 30 }) +
          '&rankStart=20',
      },
    ],
    [
      'unknown',
      {
        url:
          buildOkxWeb3LeaderboardListUrl({ pageIndex: 1, pageSize: 20, timeframe: 30 }) +
          '&signature=secret',
      },
    ],
    [
      'unaligned',
      {
        url: buildOkxWeb3LeaderboardListUrl({ pageIndex: 1, pageSize: 20, timeframe: 30 }).replace(
          'rankStart=0',
          'rankStart=1'
        ),
      },
    ],
    [
      'oversized',
      {
        url: buildOkxWeb3LeaderboardListUrl({ pageIndex: 1, pageSize: 20, timeframe: 30 }).replace(
          'rankEnd=20',
          'rankEnd=21'
        ),
      },
    ],
    [
      'filter drift',
      {
        url: buildOkxWeb3LeaderboardListUrl({ pageIndex: 1, pageSize: 20, timeframe: 30 }).replace(
          'chainId=501',
          'chainId=1'
        ),
      },
    ],
  ])('rejects %s request drift', (_label, patch) => {
    const valid: ReplayRequestTemplate = {
      url: buildOkxWeb3LeaderboardListUrl({ pageIndex: 1, pageSize: 20, timeframe: 30 }),
      method: 'GET',
      headers: {},
    }
    expect(() =>
      projectOkxWeb3LeaderboardRequest({ ...valid, ...(patch as Partial<ReplayRequestTemplate>) })
    ).toThrow()
  })
})
