import {
  buildDexGoldenWalletCandidates,
  type DexGoldenWalletQueryRow,
} from '../lib/dex-golden-wallet-query'

function queryRows(): DexGoldenWalletQueryRow[] {
  return [
    {
      source_slug: 'binance_web3_bsc',
      snapshot_id: '101',
      snapshot_scraped_at: '2026-07-16T17:45:00.000Z',
      snapshot_actual_count: 2,
      source_currency: 'USDT',
      entry_currency: 'USDT',
      source_meta_chain_id: null,
      is_derived: false,
      wallet_address: `0x${'1'.repeat(40)}`,
      exchange_trader_id: `0x${'1'.repeat(40)}`,
      source_rank: 1,
      pnl_90d_raw: '100.25',
      activity_json_type: 'number',
      activity_total_raw: '7',
      activity_buy_json_type: 'number',
      activity_buy_raw: '4',
      activity_sell_json_type: 'number',
      activity_sell_raw: '3',
      period_type: null,
      raw_chain_id: null,
    },
    {
      source_slug: 'binance_web3_bsc',
      snapshot_id: '101',
      snapshot_scraped_at: new Date('2026-07-16T17:45:00.000Z'),
      snapshot_actual_count: 2,
      source_currency: 'USDT',
      entry_currency: 'USDT',
      source_meta_chain_id: '56',
      is_derived: false,
      wallet_address: `0x${'2'.repeat(40)}`,
      exchange_trader_id: `0x${'2'.repeat(40)}`,
      source_rank: 2,
      pnl_90d_raw: null,
      activity_json_type: 'number',
      activity_total_raw: '0',
      activity_buy_json_type: 'number',
      activity_buy_raw: '0',
      activity_sell_json_type: 'number',
      activity_sell_raw: '0',
      period_type: null,
      raw_chain_id: null,
    },
    {
      source_slug: 'okx_web3_solana',
      snapshot_id: '202',
      snapshot_scraped_at: '2026-07-16T17:46:00.000Z',
      snapshot_actual_count: 2,
      source_currency: 'USDC',
      entry_currency: 'USDC',
      source_meta_chain_id: null,
      is_derived: false,
      wallet_address: 'A'.repeat(44),
      exchange_trader_id: 'A'.repeat(44),
      source_rank: 1,
      pnl_90d_raw: '50',
      activity_json_type: 'number',
      activity_total_raw: '12',
      activity_buy_json_type: null,
      activity_buy_raw: null,
      activity_sell_json_type: null,
      activity_sell_raw: null,
      period_type: '5',
      raw_chain_id: '501',
    },
    {
      source_slug: 'okx_web3_solana',
      snapshot_id: '202',
      snapshot_scraped_at: '2026-07-16T17:46:00.000Z',
      snapshot_actual_count: 2,
      source_currency: 'USDC',
      entry_currency: 'USDC',
      source_meta_chain_id: '501',
      is_derived: false,
      wallet_address: 'B'.repeat(44),
      exchange_trader_id: 'B'.repeat(44),
      source_rank: 2,
      pnl_90d_raw: '-2.5',
      activity_json_type: 'number',
      activity_total_raw: '3',
      activity_buy_json_type: null,
      activity_buy_raw: null,
      activity_sell_json_type: null,
      activity_sell_raw: null,
      period_type: '5',
      raw_chain_id: '501',
    },
  ]
}

describe('DEX golden-wallet production row contract', () => {
  it('maps exact snapshot rows and excludes only null-PnL candidates', () => {
    const candidates = buildDexGoldenWalletCandidates(queryRows())

    expect(candidates).toHaveLength(3)
    expect(candidates[0]).toMatchObject({
      sourceSlug: 'binance_web3_bsc',
      snapshotId: '101',
      snapshotActualCount: 2,
      sourceRank: 1,
      arenaScore: null,
      pnl90d: '100.25',
      pnlCurrency: 'USDT',
      activityProxyCount: 7,
    })
  })

  it('rejects incomplete snapshots instead of silently shrinking the population', () => {
    expect(() => buildDexGoldenWalletCandidates(queryRows().slice(1))).toThrow(
      /row count does not equal actual_count/
    )
  })

  it('does not confuse post-dedup row count with the upstream positional rank', () => {
    const rows = queryRows()
    rows[1].source_rank = 3

    expect(() => buildDexGoldenWalletCandidates(rows)).not.toThrow()
  })

  it('rejects mixed snapshots, duplicate ranks, and mismatched identities', () => {
    const mixed = queryRows()
    mixed[1].snapshot_id = '999'
    expect(() => buildDexGoldenWalletCandidates(mixed)).toThrow(/one source snapshot/)

    const duplicateRank = queryRows()
    duplicateRank[1].source_rank = 1
    expect(() => buildDexGoldenWalletCandidates(duplicateRank)).toThrow(/duplicate source rank/)

    const mismatchedIdentity = queryRows()
    mismatchedIdentity[0].exchange_trader_id = `0x${'f'.repeat(40)}`
    expect(() => buildDexGoldenWalletCandidates(mismatchedIdentity)).toThrow(
      /does not match exchange trader id/
    )
  })

  it('requires exact, bounded integer activity evidence', () => {
    for (const invalidValue of ['1.5', '-1', '01', '9007199254740992']) {
      const invalid = queryRows()
      invalid[2].activity_total_raw = invalidValue
      expect(() => buildDexGoldenWalletCandidates(invalid)).toThrow(/activity total/)
    }
  })

  it('checks the BSC source-reported total against buy and sell counts', () => {
    const invalid = queryRows()
    invalid[0].activity_total_raw = '8'
    expect(() => buildDexGoldenWalletCandidates(invalid)).toThrow(/buy plus sell/)
  })

  it('rejects source, currency, chain, and raw-window contract drift', () => {
    const wrongCurrency = queryRows()
    wrongCurrency[2].entry_currency = 'USDT'
    expect(() => buildDexGoldenWalletCandidates(wrongCurrency)).toThrow(/PnL currency/)

    const wrongChain = queryRows()
    wrongChain[0].source_meta_chain_id = '1'
    expect(() => buildDexGoldenWalletCandidates(wrongChain)).toThrow(/source chain id conflicts/)

    const derived = queryRows()
    derived[0].is_derived = true
    expect(() => buildDexGoldenWalletCandidates(derived)).toThrow(/must not be derived/)

    const wrongWindow = queryRows()
    wrongWindow[2].period_type = '4'
    expect(() => buildDexGoldenWalletCandidates(wrongWindow)).toThrow(/Solana 90D observation/)
  })
})
