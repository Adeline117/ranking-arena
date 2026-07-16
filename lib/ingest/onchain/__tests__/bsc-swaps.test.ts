import {
  decodeBscSwaps,
  decodeTransfersToSwaps,
  bscQuoteConfig,
  TRANSFER_TOPIC,
  type NormalizedTransfer,
  type RawLog,
} from '../bsc-swaps'

const WALLET = '0x1111111111111111111111111111111111111111'
const POOL = '0x2222222222222222222222222222222222222222'
const TOKEN = '0x3333333333333333333333333333333333333333'
const USDT = '0x55d398326f99059ff775485246999027b3197955'
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'

const addrTopic = (a: string) => '0x' + '0'.repeat(24) + a.toLowerCase().replace(/^0x/, '')
const hex = (n: bigint) => '0x' + n.toString(16)
const usdt = (n: number) => hex(BigInt(n) * 10n ** 18n) // n USDT (18 dec on BSC)

let logIdx = 0
function transfer(
  token: string,
  from: string,
  to: string,
  amountHex: string,
  block = 100,
  tx = 'auto'
): RawLog {
  logIdx += 1
  return {
    address: token,
    topics: [TRANSFER_TOPIC, addrTopic(from), addrTopic(to)],
    data: amountHex,
    transactionHash: tx === 'auto' ? `0xtx${logIdx}` : tx,
    blockNumber: '0x' + block.toString(16),
    logIndex: '0x' + logIdx.toString(16),
  }
}

const cfg = bscQuoteConfig(600) // BNB = $600

describe('decodeBscSwaps', () => {
  it('buy: wallet sends USDT, receives token → buy priced at quote USD', () => {
    const swaps = decodeBscSwaps(
      [
        transfer(USDT, WALLET, POOL, usdt(100), 100, '0xA'),
        transfer(TOKEN, POOL, WALLET, hex(5000n), 100, '0xA'),
      ],
      WALLET,
      cfg
    )
    expect(swaps).toHaveLength(1)
    expect(swaps[0]).toMatchObject({ token: TOKEN, side: 'buy', tokenAmount: 5000, usdValue: 100 })
  })

  it('sell: wallet sends token, receives USDT → sell', () => {
    const swaps = decodeBscSwaps(
      [
        transfer(TOKEN, WALLET, POOL, hex(5000n), 200, '0xB'),
        transfer(USDT, POOL, WALLET, usdt(150), 200, '0xB'),
      ],
      WALLET,
      cfg
    )
    expect(swaps).toHaveLength(1)
    expect(swaps[0]).toMatchObject({ token: TOKEN, side: 'sell', tokenAmount: 5000, usdValue: 150 })
  })

  it('prices a WBNB quote leg using the BNB/USD factor', () => {
    // wallet sends 0.5 WBNB, receives token → buy = 0.5 × $600 = $300
    const swaps = decodeBscSwaps(
      [
        transfer(WBNB, WALLET, POOL, hex(5n * 10n ** 17n), 300, '0xC'), // 0.5 WBNB
        transfer(TOKEN, POOL, WALLET, hex(9000n), 300, '0xC'),
      ],
      WALLET,
      cfg
    )
    expect(swaps).toHaveLength(1)
    expect(swaps[0].side).toBe('buy')
    expect(swaps[0].usdValue).toBeCloseTo(300, 6)
  })

  it.each([
    {
      name: 'incoming airdrop and incoming quote refund',
      quoteFrom: POOL,
      quoteTo: WALLET,
      tokenFrom: POOL,
      tokenTo: WALLET,
    },
    {
      name: 'outgoing token and outgoing quote transfer',
      quoteFrom: WALLET,
      quoteTo: POOL,
      tokenFrom: WALLET,
      tokenTo: POOL,
    },
  ])('skips same-direction legs: $name', ({ quoteFrom, quoteTo, tokenFrom, tokenTo }) => {
    const swaps = decodeBscSwaps(
      [
        transfer(USDT, quoteFrom, quoteTo, usdt(100), 350, '0xSAME'),
        transfer(TOKEN, tokenFrom, tokenTo, hex(5000n), 350, '0xSAME'),
      ],
      WALLET,
      cfg
    )

    expect(swaps).toHaveLength(0)
  })

  it('uses opposing largest legs in a multi-leg buy with dust refund transfers', () => {
    const swaps = decodeBscSwaps(
      [
        transfer(USDT, WALLET, POOL, usdt(100), 375, '0xMULTI'),
        transfer(USDT, POOL, WALLET, usdt(1), 375, '0xMULTI'),
        transfer(TOKEN, POOL, WALLET, hex(5000n), 375, '0xMULTI'),
        transfer(TOKEN, WALLET, POOL, hex(5n), 375, '0xMULTI'),
      ],
      WALLET,
      cfg
    )

    expect(swaps).toEqual([
      expect.objectContaining({ token: TOKEN, side: 'buy', tokenAmount: 5000, usdValue: 100 }),
    ])
  })

  it('ignores transfers not involving the wallet', () => {
    const swaps = decodeBscSwaps(
      [
        transfer(USDT, POOL, POOL, usdt(100), 100, '0xD'),
        transfer(TOKEN, POOL, POOL, hex(5000n), 100, '0xD'),
      ],
      WALLET,
      cfg
    )
    expect(swaps).toHaveLength(0)
  })

  it('skips txs with no quote leg (unvaluable)', () => {
    // token↔token swap, no stable/WBNB leg → cannot value → skip
    const OTHER = '0x4444444444444444444444444444444444444444'
    const swaps = decodeBscSwaps(
      [
        transfer(OTHER, WALLET, POOL, hex(10n), 100, '0xE'),
        transfer(TOKEN, POOL, WALLET, hex(20n), 100, '0xE'),
      ],
      WALLET,
      cfg
    )
    // Neither is a known quote → both are "token" legs, no quote → skipped.
    expect(swaps).toHaveLength(0)
  })

  it('uses supplied block timestamps for ts, else a sortable fallback', () => {
    const withTs = decodeBscSwaps(
      [
        transfer(USDT, WALLET, POOL, usdt(100), 500, '0xF'),
        transfer(TOKEN, POOL, WALLET, hex(5000n), 500, '0xF'),
      ],
      WALLET,
      cfg,
      { ['0x' + (500).toString(16)]: '2026-06-15T12:00:00Z' }
    )
    expect(withTs[0].ts).toBe('2026-06-15T12:00:00Z')

    const noTs = decodeBscSwaps(
      [
        transfer(USDT, WALLET, POOL, usdt(100), 500, '0xG'),
        transfer(TOKEN, POOL, WALLET, hex(5000n), 500, '0xG'),
      ],
      WALLET,
      cfg
    )
    expect(noTs[0].ts).toMatch(/^block-0*500$/)
  })

  it('end-to-end: decoded swaps feed the PnL engine correctly', async () => {
    const { computeWalletPnl } = await import('../pnl-accounting')
    const swaps = decodeBscSwaps(
      [
        transfer(USDT, WALLET, POOL, usdt(100), 100, '0xBUY'),
        transfer(TOKEN, POOL, WALLET, hex(5000n), 100, '0xBUY'),
        transfer(TOKEN, WALLET, POOL, hex(5000n), 200, '0xSELL'),
        transfer(USDT, POOL, WALLET, usdt(180), 200, '0xSELL'),
      ],
      WALLET,
      cfg
    )
    const pnl = computeWalletPnl(swaps)
    expect(pnl.realizedPnlUsd).toBeCloseTo(80, 6) // 180 − 100
    expect(pnl.winRate).toBe(100)
    expect(pnl.closedPositions).toBe(1)
  })
})

describe('decodeTransfersToSwaps', () => {
  const normalized = (
    token: string,
    from: string,
    to: string,
    amount: number,
    tx: string
  ): NormalizedTransfer => ({
    token,
    from,
    to,
    amount,
    tx,
    ts: '2026-06-15T12:00:00Z',
  })

  it.each([
    {
      name: 'buy',
      legs: [
        normalized(USDT, WALLET, POOL, 100, '0xBUY'),
        normalized(TOKEN, POOL, WALLET, 5000, '0xBUY'),
      ],
      side: 'buy',
      usdValue: 100,
    },
    {
      name: 'sell',
      legs: [
        normalized(TOKEN, WALLET, POOL, 5000, '0xSELL'),
        normalized(USDT, POOL, WALLET, 150, '0xSELL'),
      ],
      side: 'sell',
      usdValue: 150,
    },
  ] as const)('decodes a normal $name with opposing legs', ({ legs, side, usdValue }) => {
    expect(decodeTransfersToSwaps([...legs], WALLET, cfg)).toEqual([
      expect.objectContaining({ token: TOKEN, side, tokenAmount: 5000, usdValue }),
    ])
  })

  it.each([
    {
      name: 'incoming airdrop and incoming quote refund',
      legs: [
        normalized(USDT, POOL, WALLET, 100, '0xIN'),
        normalized(TOKEN, POOL, WALLET, 5000, '0xIN'),
      ],
    },
    {
      name: 'outgoing token and outgoing quote transfer',
      legs: [
        normalized(USDT, WALLET, POOL, 100, '0xOUT'),
        normalized(TOKEN, WALLET, POOL, 5000, '0xOUT'),
      ],
    },
  ] as const)('skips same-direction normalized legs: $name', ({ legs }) => {
    expect(decodeTransfersToSwaps([...legs], WALLET, cfg)).toHaveLength(0)
  })

  it('uses opposing largest normalized legs across a multi-leg refund boundary', () => {
    const swaps = decodeTransfersToSwaps(
      [
        normalized(USDT, WALLET, POOL, 100, '0xMULTI'),
        normalized(USDT, POOL, WALLET, 1, '0xMULTI'),
        normalized(TOKEN, POOL, WALLET, 5000, '0xMULTI'),
        normalized(TOKEN, WALLET, POOL, 5, '0xMULTI'),
      ],
      WALLET,
      cfg
    )

    expect(swaps).toEqual([
      expect.objectContaining({ token: TOKEN, side: 'buy', tokenAmount: 5000, usdValue: 100 }),
    ])
  })
})
