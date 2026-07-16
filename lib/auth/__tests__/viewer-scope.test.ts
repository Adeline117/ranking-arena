import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  getViewerScope,
  isViewerScopeCurrent,
  synchronizeViewerScope,
} from '../viewer-scope'

describe('viewer identity scope', () => {
  beforeEach(() => __resetViewerScopeForTests())

  it('keeps the generation stable for a same-user token refresh', () => {
    const first = synchronizeViewerScope(true, 'user-a')
    const refreshed = synchronizeViewerScope(true, 'user-a')

    expect(refreshed).toEqual(first)
    expect(refreshed.viewerKey).toBe('user:user-a')
  })

  it('invalidates captured work immediately when the principal changes', () => {
    const userA = synchronizeViewerScope(true, 'user-a')
    beginViewerTransition('user-b')

    expect(getViewerScope().viewerKey).toBe('pending')
    expect(isViewerScopeCurrent(userA)).toBe(false)

    const userB = synchronizeViewerScope(true, 'user-b')
    expect(userB.viewerKey).toBe('user:user-b')
    expect(userB.sessionGeneration).toBeGreaterThan(userA.sessionGeneration)
  })

  it('uses distinct epochs for pending, anonymous, login, and logout', () => {
    const initial = getViewerScope()
    const anonymous = synchronizeViewerScope(true, null)
    const user = synchronizeViewerScope(true, 'user-a')
    const loggedOut = synchronizeViewerScope(true, null)

    expect(anonymous.sessionGeneration).toBe(initial.sessionGeneration + 1)
    expect(user.sessionGeneration).toBe(anonymous.sessionGeneration + 1)
    expect(loggedOut.sessionGeneration).toBe(user.sessionGeneration + 1)
  })

  it('lets only the newest concurrent transition commit its principal', () => {
    synchronizeViewerScope(true, 'user-a')
    const switchGeneration = beginViewerTransition('user-b')
    const logoutGeneration = beginViewerTransition(null)

    expect(commitViewerTransition(switchGeneration, 'user-b')).toBeNull()
    expect(getViewerScope().viewerKey).toBe('pending')

    expect(commitViewerTransition(logoutGeneration, null)).toMatchObject({
      viewerKey: 'anon',
      userId: null,
    })
    expect(getViewerScope().viewerKey).toBe('anon')
  })
})
