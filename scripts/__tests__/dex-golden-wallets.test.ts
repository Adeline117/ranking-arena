import {
  buildDexGoldenWalletSnapshot,
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
        sourceRank: index + 1,
        arenaScore: 100 - index,
        pnl90d: 10_000 - index,
        activityProxyCount: index + 1,
        statsAsOf: '2026-07-16T18:00:00.000Z',
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
  })

  it('is invariant to candidate input order and emits a deterministic hash', () => {
    const ordered = buildDexGoldenWalletSnapshot({ candidates: candidates(), ...METADATA })
    const reversed = buildDexGoldenWalletSnapshot({
      candidates: candidates().reverse(),
      ...METADATA,
    })

    expect(reversed).toEqual(ordered)
    expect(ordered.sha256).toMatch(/^[0-9a-f]{64}$/)
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

    const duplicate = candidates()
    duplicate[1].wallet = duplicate[0].wallet
    expect(() => buildDexGoldenWalletSnapshot({ candidates: duplicate, ...METADATA })).toThrow(
      /duplicate golden-wallet candidate/
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
  })
})
