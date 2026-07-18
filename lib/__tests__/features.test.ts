import { isFeedbackSuppressedRoute, isFloatingActionRoute } from '../features'

describe('isFloatingActionRoute', () => {
  it.each(['/', '/groups', '/groups/alpha'])('reserves the create-post slot on %s', (pathname) => {
    expect(isFloatingActionRoute(pathname)).toBe(true)
  })

  it.each(['/hot', '/market', '/market/open-interest', '/watchlist', '/saved', '/referral'])(
    'does not reserve a nonexistent FAB on %s',
    (pathname) => {
      expect(isFloatingActionRoute(pathname)).toBe(false)
    }
  )
})

describe('isFeedbackSuppressedRoute', () => {
  it.each([
    '/login',
    '/register',
    '/forgot-password',
    '/reset-password',
    '/pricing',
    '/pricing/success',
  ])('keeps the global feedback control off critical form route %s', (pathname) => {
    expect(isFeedbackSuppressedRoute(pathname)).toBe(true)
  })

  it.each(['/', '/groups', '/settings', '/trader/example'])(
    'keeps feedback available on ordinary route %s',
    (pathname) => {
      expect(isFeedbackSuppressedRoute(pathname)).toBe(false)
    }
  )
})
