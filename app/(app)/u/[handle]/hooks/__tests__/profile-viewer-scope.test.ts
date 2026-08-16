import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'
import {
  captureProfileViewer,
  isProfileViewerCurrent,
  profileViewerIsResolved,
} from '../profile-viewer-scope'

function jwt(userId: string, signature = 'signature'): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${encode({ alg: 'none' })}.${encode({ sub: userId })}.${signature}`
}

function authFor(userId: string, sessionGeneration: number, accessToken = jwt(userId)) {
  return {
    accessToken,
    authChecked: true,
    email: `${userId}@example.com`,
    loading: false,
    sessionGeneration,
    userId,
    viewerKey: `user:${userId}` as const,
  }
}

describe('profile viewer scope', () => {
  beforeEach(() => __resetViewerScopeForTests())

  it('captures only a resolved viewer whose JWT subject and process scope agree', () => {
    const scope = synchronizeViewerScope(true, 'user-a')
    const auth = authFor('user-a', scope.sessionGeneration)

    expect(captureProfileViewer(auth)).toMatchObject({
      userId: 'user-a',
      accessToken: jwt('user-a'),
    })
    expect(captureProfileViewer({ ...auth, accessToken: jwt('user-b') })).toBeNull()
    expect(captureProfileViewer({ ...auth, loading: true })).toBeNull()
    expect(profileViewerIsResolved(auth)).toBe(true)
    expect(profileViewerIsResolved({ ...auth, authChecked: false, loading: true })).toBe(false)
    expect(profileViewerIsResolved({ ...auth, accessToken: jwt('user-b') })).toBe(false)
  })

  it('distinguishes a canonical anonymous viewer from a pending transition', () => {
    const anonymousScope = synchronizeViewerScope(true, null)
    const anonymous = {
      accessToken: null,
      authChecked: true,
      email: null,
      loading: false,
      sessionGeneration: anonymousScope.sessionGeneration,
      userId: null,
      viewerKey: 'anon' as const,
    }

    expect(profileViewerIsResolved(anonymous)).toBe(true)

    const pendingGeneration = beginViewerTransition(null)
    expect(
      profileViewerIsResolved({
        ...anonymous,
        authChecked: false,
        loading: true,
        sessionGeneration: pendingGeneration,
        viewerKey: 'pending',
      })
    ).toBe(false)
    expect(profileViewerIsResolved(anonymous)).toBe(false)
  })

  it('invalidates an operation when its exact dispatch token rotates', () => {
    const scope = synchronizeViewerScope(true, 'user-a')
    const initialAuth = authFor('user-a', scope.sessionGeneration)
    const snapshot = captureProfileViewer(initialAuth)!
    const refreshedAuth = authFor('user-a', scope.sessionGeneration, jwt('user-a', 'rotated'))

    expect(isProfileViewerCurrent(snapshot, initialAuth)).toBe(true)
    expect(isProfileViewerCurrent(snapshot, refreshedAuth)).toBe(false)
    expect(captureProfileViewer(refreshedAuth)).not.toBeNull()
  })

  it('invalidates A before B resolves at the process-wide transition boundary', () => {
    const scopeA = synchronizeViewerScope(true, 'user-a')
    const authA = authFor('user-a', scopeA.sessionGeneration)
    const snapshotA = captureProfileViewer(authA)!

    const transition = beginViewerTransition('user-b')
    expect(isProfileViewerCurrent(snapshotA, authA)).toBe(false)

    const scopeB = commitViewerTransition(transition, 'user-b')!
    expect(captureProfileViewer(authFor('user-b', scopeB.sessionGeneration))).not.toBeNull()
    expect(isProfileViewerCurrent(snapshotA, authA)).toBe(false)
  })
})
