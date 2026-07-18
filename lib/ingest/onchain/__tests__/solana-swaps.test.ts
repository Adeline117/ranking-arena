import {
  decodeSolanaSwap,
  decodeSolanaSwaps,
  WSOL_MINT,
  type SolTxMeta,
  type SolTokenBalance,
} from '../solana-swaps'

const WALLET = 'Wa11etAddre55111111111111111111111111111111'
const TOKEN = 'ToKenMint1111111111111111111111111111111111'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const LPS = 1e9

const bal = (mint: string, owner: string, uiAmount: number): SolTokenBalance => ({
  mint,
  owner,
  uiTokenAmount: { uiAmount },
})

function meta(over: Partial<SolTxMeta>): SolTxMeta {
  return {
    signature: 'sig',
    blockTime: 1_782_000_000,
    fee: 5000,
    walletIndex: 0,
    preSol: 10 * LPS,
    postSol: 10 * LPS,
    preTokenBalances: [],
    postTokenBalances: [],
    ...over,
  }
}

describe('decodeSolanaSwap', () => {
  it('buy: SOL down + token up → buy priced in SOL', () => {
    // wallet spends 2 SOL (10→8, +fee), receives 5000 TOKEN. SOL=$150 → $300.
    const s = decodeSolanaSwap(
      meta({
        preSol: 10 * LPS,
        postSol: 8 * LPS,
        postTokenBalances: [bal(TOKEN, WALLET, 5000)],
      }),
      WALLET,
      150
    )
    expect(s).not.toBeNull()
    expect(s!).toMatchObject({ token: TOKEN, side: 'buy', tokenAmount: 5000 })
    expect(s!.usdValue).toBeCloseTo(2 * 150, 1) // ~$300 (fee negligible)
  })

  it('sell: token down + SOL up → sell', () => {
    const s = decodeSolanaSwap(
      meta({
        preSol: 8 * LPS,
        postSol: 11 * LPS,
        preTokenBalances: [bal(TOKEN, WALLET, 5000)],
        postTokenBalances: [bal(TOKEN, WALLET, 0)],
      }),
      WALLET,
      150
    )
    expect(s).not.toBeNull()
    expect(s!.side).toBe('sell')
    expect(s!.tokenAmount).toBeCloseTo(5000, 6)
    expect(s!.usdValue).toBeCloseTo(3 * 150, 1) // received 3 SOL
  })

  it('prices a USDC-quoted swap ($1 stable) when it dominates the SOL leg', () => {
    // buy token for 250 USDC, SOL only moves by fee.
    const s = decodeSolanaSwap(
      meta({
        preSol: 10 * LPS,
        postSol: 10 * LPS - 5000,
        preTokenBalances: [bal(USDC, WALLET, 250)],
        postTokenBalances: [bal(TOKEN, WALLET, 8000), bal(USDC, WALLET, 0)],
      }),
      WALLET,
      150
    )
    expect(s).not.toBeNull()
    expect(s!.side).toBe('buy')
    expect(s!.usdValue).toBeCloseTo(250, 6)
    expect(s!.token).toBe(TOKEN)
  })

  it('folds wrapped SOL into the native SOL leg', () => {
    // wallet receives token, WSOL balance drops by 2 (paid via WSOL, not native)
    const s = decodeSolanaSwap(
      meta({
        preSol: 10 * LPS,
        postSol: 10 * LPS - 5000, // only fee moves native
        preTokenBalances: [bal(WSOL_MINT, WALLET, 2)],
        postTokenBalances: [bal(TOKEN, WALLET, 9000), bal(WSOL_MINT, WALLET, 0)],
      }),
      WALLET,
      150
    )
    expect(s).not.toBeNull()
    expect(s!.side).toBe('buy')
    expect(s!.usdValue).toBeCloseTo(2 * 150, 1)
  })

  it('returns null for a non-swap (token up but no quote paid)', () => {
    // airdrop: token appears, no SOL/stable moved (only fee)
    const s = decodeSolanaSwap(
      meta({
        preSol: 10 * LPS,
        postSol: 10 * LPS - 5000,
        postTokenBalances: [bal(TOKEN, WALLET, 1000)],
      }),
      WALLET,
      150
    )
    expect(s).toBeNull() // quote leg ~0 (only fee) → not a valued swap
  })

  it('returns null when the wallet is not in the tx', () => {
    expect(decodeSolanaSwap(meta({ walletIndex: -1 }), WALLET, 150)).toBeNull()
  })

  it('batch decode feeds the PnL engine (round-trip profit)', async () => {
    const { computeWalletPnl } = await import('../pnl-accounting')
    const swaps = decodeSolanaSwaps(
      [
        meta({
          signature: 's1',
          blockTime: 1_782_000_000,
          preSol: 10 * LPS,
          postSol: 8 * LPS,
          postTokenBalances: [bal(TOKEN, WALLET, 5000)],
        }),
        meta({
          signature: 's2',
          blockTime: 1_782_100_000,
          preSol: 8 * LPS,
          postSol: 11 * LPS,
          preTokenBalances: [bal(TOKEN, WALLET, 5000)],
          postTokenBalances: [bal(TOKEN, WALLET, 0)],
        }),
      ],
      WALLET,
      150
    )
    expect(swaps).toHaveLength(2)
    const pnl = computeWalletPnl(swaps)
    // bought for ~2 SOL ($300), sold for 3 SOL ($450) → +$150
    expect(pnl.realizedPnlUsd).toBeCloseTo(150, 0)
    expect(pnl.winRate).toBe(100)
  })
})

describe('isQuotaExhausted (provider failover trigger, 2026-07-11 事故)', () => {
  const { isQuotaExhausted } = jest.requireActual('../solana-fetch')
  it('matches Helius quota-dead messages', () => {
    expect(isQuotaExhausted('sol getSignaturesForAddress: max usage reached')).toBe(true)
    expect(isQuotaExhausted('Monthly quota exceeded')).toBe(true)
    expect(isQuotaExhausted('Monthly capacity limit exceeded')).toBe(true)
    expect(isQuotaExhausted('HTTP 402 Payment Required')).toBe(true)
  })
  it('does not match transient throughput errors (those retry same provider)', () => {
    expect(isQuotaExhausted('429 Too Many Requests')).toBe(false)
    expect(isQuotaExhausted('compute unit limit')).toBe(false)
    expect(isQuotaExhausted('fetch failed')).toBe(false)
  })
})
