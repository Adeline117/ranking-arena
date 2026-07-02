import { internalRowsToTransfers } from '../dune-bsc-internal'
import { NATIVE_BNB } from '../bsc-swaps'

describe('internalRowsToTransfers', () => {
  it('groups internal BNB rows into NATIVE_BNB in-legs per wallet (0x-keyed)', () => {
    const m = internalRowsToTransfers([
      {
        wallet: 'be6c8068b476af0f70648e33b55600398a73b81c',
        tx_hash: 'aa',
        bnb: 2.5,
        block_time: '2026-06-15 12:00:00.000 UTC',
      },
      {
        wallet: 'be6c8068b476af0f70648e33b55600398a73b81c',
        tx_hash: 'bb',
        bnb: 1.0,
        block_time: '2026-06-16 00:00:00.000 UTC',
      },
      {
        wallet: '3d9a4972111111111111111111111111111111ff',
        tx_hash: 'cc',
        bnb: 5,
        block_time: '2026-06-10 00:00:00.000 UTC',
      },
    ])
    const w1 = m.get('0xbe6c8068b476af0f70648e33b55600398a73b81c')!
    expect(w1).toHaveLength(2)
    expect(w1[0]).toMatchObject({ token: NATIVE_BNB, amount: 2.5, tx: '0xaa' })
    expect(w1[0].to).toBe('0xbe6c8068b476af0f70648e33b55600398a73b81c')
    expect(m.get('0x3d9a4972111111111111111111111111111111ff')).toHaveLength(1)
  })

  it('skips rows with no/zero/invalid bnb or missing fields', () => {
    const m = internalRowsToTransfers([
      { wallet: 'aa', tx_hash: 't', bnb: 0 },
      { wallet: 'aa', tx_hash: 't', bnb: -1 },
      { wallet: 'aa', bnb: 5 }, // no tx_hash
      { tx_hash: 't', bnb: 5 }, // no wallet
    ])
    expect(m.size).toBe(0)
  })

  it('injected in-legs pair with token-out to form a BSC sell', async () => {
    const { decodeTransfersToSwaps, bscQuoteConfig } = await import('../bsc-swaps')
    const { computeWalletPnl } = await import('../pnl-accounting')
    const W = '0xbe6c8068b476af0f70648e33b55600398a73b81c'
    const TOKEN = '0x3333333333333333333333333333333333333333'
    // buy token for 1 BNB, then sell it — proceeds arrive via Dune internal leg.
    const alchemy = [
      {
        token: 'native:bnb',
        from: W,
        to: '0xpool',
        amount: 1,
        tx: '0xbuy',
        ts: '2026-06-01T00:00:00Z',
      },
      {
        token: TOKEN,
        from: '0xpool',
        to: W,
        amount: 1000,
        tx: '0xbuy',
        ts: '2026-06-01T00:00:00Z',
      },
      {
        token: TOKEN,
        from: W,
        to: '0xpool',
        amount: 1000,
        tx: '0xsell',
        ts: '2026-06-05T00:00:00Z',
      },
    ]
    const dune = internalRowsToTransfers([
      {
        wallet: W.replace('0x', ''),
        tx_hash: 'sell',
        bnb: 2,
        block_time: '2026-06-05 00:00:00.000 UTC',
      },
    ]).get(W)!
    const swaps = decodeTransfersToSwaps([...alchemy, ...dune], W, bscQuoteConfig(600))
    const pnl = computeWalletPnl(swaps)
    expect(pnl.txsBuy).toBe(1)
    expect(pnl.txsSell).toBe(1) // the Dune leg completed the sell
    expect(pnl.realizedPnlUsd).toBeCloseTo(600, 0) // sold 2 BNB($1200) − cost 1 BNB($600)
  })
})
