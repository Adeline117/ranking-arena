jest.mock('@/lib/auth/token-refresh', () => ({
  registerAuthStateSetter: jest.fn(),
  tokenRefreshCoordinator: {
    getValidToken: jest.fn(),
    forceRefresh: jest.fn(),
  },
}))

import { authFetch } from '../useAuthSession'
import { tokenRefreshCoordinator } from '@/lib/auth/token-refresh'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'

const mockGetValidToken = tokenRefreshCoordinator.getValidToken as jest.Mock
const mockForceRefresh = tokenRefreshCoordinator.forceRefresh as jest.Mock

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function response(status: number): Response {
  return new Response('{}', { status, headers: { 'content-type': 'application/json' } })
}

describe('authFetch viewer scope', () => {
  beforeEach(() => {
    __resetViewerScopeForTests()
    mockGetValidToken.mockReset()
    mockForceRefresh.mockReset()
    global.fetch = jest.fn()
  })

  it('rejects a successful A response after the viewer becomes B', async () => {
    synchronizeViewerScope(true, 'user-a')
    mockGetValidToken.mockResolvedValue('token-a')
    const network = deferred<Response>()
    ;(global.fetch as jest.Mock).mockReturnValueOnce(network.promise)

    const request = authFetch('/api/private')
    while ((global.fetch as jest.Mock).mock.calls.length < 1) await Promise.resolve()
    beginViewerTransition('user-b')
    network.resolve(response(200))

    const result = await request
    expect(result.status).toBe(401)
    expect(result.headers.get('x-arena-stale-auth')).toBe('1')
  })

  it('does not replay A after the refresh boundary becomes stale', async () => {
    synchronizeViewerScope(true, 'user-a')
    mockGetValidToken.mockResolvedValue('token-a')
    ;(global.fetch as jest.Mock).mockResolvedValueOnce(response(401))
    mockForceRefresh.mockImplementationOnce(async () => {
      beginViewerTransition('user-b')
      return 'token-b'
    })

    const result = await authFetch('/api/private')

    expect(result.status).toBe(401)
    expect(result.headers.get('x-arena-stale-auth')).toBe('1')
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })
})
