import { isFloatingActionRoute } from '../features'

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
