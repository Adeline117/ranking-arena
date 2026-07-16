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
})
