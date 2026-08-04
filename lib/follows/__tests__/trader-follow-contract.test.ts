import { readTraderFollowAcknowledgement } from '../trader-follow-contract'

const acknowledgement = {
  success: true,
  data: {
    following: true,
    traderId: 'trader-1',
    source: 'bybit',
  },
}

describe('trader follow acknowledgement contract', () => {
  it('accepts only the exact account and requested state', () => {
    expect(
      readTraderFollowAcknowledgement(acknowledgement, {
        following: true,
        traderId: 'trader-1',
        source: 'bybit',
      })
    ).toEqual({
      following: true,
      traderId: 'trader-1',
      source: 'bybit',
      tableNotFound: false,
    })
  })

  it('accepts the exact degraded GET receipt only when explicitly allowed', () => {
    const degraded = {
      success: true,
      data: {
        following: false,
        traderId: 'trader-1',
        source: 'bybit',
        tableNotFound: true,
      },
    }

    expect(
      readTraderFollowAcknowledgement(degraded, {
        traderId: 'trader-1',
        source: 'bybit',
        allowTableNotFound: true,
      })
    ).toEqual({
      following: false,
      traderId: 'trader-1',
      source: 'bybit',
      tableNotFound: true,
    })
    expect(
      readTraderFollowAcknowledgement(degraded, {
        following: false,
        traderId: 'trader-1',
        source: 'bybit',
      })
    ).toBeNull()
  })

  it.each([
    ['wrong trader', { ...acknowledgement, data: { ...acknowledgement.data, traderId: 'other' } }],
    ['wrong source', { ...acknowledgement, data: { ...acknowledgement.data, source: 'okx' } }],
    ['wrong state', { ...acknowledgement, data: { ...acknowledgement.data, following: false } }],
    ['extra envelope field', { ...acknowledgement, meta: {} }],
    ['extra data field', { ...acknowledgement, data: { ...acknowledgement.data, extra: true } }],
    ['missing data field', { success: true, data: { following: true, traderId: 'trader-1' } }],
    ['direct legacy body', acknowledgement.data],
  ])('rejects a %s', (_label, value) => {
    expect(
      readTraderFollowAcknowledgement(value, {
        following: true,
        traderId: 'trader-1',
        source: 'bybit',
      })
    ).toBeNull()
  })
})
