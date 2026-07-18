import { followItemHref, followItemIdentity, removeFollowItemByIdentity } from '../identity'

describe('following composite UI identity', () => {
  const bybit = {
    id: 'shared-id',
    identity_key: 'trader:source:bybit:shared-id',
    type: 'trader' as const,
    source: 'bybit',
    platform: 'bybit',
    handle: 'Bybit trader',
  }
  const binance = {
    id: 'shared-id',
    identity_key: 'trader:source:binance_futures:shared-id',
    type: 'trader' as const,
    source: 'binance_futures',
    platform: 'binance_futures',
    handle: 'Binance trader',
  }

  it('removes only the selected source when raw trader ids collide', () => {
    expect(followItemIdentity(bybit)).not.toBe(followItemIdentity(binance))
    expect(removeFollowItemByIdentity([bybit, binance], bybit)).toEqual([binance])
  })

  it('builds the canonical platform query for trader details', () => {
    expect(followItemHref(binance)).toBe('/trader/Binance%20trader?platform=binance_futures')
  })

  it('keeps an unresolved legacy edge removable without routing it to a guessed platform', () => {
    const legacy = {
      id: 'legacy-id',
      identity_key: 'trader:legacy-null:legacy-id',
      type: 'trader' as const,
      source: null,
      handle: 'legacy-id',
    }
    expect(followItemIdentity(legacy)).toBe('trader:legacy-null:legacy-id')
    expect(followItemHref(legacy)).toBeNull()
    expect(removeFollowItemByIdentity([legacy, bybit], legacy)).toEqual([bybit])
  })
})
