import type { AuthSessionReturn } from '@/lib/hooks/useAuthSession'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'
import { captureInboxViewer, isInboxViewerCurrent } from '../viewer-scope'

function token(subject: string, marker = 'token'): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({ sub: subject, marker })}.signature`
}

function authFor(userId: string, sessionGeneration: number): AuthSessionReturn {
  return {
    accessToken: token(userId),
    authChecked: true,
    categorizeError: jest.fn(),
    email: `${userId}@example.com`,
    getAuthHeaders: jest.fn(),
    getAuthHeadersAsync: jest.fn(),
    getToken: jest.fn(),
    isLoggedIn: true,
    loading: false,
    refreshSession: jest.fn(),
    requireAuth: jest.fn(),
    sessionGeneration,
    signOut: jest.fn(),
    user: {
      id: userId,
      user_metadata: { avatar_url: `https://img.test/${userId}.png` },
    } as AuthSessionReturn['user'],
    userId,
    viewerKey: `user:${userId}`,
  }
}

describe('inbox viewer snapshot', () => {
  beforeEach(() => {
    __resetViewerScopeForTests()
  })

  it('captures only a JWT/process/hook-consistent canonical viewer', () => {
    const scope = synchronizeViewerScope(true, 'user-a')
    const auth = authFor('user-a', scope.sessionGeneration)
    const viewer = captureInboxViewer(auth)

    expect(viewer).toMatchObject({
      email: 'user-a@example.com',
      sessionGeneration: scope.sessionGeneration,
      userId: 'user-a',
      viewerKey: 'user:user-a',
    })
    expect(isInboxViewerCurrent(viewer!, auth)).toBe(true)
  })

  it('fails closed for a mismatched JWT or process generation', () => {
    const scope = synchronizeViewerScope(true, 'user-a')
    const mismatchedToken = {
      ...authFor('user-a', scope.sessionGeneration),
      accessToken: token('user-b'),
    }
    expect(captureInboxViewer(mismatchedToken)).toBeNull()

    const staleAuth = authFor('user-a', scope.sessionGeneration)
    const transition = beginViewerTransition('user-a')
    const next = commitViewerTransition(transition, 'user-a')
    expect(next).not.toBeNull()
    expect(captureInboxViewer(staleAuth)).toBeNull()
  })

  it('invalidates the same principal when its session generation changes', () => {
    const firstScope = synchronizeViewerScope(true, 'user-a')
    const firstAuth = authFor('user-a', firstScope.sessionGeneration)
    const firstViewer = captureInboxViewer(firstAuth)
    expect(firstViewer).not.toBeNull()

    const transition = beginViewerTransition('user-a')
    const secondScope = commitViewerTransition(transition, 'user-a')!
    const secondAuth = authFor('user-a', secondScope.sessionGeneration)

    expect(isInboxViewerCurrent(firstViewer!, secondAuth)).toBe(false)
    expect(captureInboxViewer(secondAuth)?.sessionGeneration).toBe(secondScope.sessionGeneration)
  })
})
