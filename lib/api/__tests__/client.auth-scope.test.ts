jest.mock('@/lib/auth/token-refresh', () => ({
  tokenRefreshCoordinator: {
    forceRefresh: jest.fn(),
  },
}))

import { authedFetch } from '../client'
import { tokenRefreshCoordinator } from '@/lib/auth/token-refresh'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'

const mockForceRefresh = tokenRefreshCoordinator.forceRefresh as jest.Mock

function response(status: number, data: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(data),
    headers: new Headers({ 'content-type': 'application/json' }),
  } as unknown as Response
}

describe('authedFetch viewer-bound retry', () => {
  beforeEach(() => {
    __resetViewerScopeForTests()
    mockForceRefresh.mockReset()
    global.fetch = jest.fn()
  })

  it('never replays an A request with a token obtained after switching to B', async () => {
    const scope = synchronizeViewerScope(true, 'user-a')
    ;(global.fetch as jest.Mock).mockResolvedValueOnce(response(401, { error: 'expired' }))
    let resolveRefresh!: (token: string) => void
    mockForceRefresh.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveRefresh = resolve
      })
    )

    const request = authedFetch('/api/private', 'POST', 'opaque-a-token', {}, 15_000, {
      expectedUserId: 'user-a',
      expectedSessionGeneration: scope.sessionGeneration,
    })
    await Promise.resolve()
    beginViewerTransition('user-b')
    resolveRefresh('token-b')

    await expect(request).resolves.toMatchObject({ stale: true, ok: false })
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('retries once after a same-user token refresh', async () => {
    const scope = synchronizeViewerScope(true, 'user-a')
    ;(global.fetch as jest.Mock)
      .mockResolvedValueOnce(response(401, { error: 'expired' }))
      .mockResolvedValueOnce(response(200, { success: true }))
    mockForceRefresh.mockResolvedValueOnce('token-a2')

    const result = await authedFetch('/api/private', 'GET', 'token-a1', undefined, 15_000, {
      expectedUserId: 'user-a',
      expectedSessionGeneration: scope.sessionGeneration,
    })

    expect(result).toMatchObject({ ok: true })
    expect(result.stale).toBeUndefined()
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect((global.fetch as jest.Mock).mock.calls[1][1].headers.Authorization).toBe(
      'Bearer token-a2'
    )
  })
})
