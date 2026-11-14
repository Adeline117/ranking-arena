const mockQuery = jest.fn()

jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: () => ({ query: (...args: unknown[]) => mockQuery(...args) }),
}))

jest.mock('@/lib/ingest/onchain/enrich', () => ({
  chainForSource: (slug: string) => (slug.includes('solana') ? 'solana' : 'bsc'),
  enrichWeb3Wallet: jest.fn(),
  enrichmentExtras: jest.fn(),
  onchainFetchBudget: jest.fn(() => ({})),
  scoreEligibleWinRate: jest.fn(() => null),
}))

jest.mock('@/lib/ingest/onchain/dune-bsc-internal', () => ({
  scanBscInternalBnb: jest.fn(),
}))

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import { processOnchainEnrich } from '../onchain-enrich'

describe('on-chain enrichment legacy quality selection', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('prioritizes missing or stale quality schema in both HOT and TAIL queries', async () => {
    await processOnchainEnrich({} as never)

    expect(mockQuery).toHaveBeenCalledTimes(4)
    for (const [sql, params] of mockQuery.mock.calls) {
      expect(String(sql)).toContain("ts.extras #>> '{onchain_quality,schema_version}'")
      expect(String(sql)).toContain("ts.extras #>> '{onchain_quality,methodology}'")
      expect(String(sql)).toContain("ts.extras #>> '{onchain_quality,methodology_version}'")
      expect(String(sql)).toContain('IS DISTINCT FROM')
      expect(params.slice(-3)).toEqual(['1', 'wallet-balance-delta-average-cost', '1.0.0'])
    }

    const hotSql = String(mockQuery.mock.calls[0][0])
    const tailSql = String(mockQuery.mock.calls[1][0])
    expect(hotSql).toContain('IS DISTINCT FROM $4')
    expect(hotSql).toContain('IS DISTINCT FROM $6')
    expect(hotSql.lastIndexOf('IS DISTINCT FROM $4')).toBeLessThan(hotSql.indexOf('ts.pnl DESC'))
    expect(tailSql).toContain('IS DISTINCT FROM $3')
    expect(tailSql).toContain('IS DISTINCT FROM $5')
    expect(tailSql.lastIndexOf('IS DISTINCT FROM $3')).toBeLessThan(
      tailSql.indexOf("ts.extras ? 'onchain_enriched_at'")
    )
  })

  it('keeps chain-derived win rate in extras and never fills the formal column for web3 boards', async () => {
    const enrich = jest.requireMock('@/lib/ingest/onchain/enrich') as Record<string, jest.Mock>
    enrich.enrichWeb3Wallet.mockResolvedValue({ winRate: 55 })
    enrich.enrichmentExtras.mockReturnValue({ onchain_win_rate: 55 })
    enrich.scoreEligibleWinRate.mockReturnValue(55)
    const dune = jest.requireMock('@/lib/ingest/onchain/dune-bsc-internal') as Record<
      string,
      jest.Mock
    >
    dune.scanBscInternalBnb.mockResolvedValue({
      transfersByWallet: new Map(),
      coverage: {
        scanComplete: true,
        stopReason: 'done',
        rowsFetched: 0,
        pagesFetched: 0,
        walletsRequested: 1,
      },
    })
    mockQuery.mockImplementation(async (sql: string) =>
      String(sql).startsWith('UPDATE')
        ? { rows: [], rowCount: 1 }
        : { rows: [{ wallet: 'w1' }], rowCount: 1 }
    )

    await expect(processOnchainEnrich({} as never)).resolves.toEqual({ enriched: 2, failed: 0 })

    const updates = mockQuery.mock.calls.filter(([sql]) => String(sql).startsWith('UPDATE'))
    expect(updates).toHaveLength(2)
    for (const [, params] of updates) {
      expect(JSON.parse(params[2])).toMatchObject({ onchain_win_rate: 55 })
      expect(params[3]).toBeNull()
    }
  })
})
