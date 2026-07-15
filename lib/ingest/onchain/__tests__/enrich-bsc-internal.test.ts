const mockComputeBsc = jest.fn()
const mockScanMoralis = jest.fn()
const mockFetchTokenInfo = jest.fn()
const mockUnrealized = jest.fn()

jest.mock('../bsc-fetch', () => ({
  computeBscWalletOnchain: (...args: unknown[]) => mockComputeBsc(...args),
}))
jest.mock('../moralis-bsc-internal', () => ({
  scanMoralisInternalBnb: (...args: unknown[]) => mockScanMoralis(...args),
}))
jest.mock('../token-prices', () => ({
  fetchTokenInfo: (...args: unknown[]) => mockFetchTokenInfo(...args),
  unrealizedFromHoldings: (...args: unknown[]) => mockUnrealized(...args),
}))

import { enrichWeb3Wallet } from '../enrich'
import type { NormalizedTransfer } from '../bsc-swaps'

const WALLET = '0xabc'
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
          perToken: [],
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
