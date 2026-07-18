import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  DEX_GOLDEN_RPC_EVIDENCE_CONTRACT,
  DEX_GOLDEN_RPC_REQUIRED_BLOCKERS,
  DEX_SOLANA_GOLDEN_RPC_LANES,
  dexGoldenRpcEvidenceSha256,
  parseDexGoldenRpcEvidence,
  parseDexGoldenRpcEvidenceJson,
} from '../lib/dex-golden-rpc-evidence'

const FIXTURE_PATH = join(
  process.cwd(),
  'scripts',
  'fixtures',
  'dex-solana-golden-rpc-metadata.v3.json'
)
const FIXTURE_SHA256 = '223babd47d32242e49e594286cc20a7cd5471aa9ab8e85bdeee5c3d96390b2a9'
const TRANSACTION_ID =
  'j79Ffrrm3v5mD1WoM2fNrsRsefDFoFx9DTdZARp877uZqZ3RDrXQ35yNxKZ26SBGqDCj8n358Z9GztGRFxKDpef'
const STABLE_FACTS_SHA256 = 'd29905e525cd5f0c7aa97fcfe033f5a5b1862111dfa2a3f71020401fc51f7803'
const TRANSACTION_RESPONSE_SHA256 =
  'd874cfef6a79682a139298863a82b8f723aea60fc610d903396f96fca502cb08'

const fixtureText = readFileSync(FIXTURE_PATH, 'utf8')

function mutableFixture(): any {
  return JSON.parse(fixtureText)
}

function propertyNames(value: unknown, names = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) propertyNames(item, names)
    return names
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      names.add(key)
      propertyNames(child, names)
    }
  }
  return names
}

describe('real Solana golden RPC metadata witness fixture', () => {
  const fixture = parseDexGoldenRpcEvidenceJson(fixtureText)

  it('pins one exact two-provider finality/membership metadata witness', () => {
    expect(fixture).toMatchObject({
      schema_version: 3,
      data_contract: DEX_GOLDEN_RPC_EVIDENCE_CONTRACT,
      purpose: 'phase0_shadow_finality_membership_evidence_only',
      proof_boundary:
        'same_provider_rpc_assertions_not_cryptographic_inclusion_or_protocol_hit_proof',
      verification_state: 'declared_not_replayed',
      generated_at: '2026-07-18T12:01:20.674Z',
      transaction_id: TRANSACTION_ID,
      stable_transaction_facts_sha256: STABLE_FACTS_SHA256,
    })
    expect(dexGoldenRpcEvidenceSha256(fixture)).toBe(FIXTURE_SHA256)
    expect(fixture.captures.map((capture) => capture.endpoint.endpoint_id)).toEqual([
      'publicnode_solana_mainnet',
      'solana_official_mainnet',
    ])
    expect(fixture.captures.map((capture) => capture.capture_completed_at)).toEqual([
      '2026-07-18T12:01:20.668Z',
      '2026-07-18T12:00:59.665Z',
    ])
    expect(fixture.required_blockers).toEqual([...DEX_GOLDEN_RPC_REQUIRED_BLOCKERS])
  })

  it('pins all seven lanes and the identical transaction response commitment from both sources', () => {
    for (const capture of fixture.captures) {
      expect(capture.rpc_exchanges.map(({ lane, method }) => [lane, method])).toEqual(
        DEX_SOLANA_GOLDEN_RPC_LANES
      )
      const transaction = capture.rpc_exchanges.find((exchange) => exchange.lane === 'transaction')
      expect(transaction).toMatchObject({
        method: 'getTransaction',
        params_sha256: '7ddf69346c9946577592b3b18a1faa0b1c644e54a8594db1dbbe6a99a99c82ee',
        request: {
          sha256: 'bb825554ddf0f7054856496639aca6d87e1f407bbe2c830f4346a45184a44a83',
        },
        response: { sha256: TRANSACTION_RESPONSE_SHA256 },
      })
    }
    expect(
      fixture.captures.map(
        (capture) =>
          capture.rpc_exchanges.find((exchange) => exchange.lane === 'transaction')!
            .exchange_binding_sha256
      )
    ).toEqual([
      '1377275f3544daa54f1b0fb4aaaafb357c228c21db7d93ea8fe8e9cab9283299',
      'bb037cfbaaf4e0aaaa016f47bfcba45e7452e6405448f9539d8820dbf2b061d2',
    ])
  })

  it('persists commitments only, with no body locator or replay claim', () => {
    const bodyCommitmentKeys = [
      'byte_length',
      'contains_secrets',
      'content_available_for_replay',
      'hash_basis',
      'media_type',
      'persistence_state',
      'sha256',
    ]
    const documentCommitmentKeys = bodyCommitmentKeys.filter((key) => key !== 'media_type')
    for (const capture of fixture.captures) {
      for (const exchange of capture.rpc_exchanges) {
        for (const commitment of [exchange.request, exchange.response]) {
          expect(Object.keys(commitment).sort()).toEqual(bodyCommitmentKeys)
          expect(commitment).toMatchObject({
            persistence_state: 'not_persisted',
            content_available_for_replay: false,
            contains_secrets: false,
          })
          expect(commitment.byte_length).toBeGreaterThan(0)
          expect(commitment.sha256).toMatch(/^[0-9a-f]{64}$/)
        }
      }
      for (const document of Object.values(capture.normalized_documents)) {
        expect(Object.keys(document).sort()).toEqual(documentCommitmentKeys)
        expect(document).toMatchObject({
          persistence_state: 'not_persisted',
          content_available_for_replay: false,
          contains_secrets: false,
        })
      }
    }

    const names = propertyNames(fixture)
    for (const forbidden of [
      'blob_locator',
      'body',
      'bytes',
      'cookie',
      'headers',
      'normalized_json_body',
      'raw_body',
      'request_body',
      'response_body',
      'secret',
      'text',
      'token',
      'url',
    ]) {
      expect(names.has(forbidden)).toBe(false)
    }
    expect(fixtureText).not.toContain('https://')
    expect(fixtureText).not.toContain('solana-rpc.publicnode.com')
    expect(fixtureText).not.toContain('api.mainnet-beta.solana.com')
  })

  it('keeps every protocol, decoder, serving, rank, and score gate closed', () => {
    expect(fixture.claims).toEqual({
      normalized_documents_replayed: false,
      provider_independence_verified: false,
      finality_membership_verified: false,
      protocol_invocation_verified: false,
      decoder_facts_verified: false,
    })
    expect(fixture.authorization).toEqual({
      network_execution: false,
      raw_blob_persistence: false,
      decoder_fixture: false,
      serving: false,
      rank: false,
      score: false,
    })
  })

  it('fails closed on legacy versions, body injection, hash drift, and authorization upgrades', () => {
    const legacy = mutableFixture()
    legacy.schema_version = 2
    legacy.data_contract = 'arena.dex.golden-rpc-transaction-evidence@2'
    expect(() => parseDexGoldenRpcEvidence(legacy)).toThrow()

    const bodyInjected = mutableFixture()
    bodyInjected.captures[0].rpc_exchanges[0].response.body = { result: 'not allowed' }
    expect(() => parseDexGoldenRpcEvidence(bodyInjected)).toThrow()

    const locatorInjected = mutableFixture()
    locatorInjected.captures[0].normalized_documents.chain_anchor.blob_locator = `sha256:${locatorInjected.captures[0].normalized_documents.chain_anchor.sha256}`
    expect(() => parseDexGoldenRpcEvidence(locatorInjected)).toThrow()

    const drifted = mutableFixture()
    drifted.captures[0].rpc_exchanges[4].response.sha256 = 'ab'.repeat(32)
    expect(() => parseDexGoldenRpcEvidence(drifted)).toThrow('exchange binding SHA')

    const missingBlocker = mutableFixture()
    missingBlocker.required_blockers = missingBlocker.required_blockers.filter(
      (blocker: string) => blocker !== 'protocol_invocation_unverified'
    )
    expect(() => parseDexGoldenRpcEvidence(missingBlocker)).toThrow('missing required blocker')

    const authorized = mutableFixture()
    authorized.authorization.serving = true
    expect(() => parseDexGoldenRpcEvidence(authorized)).toThrow()

    const overclaimed = mutableFixture()
    overclaimed.claims.protocol_invocation_verified = true
    expect(() => parseDexGoldenRpcEvidence(overclaimed)).toThrow()
  })

  it('rejects duplicate JSON keys and provider-order drift', () => {
    const duplicate = fixtureText.replace(
      '"schema_version": 3,',
      '"schema_version": 3, "schema_version": 3,'
    )
    expect(() => parseDexGoldenRpcEvidenceJson(duplicate)).toThrow('invalid strict JSON')

    const reordered = mutableFixture()
    reordered.captures.reverse()
    expect(() => parseDexGoldenRpcEvidence(reordered)).toThrow('canonically sorted')
  })
})
