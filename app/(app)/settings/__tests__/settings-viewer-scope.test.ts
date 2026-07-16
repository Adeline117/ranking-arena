import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'
import { captureSettingsViewer, isSettingsViewerCurrent } from '../hooks/settings-viewer-scope'

function jwt(userId: string): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${encode({ alg: 'none' })}.${encode({ sub: userId })}.signature`
}

function authFor(userId: string, sessionGeneration: number) {
  return {
    accessToken: jwt(userId),
    authChecked: true,
    email: `${userId}@example.com`,
    loading: false,
    sessionGeneration,
    userId,
    viewerKey: `user:${userId}` as const,
  }
}

describe('settings viewer scope', () => {
  beforeEach(() => __resetViewerScopeForTests())

  it('captures only a canonical resolved viewer', () => {
    const scope = synchronizeViewerScope(true, 'user-a')
    const snapshot = captureSettingsViewer(authFor('user-a', scope.sessionGeneration))

    expect(snapshot).toMatchObject({ userId: 'user-a', accessToken: jwt('user-a') })
    expect(isSettingsViewerCurrent(snapshot!, authFor('user-a', scope.sessionGeneration))).toBe(
      true
    )
    expect(
      captureSettingsViewer({
        ...authFor('user-a', scope.sessionGeneration),
        accessToken: null,
      })
    ).toBeNull()
    expect(
      captureSettingsViewer({
        ...authFor('user-a', scope.sessionGeneration),
        accessToken: jwt('user-b'),
      })
    ).toBeNull()
  })

  it('invalidates A before B resolves and never accepts A again', () => {
    const scopeA = synchronizeViewerScope(true, 'user-a')
    const authA = authFor('user-a', scopeA.sessionGeneration)
    const snapshotA = captureSettingsViewer(authA)!

    const transition = beginViewerTransition('user-b')
    expect(isSettingsViewerCurrent(snapshotA, authA)).toBe(false)

    const scopeB = commitViewerTransition(transition, 'user-b')!
    expect(isSettingsViewerCurrent(snapshotA, authA)).toBe(false)
    expect(captureSettingsViewer(authFor('user-b', scopeB.sessionGeneration))).not.toBeNull()
  })
})
