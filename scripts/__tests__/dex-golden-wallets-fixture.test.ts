import { runInNewContext } from 'node:vm'

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

function hostileProxy<T extends object>(target: T, onTrap: () => void): T {
  const trapped = (): never => {
    onTrap()
    throw new Error('hostile Proxy trap must not run')
  }
  return new Proxy(target, {
    get: trapped,
    getOwnPropertyDescriptor: trapped,
    getPrototypeOf: trapped,
    has: trapped,
    ownKeys: trapped,
  })
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

  it('accepts ordinary JSON records from another VM realm without changing the hash', () => {
    const crossRealmFixture = runInNewContext('JSON.parse(serialized)', {
      serialized: JSON.stringify(fixtureJson),
    }) as unknown

    expect(parseDexGoldenWalletSnapshot(crossRealmFixture)).toEqual(fixture)
    expect(dexGoldenWalletSnapshotSha256(crossRealmFixture)).toBe(EXPECTED_FIXTURE_SHA256)
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
    foreign.wallets[0].wallet = fixture.wallets.find(
      (wallet) => wallet.source_slug === 'okx_web3_solana'
    )!.wallet
    expect(() => parseDexGoldenWalletChainSubset(foreign)).toThrow(/foreign source wallet/)

    const duplicate = JSON.parse(JSON.stringify(subset)) as typeof subset
    duplicate.wallets[1].wallet = duplicate.wallets[0].wallet
    expect(() => parseDexGoldenWalletChainSubset(duplicate)).toThrow(/wallet identity/)

    const reordered = JSON.parse(JSON.stringify(subset)) as typeof subset
    ;[reordered.wallets[0], reordered.wallets[1]] = [reordered.wallets[1], reordered.wallets[0]]
    expect(() => parseDexGoldenWalletChainSubset(reordered)).toThrow(/canonical cohort\/wallet/)

    const invalidTopBoundary = JSON.parse(JSON.stringify(subset)) as typeof subset
    const top = invalidTopBoundary.wallets.find((wallet) => wallet.cohort === 'top')!
    const nonTop = invalidTopBoundary.wallets.find((wallet) => wallet.cohort !== 'top')!
    ;[top.source_rank, nonTop.source_rank] = [nonTop.source_rank, top.source_rank]
    expect(() => parseDexGoldenWalletChainSubset(invalidTopBoundary)).toThrow(
      /top cohort is not ahead/
    )
  })

  it('rejects a Solana subset wallet that only looks like Base58', () => {
    const { subset } = buildDexGoldenWalletChainSubset(fixtureJson, 'okx_web3_solana')
    const wrongByteLength = JSON.parse(JSON.stringify(subset)) as typeof subset
    wrongByteLength.wallets[0].wallet = 'A'.repeat(32)

    expect(() => parseDexGoldenWalletChainSubset(wrongByteLength)).toThrow(/exactly 32 bytes/)

    const disguisedAsBsc = JSON.parse(JSON.stringify(subset)) as typeof subset
    disguisedAsBsc.wallets[0].source_slug = 'binance_web3_bsc'
    disguisedAsBsc.wallets[0].chain = { namespace: 'eip155', reference: '56' }
    disguisedAsBsc.wallets[0].wallet = '0x1111111111111111111111111111111111111111'
    expect(() => parseDexGoldenWalletChainSubset(disguisedAsBsc)).toThrow(/foreign source wallet/)
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

    const wrongSolanaByteLength = mutableFixture()
    const solanaWallet = (wrongSolanaByteLength.wallets as Array<Record<string, unknown>>).find(
      (wallet) => wallet.source_slug === 'okx_web3_solana'
    )!
    solanaWallet.wallet = 'A'.repeat(32)
    expect(() => parseDexGoldenWalletSnapshot(wrongSolanaByteLength)).toThrow(/exactly 32 bytes/)
  })

  it('rejects negative zero before it can alias canonical zero in a fixture hash', () => {
    const negativeZero = mutableFixture()
    const wallets = negativeZero.wallets as Array<Record<string, unknown>>
    wallets[0].activity_proxy_count = -0

    expect(() => parseDexGoldenWalletSnapshot(negativeZero)).toThrow(/negative zero/)
    expect(() => dexGoldenWalletSnapshotSha256(negativeZero)).toThrow(/negative zero/)
  })

  it('rejects accessors before invocation and refuses hidden or symbol hash aliases', () => {
    const accessor = mutableFixture()
    const accessorWallets = accessor.wallets as Array<Record<string, unknown>>
    const walletValue = accessorWallets[0].wallet
    let getterCalls = 0
    Object.defineProperty(accessorWallets[0], 'wallet', {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1
        return walletValue
      },
    })

    expect(() => parseDexGoldenWalletSnapshot(accessor)).toThrow(/object accessors/)
    expect(() => dexGoldenWalletSnapshotSha256(accessor)).toThrow(/object accessors/)
    expect(getterCalls).toBe(0)

    const hidden = mutableFixture()
    Object.defineProperty(hidden, 'hidden_provenance', {
      enumerable: false,
      value: 'must-not-alias',
    })
    expect(() => parseDexGoldenWalletSnapshot(hidden)).toThrow(/non-enumerable object properties/)
    expect(() => dexGoldenWalletSnapshotSha256(hidden)).toThrow(/non-enumerable object properties/)

    const symbol = mutableFixture()
    Object.defineProperty(symbol, Symbol('hidden-provenance'), {
      enumerable: true,
      value: 'must-not-alias',
    })
    expect(() => parseDexGoldenWalletSnapshot(symbol)).toThrow(/symbol keys/)
    expect(() => dexGoldenWalletSnapshotSha256(symbol)).toThrow(/symbol keys/)

    const hiddenArrayElement = mutableFixture()
    const hiddenWallets = hiddenArrayElement.wallets as Array<Record<string, unknown>>
    Object.defineProperty(hiddenWallets, '0', {
      enumerable: false,
      value: hiddenWallets[0],
    })
    expect(() => parseDexGoldenWalletSnapshot(hiddenArrayElement)).toThrow(
      /non-enumerable array elements/
    )
    expect(() => dexGoldenWalletSnapshotSha256(hiddenArrayElement)).toThrow(
      /non-enumerable array elements/
    )
  })

  it('applies the same descriptor-safe preflight to derived chain subsets', () => {
    const { subset } = buildDexGoldenWalletChainSubset(fixtureJson, 'okx_web3_solana')
    const accessor = JSON.parse(JSON.stringify(subset)) as typeof subset
    const walletValue = accessor.wallets[0].wallet
    let getterCalls = 0
    Object.defineProperty(accessor.wallets[0], 'wallet', {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1
        return walletValue
      },
    })

    expect(() => parseDexGoldenWalletChainSubset(accessor)).toThrow(/object accessors/)
    expect(() => dexGoldenWalletChainSubsetSha256(accessor)).toThrow(/object accessors/)
    expect(getterCalls).toBe(0)

    const hidden = JSON.parse(JSON.stringify(subset)) as typeof subset
    Object.defineProperty(hidden.wallets[0], 'hidden', {
      enumerable: false,
      value: true,
    })
    expect(() => parseDexGoldenWalletChainSubset(hidden)).toThrow(
      /non-enumerable object properties/
    )
    expect(() => dexGoldenWalletChainSubsetSha256(hidden)).toThrow(
      /non-enumerable object properties/
    )

    const hiddenArrayElement = JSON.parse(JSON.stringify(subset)) as typeof subset
    Object.defineProperty(hiddenArrayElement.wallets, '0', {
      enumerable: false,
      value: hiddenArrayElement.wallets[0],
    })
    expect(() => parseDexGoldenWalletChainSubset(hiddenArrayElement)).toThrow(
      /non-enumerable array elements/
    )
    expect(() => dexGoldenWalletChainSubsetSha256(hiddenArrayElement)).toThrow(
      /non-enumerable array elements/
    )
  })

  it('rejects inherited getters without invoking them', () => {
    const inherited = mutableFixture()
    delete inherited.sample_seed
    const originalDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'sample_seed')
    let getterCalls = 0
    Object.defineProperty(Object.prototype, 'sample_seed', {
      configurable: true,
      get() {
        getterCalls += 1
        return fixture.sample_seed
      },
    })

    try {
      expect(() => parseDexGoldenWalletSnapshot(inherited)).toThrow()
      expect(() => dexGoldenWalletSnapshotSha256(inherited)).toThrow()
      expect(getterCalls).toBe(0)
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(Object.prototype, 'sample_seed', originalDescriptor)
      } else {
        delete (Object.prototype as Record<string, unknown>).sample_seed
      }
    }
  })

  it('rejects top-level and nested Proxies without running any trap', () => {
    let trapCalls = 0
    const topLevelProxy = hostileProxy(mutableFixture(), () => {
      trapCalls += 1
    })
    expect(() => parseDexGoldenWalletSnapshot(topLevelProxy)).toThrow(/Proxy objects/)
    expect(() => dexGoldenWalletSnapshotSha256(topLevelProxy)).toThrow(/Proxy objects/)

    const nestedProxy = mutableFixture()
    const nestedWallets = nestedProxy.wallets as Array<Record<string, unknown>>
    nestedWallets[0] = hostileProxy(nestedWallets[0], () => {
      trapCalls += 1
    })
    expect(() => parseDexGoldenWalletSnapshot(nestedProxy)).toThrow(/Proxy objects/)

    const { subset } = buildDexGoldenWalletChainSubset(fixtureJson, 'binance_web3_bsc')
    const subsetProxy = hostileProxy(subset, () => {
      trapCalls += 1
    })
    expect(() => parseDexGoldenWalletChainSubset(subsetProxy)).toThrow(/Proxy objects/)
    expect(() => dexGoldenWalletChainSubsetSha256(subsetProxy)).toThrow(/Proxy objects/)
    expect(trapCalls).toBe(0)
  })

  it('rejects Proxy prototypes and revoked Proxies before reflection', () => {
    let trapCalls = 0
    const inheritedProxy = mutableFixture()
    Object.setPrototypeOf(
      inheritedProxy,
      hostileProxy(Object.create(null) as Record<string, unknown>, () => {
        trapCalls += 1
      })
    )
    expect(() => parseDexGoldenWalletSnapshot(inheritedProxy)).toThrow(/non-plain objects/)

    const revoked = Proxy.revocable(mutableFixture(), {})
    revoked.revoke()
    expect(() => parseDexGoldenWalletSnapshot(revoked.proxy)).toThrow(/Proxy objects/)
    expect(() => dexGoldenWalletSnapshotSha256(revoked.proxy)).toThrow(/Proxy objects/)
    expect(trapCalls).toBe(0)
  })

  it('rejects array accessors, symbols, and sparse slots without invoking code', () => {
    const accessor = mutableFixture()
    const accessorWallets = accessor.wallets as Array<Record<string, unknown>>
    const wallet = accessorWallets[0]
    let getterCalls = 0
    Object.defineProperty(accessorWallets, '0', {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1
        return wallet
      },
    })
    expect(() => parseDexGoldenWalletSnapshot(accessor)).toThrow(/array accessors/)
    expect(() => dexGoldenWalletSnapshotSha256(accessor)).toThrow(/array accessors/)
    expect(getterCalls).toBe(0)

    const symbol = mutableFixture()
    Object.defineProperty(symbol.wallets as unknown[], Symbol('hidden-array-field'), {
      enumerable: true,
      value: 'must-not-alias',
    })
    expect(() => parseDexGoldenWalletSnapshot(symbol)).toThrow(/symbol keys/)

    const sparse = mutableFixture()
    delete (sparse.wallets as unknown[])[0]
    expect(() => parseDexGoldenWalletSnapshot(sparse)).toThrow(/sparse arrays/)
  })

  it('sanitizes shared records and terminal prototype behavior before schema parsing', () => {
    const shared = mutableFixture()
    const sharedWallets = shared.wallets as Array<Record<string, unknown>>
    sharedWallets[1].chain = sharedWallets[0].chain
    expect(dexGoldenWalletSnapshotSha256(shared)).toBe(EXPECTED_FIXTURE_SHA256)

    const forgedPrototype = Object.create(null) as Record<string, unknown>
    Object.defineProperties(forgedPrototype, Object.getOwnPropertyDescriptors(Object.prototype))
    let inheritedGetterCalls = 0
    Object.defineProperty(forgedPrototype, 'toString', {
      configurable: true,
      enumerable: false,
      get() {
        inheritedGetterCalls += 1
        return Object.prototype.toString
      },
    })
    const forged = mutableFixture()
    Object.setPrototypeOf(forged, forgedPrototype)
    expect(dexGoldenWalletSnapshotSha256(forged)).toBe(EXPECTED_FIXTURE_SHA256)
    expect(inheritedGetterCalls).toBe(0)

    const protoKey = mutableFixture()
    Object.defineProperty(protoKey, '__proto__', {
      configurable: true,
      enumerable: true,
      value: { polluted: true },
    })
    expect(() => parseDexGoldenWalletSnapshot(protoKey)).toThrow(/__proto__ object keys/)
    expect(() => dexGoldenWalletSnapshotSha256(protoKey)).toThrow(/__proto__ object keys/)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  it('applies depth limits to every expanded shared-reference path', () => {
    const input = mutableFixture()
    const nodes = Array.from({ length: 2_000 }, () => ({}) as Record<string, unknown>)
    for (let index = 0; index < nodes.length - 1; index += 1) {
      nodes[index].next = nodes[index + 1]
    }
    const attack: Record<string, unknown> = {}
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      attack[`cache${index}`] = nodes[index]
    }
    attack.deep = nodes[0]
    input.attack = attack

    expect(() => parseDexGoldenWalletSnapshot(input)).toThrow(
      new TypeError('strict canonical JSON rejects input depth limit')
    )

    const wide = mutableFixture()
    wide.attack = new Array<null>(50_000).fill(null)
    expect(() => parseDexGoldenWalletSnapshot(wide)).toThrow(
      new TypeError('strict canonical JSON rejects input node limit')
    )
  })

  it('rejects cycles and excessive depth with fixed TypeErrors instead of stack overflow', () => {
    const cyclicSnapshot = mutableFixture()
    cyclicSnapshot.cycle = cyclicSnapshot
    expect(() => parseDexGoldenWalletSnapshot(cyclicSnapshot)).toThrow(
      new TypeError('strict canonical JSON rejects cycles')
    )

    const deepSnapshot = mutableFixture()
    const deepValue: Record<string, unknown> = {}
    let snapshotCursor = deepValue
    deepSnapshot.deep = deepValue
    for (let index = 0; index < 30_000; index += 1) {
      const next: Record<string, unknown> = {}
      snapshotCursor.next = next
      snapshotCursor = next
    }
    expect(() => parseDexGoldenWalletSnapshot(deepSnapshot)).toThrow(
      new TypeError('strict canonical JSON rejects input depth limit')
    )

    const { subset } = buildDexGoldenWalletChainSubset(fixtureJson, 'okx_web3_solana')
    const cyclicSubset = subset as typeof subset & { cycle?: unknown }
    cyclicSubset.cycle = cyclicSubset
    expect(() => parseDexGoldenWalletChainSubset(cyclicSubset)).toThrow(
      new TypeError('strict canonical JSON rejects cycles')
    )

    const { subset: deepSubsetBase } = buildDexGoldenWalletChainSubset(
      fixtureJson,
      'okx_web3_solana'
    )
    const deepSubset = deepSubsetBase as typeof deepSubsetBase & { deep?: unknown }
    deepSubset.deep = deepValue
    expect(() => parseDexGoldenWalletChainSubset(deepSubset)).toThrow(
      new TypeError('strict canonical JSON rejects input depth limit')
    )
  })

  it('rejects population claims smaller than selected evidence or a false top cohort', () => {
    const tooFewEligible = mutableFixture()
    const eligiblePopulations = tooFewEligible.populations as Array<Record<string, unknown>>
    eligiblePopulations[0].eligible_candidates_with_non_null_pnl = 49
    eligiblePopulations[0].candidates_with_positive_activity_proxy = 49
    expect(() => parseDexGoldenWalletSnapshot(tooFewEligible)).toThrow(
      /population is smaller than its selected wallet evidence/
    )

    const tooFewActive = mutableFixture()
    const activePopulations = tooFewActive.populations as Array<Record<string, unknown>>
    activePopulations[0].candidates_with_positive_activity_proxy = 49
    expect(() => parseDexGoldenWalletSnapshot(tooFewActive)).toThrow(
      /population is smaller than its selected wallet evidence/
    )

    const invalidTopBoundary = mutableFixture()
    const boundaryPopulations = invalidTopBoundary.populations as Array<Record<string, unknown>>
    const boundaryWallets = invalidTopBoundary.wallets as Array<Record<string, unknown>>
    const boundaryPopulation = boundaryPopulations.find(
      (population) => population.source_slug === 'binance_web3_bsc'
    )!
    const bscWallets = boundaryWallets.filter((wallet) => wallet.source_slug === 'binance_web3_bsc')
    const usedRanks = new Set(bscWallets.map((wallet) => Number(wallet.source_rank)))
    let replacementRank = Number(boundaryPopulation.snapshot_actual_count)
    while (usedRanks.has(replacementRank)) replacementRank -= 1
    bscWallets.find((wallet) => wallet.cohort === 'top')!.source_rank = replacementRank
    expect(() => parseDexGoldenWalletSnapshot(invalidTopBoundary)).toThrow(
      /top cohort is not ahead/
    )
  })
})
