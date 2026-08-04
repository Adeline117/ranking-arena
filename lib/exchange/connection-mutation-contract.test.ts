import {
  readExchangeDisconnectAcknowledgement,
  readExchangeMutationError,
} from './connection-mutation-contract'

describe('exchange connection mutation contract', () => {
  it('accepts only the exact exchange-bound disconnect acknowledgement', () => {
    expect(
      readExchangeDisconnectAcknowledgement({ success: true, exchange: 'binance' }, 'binance')
    ).toBe(true)
    expect(
      readExchangeDisconnectAcknowledgement({ success: true, exchange: 'bybit' }, 'binance')
    ).toBe(false)
    expect(
      readExchangeDisconnectAcknowledgement(
        { success: true, exchange: 'binance', message: 'done' },
        'binance'
      )
    ).toBe(false)
  })

  it('bounds server error text', () => {
    expect(readExchangeMutationError({ error: ' unavailable ' })).toBe('unavailable')
    expect(readExchangeMutationError({ error: 'x'.repeat(201) })).toBeNull()
  })
})
