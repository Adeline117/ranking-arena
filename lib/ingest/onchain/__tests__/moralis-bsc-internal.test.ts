import { moralisTxsToInternalLegs } from '../moralis-bsc-internal'
import { NATIVE_BNB } from '../bsc-swaps'

const WALLET = '0x38e47FECE3ea323e864c65410F6458c820eAa897'

describe('moralisTxsToInternalLegs', () => {
  it('keeps only inbound internal BNB legs, wei→BNB, lowercased tx', () => {
    const legs = moralisTxsToInternalLegs(WALLET, [
      {
        hash: '0xABCDEF01',
        block_timestamp: '2026-07-01T00:00:00.000Z',
        internal_transactions: [
          { to: WALLET.toLowerCase(), value: '967301007013715773' }, // 0.9673 BNB in
          { to: '0xdeadbeef', value: '5000000000000000000' }, // outbound-ish → dropped
        ],
      },
    ])
    expect(legs).toHaveLength(1)
    expect(legs[0]).toMatchObject({
      token: NATIVE_BNB,
      to: WALLET.toLowerCase(),
      tx: '0xabcdef01',
      ts: '2026-07-01T00:00:00.000Z',
    })
    expect(legs[0].amount).toBeCloseTo(0.9673, 3)
  })

  it('drops zero/garbage values and malformed rows without throwing', () => {
    const legs = moralisTxsToInternalLegs(WALLET, [
      { hash: '0x1', internal_transactions: [{ to: WALLET, value: '0' }] },
      { hash: '0x2', internal_transactions: [{ to: WALLET, value: 'not-a-number' }] },
      { internal_transactions: [{ to: WALLET, value: '1000000000000000000' }] }, // no hash
      null as unknown as Record<string, never>,
    ])
    expect(legs).toHaveLength(0)
  })

  it('address match is case-insensitive (Moralis mixed-case `to`)', () => {
    const legs = moralisTxsToInternalLegs(WALLET.toLowerCase(), [
      {
        hash: '0x3',
        block_timestamp: '2026-07-02T12:00:00.000Z',
        internal_transactions: [{ to: WALLET, value: '442165520362351993' }],
      },
    ])
    expect(legs).toHaveLength(1)
    expect(legs[0].amount).toBeCloseTo(0.4422, 3)
  })
})
