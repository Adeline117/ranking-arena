const mockComputeBsc = jest.fn()
const mockComputeSolana = jest.fn()
const mockScanMoralis = jest.fn()
const mockFetchTokenInfo = jest.fn()
const mockUnrealized = jest.fn()

jest.mock('../bsc-fetch', () => ({
  computeBscWalletOnchain: (...args: unknown[]) => mockComputeBsc(...args),
}))
jest.mock('../solana-fetch', () => ({
  computeSolanaWalletOnchain: (...args: unknown[]) => mockComputeSolana(...args),
}))
jest.mock('../moralis-bsc-internal', () => ({
  scanMoralisInternalBnb: (...args: unknown[]) => mockScanMoralis(...args),
}))
jest.mock('../token-prices', () => ({
  fetchTokenInfo: (...args: unknown[]) => mockFetchTokenInfo(...args),
  unrealizedFromHoldings: (...args: unknown[]) => mockUnrealized(...args),
  tokenAddressKey: (address: string, chain: 'bsc' | 'solana') =>
    chain === 'solana' ? address.trim() : address.trim().toLowerCase(),
}))

import { enrichWeb3Wallet } from '../enrich'
import type { NormalizedTransfer } from '../bsc-swaps'

const WALLET = '0xabc'
const SOL_MINT = 'ToKenMint1111111111111111111111111111111111'
const INTERNAL_LEG: NormalizedTransfer = {
  token: 'native:bnb',
  from: '0xrouter',
  to: WALLET,
  amount: 1,
  tx: '0xtx',
  ts: '2026-07-01T00:00:00.000Z',
}

const COMPLETE_BASE_COVERAGE = {
  fromAddress: {
    scanComplete: true,
    truncated: false,
    stopReason: 'history_exhausted' as const,
    pagesFetched: 1,
    recordsSeen: 0,
    recordsReturned: 0,
    recordsMissingTimestamp: 0,
  },
  toAddress: {
    scanComplete: true,
    truncated: false,
    stopReason: 'history_exhausted' as const,
    pagesFetched: 1,
    recordsSeen: 0,
    recordsReturned: 0,
    recordsMissingTimestamp: 0,
  },
  scanComplete: true,
  truncated: false,
}

describe('enrichWeb3Wallet BSC internal-transfer coverage', () => {
  const originalKey = process.env.MORALIS_API_KEY

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.MORALIS_API_KEY = 'test-key'
    mockComputeBsc.mockImplementation(
      async (_wallet: string, opts: { extraTransfers?: NormalizedTransfer[] }) => ({
        wallet: WALLET,
        lookbackDays: 90,
        transfers: opts.extraTransfers?.length ?? 0,
        swaps: 0,
        bnbUsd: 600,
        transferCoverage: COMPLETE_BASE_COVERAGE,
        pnl: {
          realizedPnlUsd: 0,
          dailyRealized: [],
          buyVolumeUsd: 0,
          sellVolumeUsd: 0,
          totalVolumeUsd: 0,
          txsBuy: 0,
          txsSell: 0,
          tokensTraded: 0,
          closedPositions: 0,
          winningPositions: 0,
          winRate: null,
          perToken: [
            {
              token: '0xAaBb',
              realizedPnlUsd: 0,
              holding: 1,
              costBasisUsd: 1,
              buyVolumeUsd: 1,
              sellVolumeUsd: 0,
              swaps: 1,
              closedPositions: 0,
              winningPositions: 0,
            },
          ],
        },
      })
    )
    mockFetchTokenInfo.mockResolvedValue(new Map())
    mockUnrealized.mockReturnValue({
      unrealizedUsd: 0,
      pricedTokens: 0,
      unpricedTokens: 0,
      heldValueUsd: 0,
    })
  })

  afterEach(() => {
    if (originalKey === undefined) delete process.env.MORALIS_API_KEY
    else process.env.MORALIS_API_KEY = originalKey
  })

  it('promotes a cursor-exhausted Moralis zero result and forwards the page budget', async () => {
    mockScanMoralis.mockResolvedValue({
      transfers: [],
      coverage: { scanComplete: true },
    })

    const result = await enrichWeb3Wallet('bsc', WALLET, { lookbackDays: 90, maxPages: 1 })

    expect(mockScanMoralis).toHaveBeenCalledWith(WALLET, { lookbackDays: 90, maxPages: 1 })
    expect(mockComputeBsc).toHaveBeenCalledWith(
      WALLET,
      expect.objectContaining({ maxPages: 1, extraTransfers: [] })
    )
    expect(mockFetchTokenInfo).toHaveBeenCalledWith(['0xAaBb'], { chain: 'bsc' })
    expect(mockUnrealized).toHaveBeenCalledWith(expect.any(Array), new Map(), 'bsc')
    expect(result.realizedPartial).toBe(false)
    expect(result.quality.history.scanComplete).toBe(true)
    expect(result.quality.reasons).not.toContain('internal_transfer_coverage_unknown')
  })

  it('uses partial Moralis legs without claiming complete internal history', async () => {
    mockScanMoralis.mockResolvedValue({
      transfers: [INTERNAL_LEG],
      coverage: { scanComplete: false },
    })

    const result = await enrichWeb3Wallet('bsc', WALLET, { maxPages: 4 })

    expect(mockComputeBsc).toHaveBeenCalledWith(
      WALLET,
      expect.objectContaining({ extraTransfers: [INTERNAL_LEG] })
    )
    expect(result.realizedPartial).toBe(true)
    expect(result.quality.history.scanComplete).toBe(false)
    expect(result.quality.reasons).toContain('internal_transfer_coverage_unknown')
  })

  it('accepts an explicitly complete caller-supplied zero result without Moralis', async () => {
    const result = await enrichWeb3Wallet('bsc', WALLET, {
      bscInternalBnb: [],
      bscInternalCoverageComplete: true,
    })

    expect(mockScanMoralis).not.toHaveBeenCalled()
    expect(result.realizedPartial).toBe(false)
    expect(result.quality.history.scanComplete).toBe(true)
  })

  it('does not infer coverage from caller-supplied records alone', async () => {
    const result = await enrichWeb3Wallet('bsc', WALLET, {
      bscInternalBnb: [INTERNAL_LEG],
    })

    expect(mockScanMoralis).not.toHaveBeenCalled()
    expect(result.realizedPartial).toBe(true)
    expect(result.quality.history.scanComplete).toBe(false)
  })
})

describe('enrichWeb3Wallet chain-specific token pricing', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockComputeSolana.mockResolvedValue({
      wallet: 'SolanaWallet1111111111111111111111111111111',
      lookbackDays: 90,
      signatures: 2,
      txsFetched: 2,
      swaps: 2,
      solUsd: 150,
      signatureCoverage: {
        scanComplete: true,
        truncated: false,
        stopReason: 'history_exhausted',
        pagesFetched: 1,
        recordsSeen: 2,
        recordsReturned: 2,
        recordsMissingTimestamp: 0,
      },
      txsUnresolved: 0,
      txsMissingTimestamp: 0,
      pnl: {
        realizedPnlUsd: 25,
        dailyRealized: [{ ts: '2026-07-01', value: 25 }],
        buyVolumeUsd: 100,
        sellVolumeUsd: 125,
        totalVolumeUsd: 225,
        txsBuy: 1,
        txsSell: 1,
        tokensTraded: 1,
        closedPositions: 0,
        winningPositions: 0,
        winRate: null,
        perToken: [
          {
            token: SOL_MINT,
            realizedPnlUsd: 25,
            holding: 10,
            costBasisUsd: 50,
            buyVolumeUsd: 100,
            sellVolumeUsd: 125,
            swaps: 2,
            closedPositions: 0,
            winningPositions: 0,
          },
        ],
      },
    })
    mockFetchTokenInfo.mockResolvedValue(
      new Map([[SOL_MINT, { priceUsd: 7, symbol: 'EXACT', logo: 'https://cdn.example/exact.png' }]])
    )
    mockUnrealized.mockReturnValue({
      unrealizedUsd: 20,
      pricedTokens: 1,
      unpricedTokens: 0,
      heldValueUsd: 70,
    })
  })

  it('passes the exact Solana mint and uses it for top-token metadata', async () => {
    const result = await enrichWeb3Wallet('solana', 'SolanaWallet1111111111111111111111111111111')

    expect(mockFetchTokenInfo).toHaveBeenCalledWith([SOL_MINT], { chain: 'solana' })
    expect(mockUnrealized).toHaveBeenCalledWith(
      expect.any(Array),
      new Map([[SOL_MINT, 7]]),
      'solana'
    )
    expect(result.topEarningTokens).toEqual([
      {
        symbol: 'EXACT',
        address: SOL_MINT,
        logo: 'https://cdn.example/exact.png',
        realized_pnl: 25,
      },
    ])
  })
})
