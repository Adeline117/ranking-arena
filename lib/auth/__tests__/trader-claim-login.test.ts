import { buildTraderClaimLoginHref, buildTraderClaimReturnPath } from '../trader-claim-login'

describe('trader claim login intent', () => {
  it('keeps the composite exchange identity and verification step', () => {
    expect(
      buildTraderClaimReturnPath({
        traderId: 'account/42',
        source: 'binance futures',
        handle: 'Alice & Bob',
      })
    ).toBe('/claim?trader=account%2F42&source=binance+futures&handle=Alice+%26+Bob&step=verify')
  })

  it('wraps the exact claim destination in a login return URL', () => {
    const href = buildTraderClaimLoginHref({
      traderId: 'trader-1',
      source: 'binance',
      handle: 'alice',
    })

    const loginUrl = new URL(href, 'https://arena.invalid')
    expect(loginUrl.pathname).toBe('/login')
    expect(loginUrl.searchParams.get('returnUrl')).toBe(
      '/claim?trader=trader-1&source=binance&handle=alice&step=verify'
    )
  })

  it('uses the immutable trader identity when a display handle is absent', () => {
    expect(buildTraderClaimReturnPath({ traderId: '0xabc', source: 'hyperliquid' })).toBe(
      '/claim?trader=0xabc&source=hyperliquid&handle=0xabc&step=verify'
    )
  })

  it.each([
    [{ traderId: '', source: 'binance' }, 'traderId'],
    [{ traderId: 'trader-1', source: '  ' }, 'source'],
  ])(
    'rejects an incomplete claim identity instead of falling back to /claim',
    (identity, field) => {
      expect(() => buildTraderClaimLoginHref(identity)).toThrow(field)
    }
  )
})
