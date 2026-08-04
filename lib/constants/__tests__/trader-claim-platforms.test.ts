import { EXCHANGE_CONFIG } from '@/lib/constants/exchanges'
import { WALLET_CLAIM_PLATFORMS } from '@/lib/constants/wallet-platforms'
import {
  accountConnectionExchangeForSource,
  claimMethodForSource,
} from '@/lib/constants/trader-claim-platforms'

describe('trader claim platform contract', () => {
  it.each(WALLET_CLAIM_PLATFORMS)('%s uses wallet signature verification', (source) => {
    expect(claimMethodForSource(source)).toBe('signature')
  })

  it('ships no CEX profile claim until account UID and leaderboard identity are proven equivalent', () => {
    expect(
      ['binance_futures', 'bybit', 'okx_futures', 'bitget_futures', 'gateio', 'htx_futures'].filter(
        (source) => claimMethodForSource(source) === 'api_key'
      )
    ).toEqual([])
  })

  it.each([
    '',
    'mexc',
    'kucoin',
    'phemex',
    'bingx',
    'bitunix',
    'binance',
    'binance_futures',
    'binance_spot',
    'bybit',
    'bybit_spot',
    'okx',
    'okx_futures',
    'okx_spot',
    'bitget',
    'bitget_futures',
    'bitget_spot',
    'gate',
    'gateio',
    'htx',
    'htx_futures',
    'htx_spot',
    'bitget_bots_futures',
    'bitget_bots_spot',
    'bybit_mt5',
    'gate_cfd',
    'paradex',
    'kwenta',
    'vertex',
    'binance_web3',
    'okx_web3',
    'okx_web3_solana',
    'okx_wallet',
    'unknown_exchange',
  ])('%s fails closed as unsupported', (source) => {
    expect(claimMethodForSource(source)).toBe('unsupported')
  })

  it('never routes a known web3 source into the API-key verifier', () => {
    for (const [source, config] of Object.entries(EXCHANGE_CONFIG)) {
      if (config.sourceType === 'web3') {
        expect(claimMethodForSource(source)).not.toBe('api_key')
      }
    }
  })

  it('normalizes casing and surrounding whitespace', () => {
    expect(claimMethodForSource('  HYPERLIQUID  ')).toBe('signature')
    expect(claimMethodForSource('  BINANCE_FUTURES  ')).toBe('unsupported')
  })

  it.each([
    ['binance_futures', 'binance'],
    ['BYBIT_SPOT', 'bybit'],
    [' okx ', 'okx'],
    ['gateio', null],
    ['bitget_bots_spot', null],
    ['binance_web3', null],
  ])('maps account-data source %s to connection exchange %s', (source, expected) => {
    expect(accountConnectionExchangeForSource(source)).toBe(expected)
  })
})
