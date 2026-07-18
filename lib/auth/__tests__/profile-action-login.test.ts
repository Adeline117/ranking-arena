import {
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

  it('refuses an unsafe fallback instead of silently returning to the homepage', () => {
    expect(() =>
      queueProfileActionLogin({
        action: 'claim-trader',
        target: profileTraderTarget('binance', 'trader-1'),
        fallbackPath: '//evil.example',
      })
    ).toThrow('safe internal fallback')
  })
})
