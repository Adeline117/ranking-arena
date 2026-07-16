import type { VisibleLeaderboardSource } from '@/lib/data/visible-leaderboard-sources'
import { orderedVisiblePartners, sourceProductVariant } from '../exchange-partners'

function source(
  registrySlug: string,
  filterSource: string,
  traderCount: number,
  productType = 'futures'
): VisibleLeaderboardSource {
  return {
    registrySlug,
    filterSource,
    exchangeSlug: registrySlug.split('_')[0],
    exchangeName: registrySlug.split('_')[0],
    productType,
    traderCount,
    cacheUpdatedAt: '2026-07-16T07:00:00.000Z',
  }
}

describe('homepage visible exchange partners', () => {
  it('orders by current coverage and deduplicates the actual public filter source', () => {
    const partners = orderedVisiblePartners([
      source('gate_futures', 'gateio', 533),
      source('bybit_copytrade', 'bybit', 576),
      source('stale', 'retired', 0),
      source('bybit_duplicate', 'bybit', 10),
    ])

    expect(partners.map(({ registrySlug, filterSource }) => [registrySlug, filterSource])).toEqual([
      ['bybit_copytrade', 'bybit'],
      ['gate_futures', 'gateio'],
    ])
  })

  it('keeps product surfaces honest, including bot and MT5 variants', () => {
    expect(sourceProductVariant(source('bitget_bots_futures', 'bitget_bots_futures', 20))).toBe(
      'bots-futures'
    )
    expect(sourceProductVariant(source('bitget_bots_spot', 'bitget_bots_spot', 20, 'spot'))).toBe(
      'bots-spot'
    )
    expect(sourceProductVariant(source('bybit_mt5', 'bybit_mt5', 20, 'cfd'))).toBe('mt5')
    expect(sourceProductVariant(source('gmx', 'gmx', 20, 'onchain'))).toBe('onchain')
  })
})
