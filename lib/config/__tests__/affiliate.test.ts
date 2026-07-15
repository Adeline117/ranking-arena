import { getAffiliateReferral } from '../affiliate'

describe('affiliate referral safety', () => {
  it('does not emit placeholder partnerships before owner-supplied deals exist', () => {
    for (const source of [
      'binance_futures',
      'bybit',
      'bitget_futures',
      'okx_futures',
      'mexc',
      'gateio',
      'kucoin',
      'htx_futures',
      'bingx',
      'blofin',
    ]) {
      expect(getAffiliateReferral(source)).toBeNull()
    }
  })

  it('fails closed for missing and unknown sources', () => {
    expect(getAffiliateReferral(undefined)).toBeNull()
    expect(getAffiliateReferral('unknown_exchange')).toBeNull()
  })
})
