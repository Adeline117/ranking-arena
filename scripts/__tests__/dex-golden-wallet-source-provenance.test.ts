import { runInNewContext } from 'node:vm'

import parentFixtureJson from '../fixtures/dex-golden-wallets.v1.json'
import provenanceFixtureJson from '../fixtures/dex-golden-wallet-source-provenance.v1.json'
import { dexGoldenPinnedCandidateQuerySha256 } from '../lib/dex-golden-wallet-replay'
import {
  DEX_GOLDEN_SOURCE_PROVENANCE_V1_SHA256,
  dexGoldenWalletSourceProvenanceSha256,
  parseDexGoldenWalletSourceProvenance,
  verifyCanonicalDexGoldenWalletSourceProvenance,
} from '../lib/dex-golden-wallet-source-provenance'
import { dexGoldenWalletSnapshotSha256 } from '../lib/dex-golden-wallets'

function mutableProvenance(): typeof provenanceFixtureJson {
  return JSON.parse(JSON.stringify(provenanceFixtureJson)) as typeof provenanceFixtureJson
}

function mutableParent(): typeof parentFixtureJson {
  return JSON.parse(JSON.stringify(parentFixtureJson)) as typeof parentFixtureJson
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

describe('DEX golden-wallet source provenance', () => {
  it('pins the clean observation without claiming provider or production-origin proof', () => {
    const provenance = verifyCanonicalDexGoldenWalletSourceProvenance(
      provenanceFixtureJson,
      parentFixtureJson
    )
    expect(provenance).toMatchObject({
      purpose: 'phase0_selected_fixture_generator_baseline_only',
      parent_snapshot_sha256: '736144afddfb61c3140c4286caf480578345aae1c30f9e65c50341092cf2e5ba',
      observation: {
        recorded_verifier_git_sha: '87fe67cfb1461f1213012cfcb1f270ad843dff2d',
        recorded_verifier_worktree_clean: true,
        tls_transport_encrypted: true,
        tls_server_identity_verified: false,
        production_database_identity_verified: false,
      },
      raw_boundary: {
        provider_refetch_performed: false,
        provider_body_included: false,
        raw_object_locator_included: false,
        raw_content_commitment_included: false,
      },
      claims: {
        population_denominator_authorized: false,
        serving_authorized: false,
        rank_eligible: false,
        score_eligible: false,
      },
    })
    expect(JSON.stringify(provenance)).not.toContain(parentFixtureJson.wallets[0].wallet)
  })

  it('pins the exact verifier query and complete observed row/candidate roots', () => {
    const provenance = parseDexGoldenWalletSourceProvenance(
      provenanceFixtureJson,
      parentFixtureJson
    )
    expect(provenance.candidate_query.sha256).toBe(dexGoldenPinnedCandidateQuerySha256())
    expect(provenance.query_row_set).toEqual({
      commitment_state: 'pinned_observation_baseline',
      sha256: '0974bea50f5b945a7b6800e7669fcda22f04153bcf970e17b54eb22cc5634458',
      row_count: 7508,
    })
    expect(provenance.eligible_candidate_set).toEqual({
      commitment_state: 'pinned_observation_baseline',
      sha256: 'cec54b8a53abef1d52cb40e7ad98ae4cc5bb5b4fda6bb51075896c17a14b4d2c',
      candidate_count: 7508,
      candidate_counts: {
        binance_web3_bsc: 775,
        okx_web3_solana: 6733,
      },
    })
  })

  it('is content addressed independently from the parent golden fixture', () => {
    expect(dexGoldenWalletSourceProvenanceSha256(provenanceFixtureJson, parentFixtureJson)).toBe(
      DEX_GOLDEN_SOURCE_PROVENANCE_V1_SHA256
    )
  })

  it('rejects a foreign parent fixture or reordered source pins', () => {
    const foreignParent = mutableParent()
    foreignParent.generator_git_sha = 'a'.repeat(40)
    expect(() =>
      parseDexGoldenWalletSourceProvenance(provenanceFixtureJson, foreignParent)
    ).toThrow('parent snapshot SHA')

    const reordered = mutableProvenance()
    reordered.source_snapshot_pins.reverse()
    expect(() => parseDexGoldenWalletSourceProvenance(reordered, parentFixtureJson)).toThrow(
      'source provenance pin conflicts'
    )
  })

  it('rejects row/candidate denominator drift', () => {
    const badRows = mutableProvenance()
    badRows.query_row_set.row_count -= 1
    expect(() => parseDexGoldenWalletSourceProvenance(badRows, parentFixtureJson)).toThrow(
      'query row count conflicts'
    )

    const badCandidates = mutableProvenance()
    badCandidates.eligible_candidate_set.candidate_counts.binance_web3_bsc -= 1
    expect(() => parseDexGoldenWalletSourceProvenance(badCandidates, parentFixtureJson)).toThrow(
      'candidate count conflicts'
    )
  })

  it('strictly rejects any RAW locator or other undeclared field', () => {
    const withRawLocator = mutableProvenance()
    Object.assign(withRawLocator.raw_boundary, { raw_object_id: '2089234' })
    expect(() => parseDexGoldenWalletSourceProvenance(withRawLocator, parentFixtureJson)).toThrow()

    const withTopLevelAlias = mutableProvenance()
    Object.assign(withTopLevelAlias, { provenance_verified: true })
    expect(() =>
      parseDexGoldenWalletSourceProvenance(withTopLevelAlias, parentFixtureJson)
    ).toThrow()
  })

  it('separates structural records from the one canonical Phase 0 baseline', () => {
    const changedRoot = mutableProvenance()
    changedRoot.query_row_set.sha256 = '0'.repeat(64)
    expect(() => parseDexGoldenWalletSourceProvenance(changedRoot, parentFixtureJson)).not.toThrow()
    expect(() =>
      verifyCanonicalDexGoldenWalletSourceProvenance(changedRoot, parentFixtureJson)
    ).toThrow('canonical source provenance SHA')

    const futureAssertion = mutableProvenance()
    futureAssertion.baseline_recorded_at = '9999-12-31T23:59:59.999Z'
    futureAssertion.observation.recorded_verifier_git_sha = 'f'.repeat(40)
    expect(() =>
      parseDexGoldenWalletSourceProvenance(futureAssertion, parentFixtureJson)
    ).not.toThrow()
    expect(() =>
      verifyCanonicalDexGoldenWalletSourceProvenance(futureAssertion, parentFixtureJson)
    ).toThrow('canonical source provenance SHA')

    const foreignParent = mutableParent()
    foreignParent.generator_git_sha = 'a'.repeat(40)
    const selfConsistentForeign = mutableProvenance()
    selfConsistentForeign.parent_snapshot_sha256 = dexGoldenWalletSnapshotSha256(foreignParent)
    expect(() =>
      parseDexGoldenWalletSourceProvenance(selfConsistentForeign, foreignParent)
    ).not.toThrow()
    expect(() =>
      verifyCanonicalDexGoldenWalletSourceProvenance(selfConsistentForeign, foreignParent)
    ).toThrow('canonical source provenance SHA')
  })

  it('accepts ordinary cross-realm JSON without changing canonical identity', () => {
    const crossRealm = runInNewContext('JSON.parse(serialized)', {
      serialized: JSON.stringify(provenanceFixtureJson),
    }) as unknown
    expect(verifyCanonicalDexGoldenWalletSourceProvenance(crossRealm, parentFixtureJson)).toEqual(
      parseDexGoldenWalletSourceProvenance(provenanceFixtureJson, parentFixtureJson)
    )
    expect(dexGoldenWalletSourceProvenanceSha256(crossRealm, parentFixtureJson)).toBe(
      DEX_GOLDEN_SOURCE_PROVENANCE_V1_SHA256
    )
  })

  it('rejects __proto__ and descriptor hash aliases before schema parsing', () => {
    for (const target of [mutableProvenance(), mutableProvenance().raw_boundary]) {
      Object.defineProperty(target, '__proto__', {
        configurable: true,
        enumerable: true,
        value: { raw_object_id: '2089234' },
      })
      expect(() => parseDexGoldenWalletSourceProvenance(target, parentFixtureJson)).toThrow(
        /__proto__ object keys/
      )
    }

    const hiddenPin = mutableProvenance()
    Object.defineProperty(hiddenPin.source_snapshot_pins, '0', {
      configurable: true,
      enumerable: false,
      value: hiddenPin.source_snapshot_pins[0],
    })
    expect(() => parseDexGoldenWalletSourceProvenance(hiddenPin, parentFixtureJson)).toThrow(
      /non-enumerable array elements/
    )

    const accessor = mutableProvenance()
    const recordedAt = accessor.baseline_recorded_at
    let getterCalls = 0
    Object.defineProperty(accessor, 'baseline_recorded_at', {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1
        return recordedAt
      },
    })
    expect(() => parseDexGoldenWalletSourceProvenance(accessor, parentFixtureJson)).toThrow(
      /object accessors/
    )
    expect(getterCalls).toBe(0)

    const symbol = mutableProvenance()
    Object.defineProperty(symbol, Symbol('hidden-raw-locator'), {
      enumerable: true,
      value: 'forbidden',
    })
    expect(() => parseDexGoldenWalletSourceProvenance(symbol, parentFixtureJson)).toThrow(
      /symbol keys/
    )
  })

  it('rejects hostile and revoked Proxies without executing a trap', () => {
    let trapCalls = 0
    const hostile = hostileProxy(mutableProvenance(), () => {
      trapCalls += 1
    })
    expect(() => parseDexGoldenWalletSourceProvenance(hostile, parentFixtureJson)).toThrow(
      /Proxy objects/
    )
    expect(() => dexGoldenWalletSourceProvenanceSha256(hostile, parentFixtureJson)).toThrow(
      /Proxy objects/
    )

    const revoked = Proxy.revocable(mutableProvenance(), {})
    revoked.revoke()
    expect(() => parseDexGoldenWalletSourceProvenance(revoked.proxy, parentFixtureJson)).toThrow(
      /Proxy objects/
    )
    expect(trapCalls).toBe(0)
  })

  it('rejects cycles and depth/node attacks with fixed TypeErrors', () => {
    const cyclic = mutableProvenance() as typeof provenanceFixtureJson & { cycle?: unknown }
    cyclic.cycle = cyclic
    expect(() => parseDexGoldenWalletSourceProvenance(cyclic, parentFixtureJson)).toThrow(
      new TypeError('strict canonical JSON rejects cycles')
    )

    const deep = mutableProvenance() as typeof provenanceFixtureJson & { attack?: unknown }
    const deepRoot: Record<string, unknown> = {}
    let cursor = deepRoot
    deep.attack = deepRoot
    for (let index = 0; index < 30_000; index += 1) {
      const next: Record<string, unknown> = {}
      cursor.next = next
      cursor = next
    }
    expect(() => parseDexGoldenWalletSourceProvenance(deep, parentFixtureJson)).toThrow(
      new TypeError('strict canonical JSON rejects input depth limit')
    )

    const wide = mutableProvenance() as typeof provenanceFixtureJson & { attack?: unknown }
    wide.attack = new Array<null>(50_000).fill(null)
    expect(() => parseDexGoldenWalletSourceProvenance(wide, parentFixtureJson)).toThrow(
      new TypeError('strict canonical JSON rejects input node limit')
    )
  })
})
