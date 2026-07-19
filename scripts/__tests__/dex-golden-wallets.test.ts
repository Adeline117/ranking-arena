import {
  buildDexGoldenWalletSnapshot,
  compareDexGoldenText,
  compareDexGoldenWalletIdentity,
  dexGoldenWalletSnapshotSha256,
  type DexGoldenSource,
  type DexGoldenWalletCandidate,
} from '../lib/dex-golden-wallets'

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function solanaWallet(index: number): string {
  return `${'A'.repeat(42)}${BASE58[Math.floor(index / BASE58.length)]}${BASE58[index % BASE58.length]}`
}

function candidates(): DexGoldenWalletCandidate[] {
  const out: DexGoldenWalletCandidate[] = []
  const sources: DexGoldenSource[] = ['binance_web3_bsc', 'okx_web3_solana']
  for (const sourceSlug of sources) {
    for (let index = 0; index < 70; index += 1) {
      out.push({
        sourceSlug,
        wallet:
          sourceSlug === 'binance_web3_bsc'
            ? `0x${(index + 1).toString(16).padStart(40, '0')}`
            : solanaWallet(index),
        snapshotId: sourceSlug === 'binance_web3_bsc' ? '101' : '202',
        snapshotScrapedAt: '2026-07-16T17:45:00.000Z',
        snapshotActualCount: 70,
        sourceRank: index + 1,
        arenaScore: null,
        pnl90d: String(10_000 - index),
        pnlCurrency: sourceSlug === 'binance_web3_bsc' ? 'USDT' : 'USDC',
        activityProxyCount: index + 1,
      })
    }
  }
  return out
}

const METADATA = {
  generatedAt: '2026-07-16T18:30:00.000Z',
  generatorGitSha: '0123456789abcdef0123456789abcdef01234567',
  sampleSeed: 'arena-dex-golden-wallets-v1-2026-07-16',
}

describe('DEX golden-wallet selection contract', () => {
  it('uses a fixed raw-code-unit order instead of host locale collation', () => {
    expect(compareDexGoldenText('B', 'a')).toBeLessThan(0)
    expect(compareDexGoldenWalletIdentity('a', 'B')).toBeLessThan(0)
    expect(compareDexGoldenWalletIdentity('A', 'a')).toBeLessThan(0)
  })

  it('selects 20 top, 20 deterministic-random, and 10 high-frequency wallets per chain', () => {
    const { snapshot } = buildDexGoldenWalletSnapshot({ candidates: candidates(), ...METADATA })

    expect(snapshot.wallets).toHaveLength(100)
    expect(new Set(snapshot.wallets.map((wallet) => wallet.wallet)).size).toBe(100)
    for (const source of ['binance_web3_bsc', 'okx_web3_solana'] as const) {
      const sourceWallets = snapshot.wallets.filter((wallet) => wallet.source_slug === source)
      expect(sourceWallets.filter((wallet) => wallet.cohort === 'top')).toHaveLength(20)
      expect(
        sourceWallets.filter((wallet) => wallet.cohort === 'deterministic_random')
      ).toHaveLength(20)
      expect(sourceWallets.filter((wallet) => wallet.cohort === 'high_frequency')).toHaveLength(10)
    }
    expect(snapshot.serving_authorized).toBe(false)
    expect(snapshot.rank_eligible).toBe(false)
    expect(snapshot.score_eligible).toBe(false)
    expect(snapshot.candidate_timeframe_days).toBe(90)
    expect(snapshot.planned_hit_window_days).toBe(7)
    expect(snapshot.selection).toMatchObject({
      snapshot_gate: 'latest_count_check_passed_snapshot',
      snapshot_freshness_max_hours: 24,
      candidate_eligibility: 'snapshot_membership_and_non_null_headline_pnl',
      source_rank_field: 'arena.leaderboard_entries.rank',
      pnl_90d_field: 'arena.leaderboard_entries.headline_pnl',
      activity_fields: {
        binance_web3_bsc: 'arena.leaderboard_entries.raw.totalTxCnt',
        okx_web3_solana: 'arena.leaderboard_entries.raw.tx',
      },
    })
    expect(snapshot.populations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source_slug: 'binance_web3_bsc', pnl_currency: 'USDT' }),
        expect.objectContaining({ source_slug: 'okx_web3_solana', pnl_currency: 'USDC' }),
      ])
    )
  })

  it('is invariant to candidate input order and emits a deterministic hash', () => {
    const ordered = buildDexGoldenWalletSnapshot({ candidates: candidates(), ...METADATA })
    const reversed = buildDexGoldenWalletSnapshot({
      candidates: candidates().reverse(),
      ...METADATA,
    })

    expect(reversed).toEqual(ordered)
    expect(ordered.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(ordered.sha256).toBe(dexGoldenWalletSnapshotSha256(ordered.snapshot))
  })

  it('reserves the highest non-top activity proxies for the high-frequency cohort', () => {
    const { snapshot } = buildDexGoldenWalletSnapshot({ candidates: candidates(), ...METADATA })

    for (const source of ['binance_web3_bsc', 'okx_web3_solana'] as const) {
      const activity = snapshot.wallets
        .filter((wallet) => wallet.source_slug === source && wallet.cohort === 'high_frequency')
        .map((wallet) => wallet.activity_proxy_count)
        .sort((a, b) => b - a)
      expect(activity).toEqual([70, 69, 68, 67, 66, 65, 64, 63, 62, 61])
    }
  })

  it('preserves an upstream positional rank beyond the post-dedup snapshot row count', () => {
    const input = candidates()
    const candidate = input.find(
      (item) => item.sourceSlug === 'okx_web3_solana' && item.sourceRank === 70
    )!
    candidate.sourceRank = 71

    const built = buildDexGoldenWalletSnapshot({ candidates: input, ...METADATA })
    expect(
      built.snapshot.wallets.find(
        (wallet) =>
          wallet.source_slug === 'okx_web3_solana' &&
          wallet.wallet === candidate.wallet &&
          wallet.source_rank === 71
      )
    ).toBeDefined()
    expect(dexGoldenWalletSnapshotSha256(built.snapshot)).toBe(built.sha256)
  })

  it('canonicalizes BSC addresses without changing Solana case', () => {
    const input = candidates()
    input[0].wallet = input[0].wallet.toUpperCase().replace('0X', '0x')
    const { snapshot } = buildDexGoldenWalletSnapshot({ candidates: input, ...METADATA })

    expect(
      snapshot.wallets.find((wallet) => wallet.source_slug === 'binance_web3_bsc')!.wallet
    ).toBe(
      snapshot.wallets
        .find((wallet) => wallet.source_slug === 'binance_web3_bsc')!
        .wallet.toLowerCase()
    )
    expect(
      snapshot.wallets.find((wallet) => wallet.source_slug === 'okx_web3_solana')!.wallet
    ).toMatch(/[A-Z]/)
  })

  it('rejects invalid, duplicate, or insufficient candidate sets', () => {
    const invalid = candidates()
    invalid[0].wallet = 'not-a-wallet'
    expect(() => buildDexGoldenWalletSnapshot({ candidates: invalid, ...METADATA })).toThrow(
      /invalid binance_web3_bsc wallet/
    )

    const wrongSolanaByteLength = candidates()
    wrongSolanaByteLength.find((candidate) => candidate.sourceSlug === 'okx_web3_solana')!.wallet =
      'A'.repeat(32)
    expect(() =>
      buildDexGoldenWalletSnapshot({ candidates: wrongSolanaByteLength, ...METADATA })
    ).toThrow(/invalid okx_web3_solana wallet/)

    const duplicate = candidates()
    duplicate[1].wallet = duplicate[0].wallet
    expect(() => buildDexGoldenWalletSnapshot({ candidates: duplicate, ...METADATA })).toThrow(
      /duplicate golden-wallet candidate/
    )

    const duplicateRank = candidates()
    duplicateRank[1].sourceRank = duplicateRank[0].sourceRank
    expect(() => buildDexGoldenWalletSnapshot({ candidates: duplicateRank, ...METADATA })).toThrow(
      /duplicate source rank/
    )

    expect(() =>
      buildDexGoldenWalletSnapshot({ candidates: candidates().slice(0, 49), ...METADATA })
    ).toThrow(/at least 50/)
  })

  it('requires canonical provenance metadata and bounded activity counts', () => {
    expect(() =>
      buildDexGoldenWalletSnapshot({
        candidates: candidates(),
        ...METADATA,
        generatedAt: '2026-07-16',
      })
    ).toThrow(/generatedAt/)

    const invalidActivity = candidates()
    invalidActivity[0].activityProxyCount = -1
    expect(() =>
      buildDexGoldenWalletSnapshot({ candidates: invalidActivity, ...METADATA })
    ).toThrow(/activityProxyCount/)

    const invalidPnl = candidates()
    invalidPnl[0].pnl90d = '1e3'
    expect(() => buildDexGoldenWalletSnapshot({ candidates: invalidPnl, ...METADATA })).toThrow(
      /canonical decimal string/
    )

    const mixedSnapshots = candidates()
    mixedSnapshots[0].snapshotId = '999'
    expect(() => buildDexGoldenWalletSnapshot({ candidates: mixedSnapshots, ...METADATA })).toThrow(
      /one passed source snapshot/
    )

    const wrongCurrency = candidates()
    wrongCurrency[0].pnlCurrency = 'USDC'
    expect(() => buildDexGoldenWalletSnapshot({ candidates: wrongCurrency, ...METADATA })).toThrow(
      /unexpected PnL currency/
    )

    const mixedCounts = candidates()
    mixedCounts[0].snapshotActualCount = 71
    expect(() => buildDexGoldenWalletSnapshot({ candidates: mixedCounts, ...METADATA })).toThrow(
      /snapshot actual count/
    )

    expect(() =>
      buildDexGoldenWalletSnapshot({
        candidates: candidates(),
        ...METADATA,
        generatedAt: '2026-07-18T17:45:00.001Z',
      })
    ).toThrow(/freshness gate/)

    expect(() =>
      buildDexGoldenWalletSnapshot({
        candidates: candidates(),
        ...METADATA,
        sampleSeed: '\ud800',
      })
    ).toThrow(/isolated surrogate/)
  })
})
