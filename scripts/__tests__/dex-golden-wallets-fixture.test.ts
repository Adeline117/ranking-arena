import fixtureJson from '../fixtures/dex-golden-wallets.v1.json'
import {
  buildDexGoldenWalletChainSubset,
  dexGoldenWalletChainSubsetSha256,
  dexGoldenWalletSnapshotSha256,
  parseDexGoldenWalletChainSubset,
  parseDexGoldenWalletSnapshot,
} from '../lib/dex-golden-wallets'

const EXPECTED_FIXTURE_SHA256 = '736144afddfb61c3140c4286caf480578345aae1c30f9e65c50341092cf2e5ba'

function mutableFixture(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(fixtureJson)) as Record<string, unknown>
}

describe('DEX golden-wallet production fixture', () => {
  const fixture = parseDexGoldenWalletSnapshot(fixtureJson)

  it('pins the clean generator revision and exact passed source snapshots', () => {
    expect(fixture.generator_git_sha).toBe('b3685a323a20225d07eb653273d6ddd6444d36f1')
    expect(fixture.generated_at).toBe('2026-07-16T17:52:19.510Z')
    expect(fixture.populations).toEqual([
      {
        source_slug: 'binance_web3_bsc',
        snapshot_id: '18904',
        snapshot_scraped_at: '2026-07-16T16:20:27.846Z',
        snapshot_actual_count: 775,
        pnl_currency: 'USDT',
        eligible_candidates_with_non_null_pnl: 775,
        candidates_with_positive_activity_proxy: 775,
      },
      {
        source_slug: 'okx_web3_solana',
        snapshot_id: '18891',
        snapshot_scraped_at: '2026-07-16T15:26:16.352Z',
        snapshot_actual_count: 6733,
        pnl_currency: 'USDC',
        eligible_candidates_with_non_null_pnl: 6733,
        candidates_with_positive_activity_proxy: 6733,
      },
    ])
  })

  it('contains exactly 50 wallets per source with the contracted cohorts', () => {
    expect(fixture.wallets).toHaveLength(100)
    for (const source of ['binance_web3_bsc', 'okx_web3_solana'] as const) {
      const wallets = fixture.wallets.filter((wallet) => wallet.source_slug === source)
      expect(wallets).toHaveLength(50)
      expect(wallets.filter((wallet) => wallet.cohort === 'top')).toHaveLength(20)
      expect(wallets.filter((wallet) => wallet.cohort === 'deterministic_random')).toHaveLength(20)
      expect(wallets.filter((wallet) => wallet.cohort === 'high_frequency')).toHaveLength(10)
    }
  })

  it('keeps every authorization closed and every score unavailable', () => {
    expect(fixture).toMatchObject({
      purpose: 'phase0_shadow_sampling_only',
      serving_authorized: false,
      rank_eligible: false,
      score_eligible: false,
    })
    expect(fixture.wallets.every((wallet) => wallet.arena_score === null)).toBe(true)
    expect(fixture.wallets.every((wallet) => typeof wallet.pnl_90d === 'string')).toBe(true)
  })

  it('has no profile identity fields and has a pinned canonical hash', () => {
    const allowedWalletFields = [
      'activity_proxy_count',
      'arena_score',
      'chain',
      'cohort',
      'pnl_90d',
      'pnl_currency',
      'source_rank',
      'source_slug',
      'source_snapshot_id',
      'source_snapshot_scraped_at',
      'wallet',
    ]
    expect(Object.keys(fixture.wallets[0]).sort()).toEqual(allowedWalletFields)
    expect(dexGoldenWalletSnapshotSha256(fixtureJson)).toBe(EXPECTED_FIXTURE_SHA256)
  })

  it('derives exact chain subsets that remain bound to the parent artifact', () => {
    const expectedSubsetHashes = {
      binance_web3_bsc: 'dcce3efd3ffd1afa47b832acd623e1455ad2150560f19d11941659aa152cc04d',
      okx_web3_solana: 'a5e81512feb7ac47dd063f023eeb9ac2f085d6abf259ed03fd092074816933ab',
    } as const
    for (const source of Object.keys(expectedSubsetHashes) as Array<
      keyof typeof expectedSubsetHashes
    >) {
      const { subset, sha256 } = buildDexGoldenWalletChainSubset(fixtureJson, source)
      expect(subset.parent_snapshot_sha256).toBe(EXPECTED_FIXTURE_SHA256)
      expect(subset.source_slug).toBe(source)
      expect(subset.wallet_count).toBe(50)
      expect(subset.wallets).toHaveLength(50)
      expect(sha256).toBe(expectedSubsetHashes[source])
      expect(parseDexGoldenWalletChainSubset(subset)).toEqual(subset)
      expect(dexGoldenWalletChainSubsetSha256(subset)).toBe(expectedSubsetHashes[source])
    }
  })

  it('rejects a chain subset with a foreign, duplicate, or reordered wallet', () => {
    const { subset } = buildDexGoldenWalletChainSubset(fixtureJson, 'binance_web3_bsc')

    const foreign = JSON.parse(JSON.stringify(subset)) as typeof subset
    foreign.wallets[0].source_slug = 'okx_web3_solana'
    expect(() => parseDexGoldenWalletChainSubset(foreign)).toThrow(/foreign source wallet/)

    const duplicate = JSON.parse(JSON.stringify(subset)) as typeof subset
    duplicate.wallets[1].wallet = duplicate.wallets[0].wallet
    expect(() => parseDexGoldenWalletChainSubset(duplicate)).toThrow(/wallet identity/)

    const reordered = JSON.parse(JSON.stringify(subset)) as typeof subset
    ;[reordered.wallets[0], reordered.wallets[1]] = [reordered.wallets[1], reordered.wallets[0]]
    expect(() => parseDexGoldenWalletChainSubset(reordered)).toThrow(/canonical cohort\/wallet/)
  })

  it('fails closed on authorization, unknown fields, or duplicate wallets', () => {
    const authorized = mutableFixture()
    authorized.score_eligible = true
    expect(() => parseDexGoldenWalletSnapshot(authorized)).toThrow()

    const unknownField = mutableFixture()
    unknownField.nickname = 'not allowed'
    expect(() => parseDexGoldenWalletSnapshot(unknownField)).toThrow()

    const duplicate = mutableFixture()
    const wallets = duplicate.wallets as Array<Record<string, unknown>>
    wallets[1].wallet = wallets[0].wallet
    expect(() => parseDexGoldenWalletSnapshot(duplicate)).toThrow(/duplicate global wallet/)
  })
})
