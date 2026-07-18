import {
  bookmarkPostTarget,
  consumePostBookmarkLogin,
  consumeProfileActionLogin,
  profileTraderTarget,
  profileUserTarget,
  queueProfileActionLogin,
} from '../profile-action-login'

describe('profile action login handoff', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/u/alice?tab=portfolio')
    window.sessionStorage.clear()
  })

  it('preserves the exact profile URL and action through the login return URL', () => {
    const href = queueProfileActionLogin({
      action: 'follow-user',
      target: profileUserTarget('user-1'),
      fallbackPath: '/u/alice',
      now: 1_000,
    })

    const loginUrl = new URL(href, 'https://arena.invalid')
    expect(loginUrl.pathname).toBe('/login')
    expect(loginUrl.searchParams.get('returnUrl')).toBe(
      '/u/alice?tab=portfolio&resumeAction=follow-user'
    )
  })

  it('consumes only a matching same-tab action and removes its URL marker first', () => {
    const href = queueProfileActionLogin({
      action: 'message-user',
      target: profileUserTarget('user-1'),
      fallbackPath: '/u/alice',
      now: 1_000,
    })
    const returnPath = new URL(href, 'https://arena.invalid').searchParams.get('returnUrl')!
    window.history.replaceState({}, '', returnPath)

    expect(
      consumeProfileActionLogin({
        actions: ['message-user'],
        target: profileUserTarget('user-1'),
        now: 2_000,
      })
    ).toBe('message-user')
    expect(`${window.location.pathname}${window.location.search}`).toBe('/u/alice?tab=portfolio')
    expect(
      consumeProfileActionLogin({
        actions: ['message-user'],
        target: profileUserTarget('user-1'),
        now: 2_000,
      })
    ).toBeNull()
  })

  it('never trusts a URL marker without a matching click proof', () => {
    window.history.replaceState({}, '', '/trader/bob?platform=binance&resumeAction=follow-trader')

    expect(
      consumeProfileActionLogin({
        actions: ['follow-trader'],
        target: profileTraderTarget('binance', 'trader-1'),
        now: 2_000,
      })
    ).toBeNull()
  })

  it('binds an expired-session action to the account that initiated it', () => {
    const href = queueProfileActionLogin({
      action: 'follow-user',
      target: profileUserTarget('user-1'),
      fallbackPath: '/u/alice',
      initiatingUserId: 'viewer-a',
      now: 1_000,
    })
    const returnPath = new URL(href, 'https://arena.invalid').searchParams.get('returnUrl')!
    window.history.replaceState({}, '', returnPath)

    expect(
      consumeProfileActionLogin({
        actions: ['follow-user'],
        target: profileUserTarget('user-1'),
        currentUserId: 'viewer-b',
        now: 2_000,
      })
    ).toBeNull()
    expect(`${window.location.pathname}${window.location.search}`).toBe('/u/alice?tab=portfolio')
    expect(window.sessionStorage).toHaveLength(0)
  })

  it('allows a truly anonymous action for the account chosen during login', () => {
    const href = queueProfileActionLogin({
      action: 'follow-user',
      target: profileUserTarget('user-1'),
      fallbackPath: '/u/alice',
      now: 1_000,
    })
    const returnPath = new URL(href, 'https://arena.invalid').searchParams.get('returnUrl')!
    window.history.replaceState({}, '', returnPath)

    expect(
      consumeProfileActionLogin({
        actions: ['follow-user'],
        target: profileUserTarget('user-1'),
        currentUserId: 'viewer-b',
        now: 2_000,
      })
    ).toBe('follow-user')
  })

  it('fails closed when the same-tab proof cannot be removed', () => {
    const href = queueProfileActionLogin({
      action: 'message-user',
      target: profileUserTarget('user-1'),
      fallbackPath: '/u/alice',
      now: 1_000,
    })
    const returnPath = new URL(href, 'https://arena.invalid').searchParams.get('returnUrl')!
    window.history.replaceState({}, '', returnPath)
    const removeSpy = jest.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('storage unavailable')
    })

    expect(
      consumeProfileActionLogin({
        actions: ['message-user'],
        target: profileUserTarget('user-1'),
        currentUserId: 'viewer-b',
        now: 2_000,
      })
    ).toBeNull()
    expect(`${window.location.pathname}${window.location.search}`).toBe('/u/alice?tab=portfolio')

    removeSpy.mockRestore()
  })

  it('rejects a different target and an expired action', () => {
    const href = queueProfileActionLogin({
      action: 'watch-trader',
      target: profileTraderTarget('binance', 'trader-1'),
      fallbackPath: '/trader/bob?platform=binance',
      now: 1_000,
    })
    const returnPath = new URL(href, 'https://arena.invalid').searchParams.get('returnUrl')!
    window.history.replaceState({}, '', returnPath)

    expect(
      consumeProfileActionLogin({
        actions: ['watch-trader'],
        target: profileTraderTarget('binance', 'trader-2'),
        now: 2_000,
      })
    ).toBeNull()
    expect(
      consumeProfileActionLogin({
        actions: ['watch-trader'],
        target: profileTraderTarget('binance', 'trader-1'),
        now: 16 * 60 * 1_000,
      })
    ).toBeNull()
  })

  it('uses the live internal route instead of an unsafe fallback', () => {
    window.history.replaceState({}, '', '/trader/alice?platform=binance')
    const href = queueProfileActionLogin({
      action: 'claim-trader',
      target: profileTraderTarget('binance', 'trader-1'),
      fallbackPath: '//evil.example',
    })

    expect(new URL(href, 'https://arena.invalid').searchParams.get('returnUrl')).toBe(
      '/trader/alice?platform=binance&resumeAction=claim-trader'
    )
  })

  it('returns the exact bookmarked post only from a matching same-tab proof', () => {
    const postId = '22222222-2222-4222-8222-222222222222'
    window.history.replaceState({}, '', `/post/${postId}`)
    const href = queueProfileActionLogin({
      action: 'bookmark-post',
      target: bookmarkPostTarget(postId),
      fallbackPath: `/post/${postId}`,
      now: 1_000,
    })
    const returnPath = new URL(href, 'https://arena.invalid').searchParams.get('returnUrl')!
    window.history.replaceState({}, '', returnPath)

    expect(consumePostBookmarkLogin({ currentUserId: 'viewer-b', now: 2_000 })).toBe(postId)
    expect(`${window.location.pathname}${window.location.search}`).toBe(`/post/${postId}`)
    expect(window.sessionStorage).toHaveLength(0)
    expect(consumePostBookmarkLogin({ currentUserId: 'viewer-b', now: 2_000 })).toBeNull()
  })

  it('does not derive a bookmark target from a crafted URL marker', () => {
    const postId = '22222222-2222-4222-8222-222222222222'
    window.history.replaceState({}, '', `/post/${postId}?resumeAction=bookmark-post`)

    expect(consumePostBookmarkLogin({ currentUserId: 'viewer-b', now: 2_000 })).toBeNull()
  })

  it('rejects expired and cross-account bookmark proofs', () => {
    const postId = '22222222-2222-4222-8222-222222222222'
    window.history.replaceState({}, '', `/post/${postId}`)
    const expiredHref = queueProfileActionLogin({
      action: 'bookmark-post',
      target: bookmarkPostTarget(postId),
      fallbackPath: `/post/${postId}`,
      now: 1_000,
    })
    window.history.replaceState(
      {},
      '',
      new URL(expiredHref, 'https://arena.invalid').searchParams.get('returnUrl')!
    )

    expect(consumePostBookmarkLogin({ currentUserId: 'viewer-b', now: 16 * 60 * 1_000 })).toBeNull()
    expect(window.sessionStorage).toHaveLength(0)

    window.history.replaceState({}, '', `/post/${postId}`)
    const boundHref = queueProfileActionLogin({
      action: 'bookmark-post',
      target: bookmarkPostTarget(postId),
      fallbackPath: `/post/${postId}`,
      initiatingUserId: 'viewer-a',
      now: 1_000,
    })
    window.history.replaceState(
      {},
      '',
      new URL(boundHref, 'https://arena.invalid').searchParams.get('returnUrl')!
    )

    expect(consumePostBookmarkLogin({ currentUserId: 'viewer-b', now: 2_000 })).toBeNull()
    expect(window.sessionStorage).toHaveLength(0)
  })
})
