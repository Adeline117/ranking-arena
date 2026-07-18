import { createHash } from 'node:crypto'

import {
  findSolanaV3ProgramDataAddress,
  SOLANA_BPF_LOADER_V3,
  SOLANA_V3_PROGRAM_ACCOUNT_DATA_BYTES,
  SOLANA_V3_PROGRAMDATA_HEADER_BYTES,
  SOLANA_V3_PROGRAM_OBSERVATION_PROOF_BOUNDARY,
  type SolanaV3ProgramDeploymentObservation,
} from '../../lib/ingest/onchain/solana-program-deployment-evidence'
import { SOLANA_MAINNET_GENESIS_HASH } from '../../lib/ingest/onchain/solana-evidence'
import { decodeBase58BytesBounded } from '../../lib/utils/base58'
import {
  DEX_SOLANA_V3_CURRENT_PROGRAM_OBSERVATION_DOCUMENT_CONTRACT,
  DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_EVIDENCE_CONTRACT,
  DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_EVIDENCE_PROOF_BOUNDARY,
  DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_EVIDENCE_PURPOSE,
  DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_EVIDENCE_SCHEMA_VERSION,
  DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_EVIDENCE_VERIFICATION_STATE,
  DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_REQUIRED_BLOCKERS,
  DEX_SOLANA_V3_PROGRAM_STATE_RPC_LANES,
  DEX_SOLANA_VERIFIED_ANCHOR_DOCUMENT_CONTRACT,
  dexSolanaV3CurrentProgramObservationDocumentSha256,
  dexSolanaV3ProgramStateRpcExchangeBindingSha256,
  dexSolanaV3ProgramStateSourceBindingSha256,
  finalizeDexSolanaV3CurrentProgramStateEvidence,
  parseDexSolanaV3CurrentProgramStateEvidence,
  type DexSolanaV3CurrentProgramStateEvidence,
  type DexSolanaV3CurrentProgramStateEvidenceCore,
  type DexSolanaV3CurrentProgramStateSource,
  type DexSolanaV3CurrentProgramStateSourceCore,
  type DexSolanaV3ProgramStateRpcExchange,
  type DexSolanaV3ProgramStateRpcExchangeCore,
} from '../lib/dex-solana-v3-current-program-state-evidence'
import { dexGoldenRemoteEndpointIdentity } from '../lib/dex-golden-rpc-evidence'
import {
  buildDexSolanaV3StableProgramState,
  DEX_SOLANA_V3_STABLE_PROGRAM_STATE_CONTRACT,
  dexSolanaV3StableProgramStateSha256,
} from '../lib/dex-solana-v3-stable-program-state'

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const GENERATED_AT = '2026-07-18T10:00:10.000Z'
const PROGRAMDATA_LAST_MODIFIED_SLOT = 900n

type EndpointId = 'publicnode_solana_mainnet' | 'solana_official_mainnet'

function encodeBase58(bytes: Uint8Array): string {
  let numericValue = 0n
  for (const byte of bytes) numericValue = numericValue * 256n + BigInt(byte)
  let encoded = ''
  while (numericValue > 0n) {
    encoded = BASE58_ALPHABET[Number(numericValue % 58n)] + encoded
    numericValue /= 58n
  }
  let leadingZeroBytes = 0
  while (leadingZeroBytes < bytes.length && bytes[leadingZeroBytes] === 0) {
    leadingZeroBytes += 1
  }
  return '1'.repeat(leadingZeroBytes) + encoded
}

function publicKey(seed: number): string {
  return encodeBase58(Uint8Array.from({ length: 32 }, (_value, index) => (seed + index * 29) % 256))
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function hashBytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

const PROGRAM_ID = publicKey(17)
const PROGRAMDATA = findSolanaV3ProgramDataAddress(PROGRAM_ID)
const AUTHORITY = publicKey(71)
const BLOCKHASH_A = publicKey(31)
const BLOCKHASH_B = publicKey(32)
const CODE_BYTES = Uint8Array.from({ length: 128 }, (_value, index) => (11 + index * 43) % 256)

function accountDataSha256(): string {
  const pointerBytes = decodeBase58BytesBounded(PROGRAMDATA.address, 32)
  if (pointerBytes?.byteLength !== 32) throw new Error('test PDA must decode')
  const bytes = new Uint8Array(SOLANA_V3_PROGRAM_ACCOUNT_DATA_BYTES)
  bytes[0] = 2
  bytes.set(pointerBytes, 4)
  return hashBytes(bytes)
}

function programDataSha256(): string {
  const authorityBytes = decodeBase58BytesBounded(AUTHORITY, 32)
  if (authorityBytes?.byteLength !== 32) throw new Error('test authority must decode')
  const bytes = new Uint8Array(SOLANA_V3_PROGRAMDATA_HEADER_BYTES + CODE_BYTES.byteLength)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  view.setUint32(0, 3, true)
  view.setBigUint64(4, PROGRAMDATA_LAST_MODIFIED_SLOT, true)
  bytes[12] = 1
  bytes.set(authorityBytes, 13)
  bytes.set(CODE_BYTES, SOLANA_V3_PROGRAMDATA_HEADER_BYTES)
  return hashBytes(bytes)
}

function observationFixture(
  requestedMinimumSlot = '1000',
  accountsContextSlot = '1100'
): SolanaV3ProgramDeploymentObservation {
  return {
    chain: 'solana',
    semantic_state: 'v3_program_and_programdata_accounts_consistent',
    proof_boundary: SOLANA_V3_PROGRAM_OBSERVATION_PROOF_BOUNDARY,
    loader_program_id: SOLANA_BPF_LOADER_V3,
    program_id: PROGRAM_ID,
    programdata_address: PROGRAMDATA.address,
    programdata_bump_seed: PROGRAMDATA.bump_seed,
    requested_min_context_slot_decimal: requestedMinimumSlot,
    accounts_context_slot_decimal: accountsContextSlot,
    program_account: {
      owner: SOLANA_BPF_LOADER_V3,
      executable: true,
      space: SOLANA_V3_PROGRAM_ACCOUNT_DATA_BYTES,
      data_sha256: accountDataSha256(),
      programdata_address: PROGRAMDATA.address,
    },
    programdata_account: {
      owner: SOLANA_BPF_LOADER_V3,
      executable: false,
      space: SOLANA_V3_PROGRAMDATA_HEADER_BYTES + CODE_BYTES.byteLength,
      data_sha256: programDataSha256(),
      last_modified_slot_decimal: PROGRAMDATA_LAST_MODIFIED_SLOT.toString(),
      effective_slot_decimal: (PROGRAMDATA_LAST_MODIFIED_SLOT + 1n).toString(),
      upgrade_authority: { state: 'present', address: AUTHORITY },
      code_offset_bytes: SOLANA_V3_PROGRAMDATA_HEADER_BYTES,
      code_byte_length: CODE_BYTES.byteLength,
      code_sha256: hashBytes(CODE_BYTES),
      code_hash_basis:
        'programdata_allocated_bytes_after_45_byte_state_header_including_trailing_zeros',
    },
  }
}

function stableState() {
  return buildDexSolanaV3StableProgramState(observationFixture())
}

function endpoint(endpointId: EndpointId) {
  return dexGoldenRemoteEndpointIdentity(endpointId)
}

function bodyMetadata(label: string, kind: 'request' | 'response', byteLength = 120) {
  return {
    sha256: hashText(`${kind}:${label}`),
    byte_length: byteLength,
    media_type: 'application/json' as const,
    hash_basis:
      kind === 'request'
        ? ('utf8_json_rpc_request_body_bytes' as const)
        : ('fetch_content_decoded_http_entity_body_bytes_before_utf8' as const),
    persistence_state: 'not_persisted' as const,
    content_available_for_replay: false as const,
    contains_secrets: false as const,
  }
}

function exchangeCore(
  endpointId: EndpointId,
  index: number,
  completedAt: string
): DexSolanaV3ProgramStateRpcExchangeCore {
  const [lane, method] = DEX_SOLANA_V3_PROGRAM_STATE_RPC_LANES[index]
  return {
    lane,
    method,
    params_sha256: hashText(`${endpointId}:${lane}:params`),
    params_hash_basis: 'arena_dex_json_rpc_params_v1',
    http_status: 200,
    completed_at: completedAt,
    request: bodyMetadata(`${endpointId}:${lane}`, 'request'),
    response: bodyMetadata(
      `${endpointId}:${lane}`,
      'response',
      lane === 'program_accounts' ? 3 * 1024 * 1024 : 240
    ),
  }
}

function sourceFixture(
  endpointId: EndpointId,
  startSecond: number,
  rootSlot: bigint,
  contextSlot: bigint,
  blockhash: string,
  currentStateSha256: string
): DexSolanaV3CurrentProgramStateSource {
  const identity = endpoint(endpointId)
  const completionTimes = DEX_SOLANA_V3_PROGRAM_STATE_RPC_LANES.map(
    (_lane, index) => `2026-07-18T10:00:0${startSecond + index}.000Z`
  )
  const captureCompletedAt = completionTimes[completionTimes.length - 1]
  const exchanges = completionTimes.map((completedAt, index) => {
    const core = exchangeCore(endpointId, index, completedAt)
    return {
      ...core,
      exchange_binding_sha256: dexSolanaV3ProgramStateRpcExchangeBindingSha256({
        chain_namespace: 'solana',
        program_id: PROGRAM_ID,
        endpoint: identity,
        capture_completed_at: captureCompletedAt,
        exchange: core,
      }),
    }
  }) as [
    DexSolanaV3ProgramStateRpcExchange,
    DexSolanaV3ProgramStateRpcExchange,
    DexSolanaV3ProgramStateRpcExchange,
    DexSolanaV3ProgramStateRpcExchange,
    DexSolanaV3ProgramStateRpcExchange,
  ]
  const anchorSha256 = hashText(`${endpointId}:anchor`)
  const core: DexSolanaV3CurrentProgramStateSourceCore = {
    endpoint: identity,
    capture_completed_at: captureCompletedAt,
    same_endpoint_anchor: {
      policy: DEX_SOLANA_VERIFIED_ANCHOR_DOCUMENT_CONTRACT,
      observed_at: completionTimes[3],
      finalized_root_slot_decimal: rootSlot.toString(),
      selected_produced_slot_decimal: (rootSlot - 1n).toString(),
      selected_blockhash: blockhash,
      semantic_sha256: anchorSha256,
    },
    requested_min_context_slot_decimal: rootSlot.toString(),
    accounts_context_slot_decimal: contextSlot.toString(),
    current_state_sha256: currentStateSha256,
    rpc_exchanges: exchanges,
    normalized_documents: {
      verified_anchor: {
        sha256: anchorSha256,
        hash_contract: DEX_SOLANA_VERIFIED_ANCHOR_DOCUMENT_CONTRACT,
        persistence_state: 'not_persisted',
        content_available_for_replay: false,
        contains_secrets: false,
      },
      current_program_observation: {
        sha256: dexSolanaV3CurrentProgramObservationDocumentSha256(
          observationFixture(rootSlot.toString(), contextSlot.toString())
        ),
        hash_contract: DEX_SOLANA_V3_CURRENT_PROGRAM_OBSERVATION_DOCUMENT_CONTRACT,
        persistence_state: 'not_persisted',
        content_available_for_replay: false,
        contains_secrets: false,
      },
    },
  }
  return {
    ...core,
    source_binding_sha256: dexSolanaV3ProgramStateSourceBindingSha256({
      chain_namespace: 'solana',
      program_id: PROGRAM_ID,
      current_state_contract: DEX_SOLANA_V3_STABLE_PROGRAM_STATE_CONTRACT,
      current_state_sha256: currentStateSha256,
      source: core,
    }),
  }
}

function coreFixture(): DexSolanaV3CurrentProgramStateEvidenceCore {
  const currentState = stableState()
  const currentStateSha256 = dexSolanaV3StableProgramStateSha256(currentState)
  return {
    schema_version: DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_EVIDENCE_SCHEMA_VERSION,
    data_contract: DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_EVIDENCE_CONTRACT,
    purpose: DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_EVIDENCE_PURPOSE,
    proof_boundary: DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_EVIDENCE_PROOF_BOUNDARY,
    verification_state: DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_EVIDENCE_VERIFICATION_STATE,
    generated_at: GENERATED_AT,
    chain: {
      namespace: 'solana',
      cluster: 'mainnet-beta',
      genesis_hash: SOLANA_MAINNET_GENESIS_HASH,
    },
    program_id: PROGRAM_ID,
    current_state_contract: DEX_SOLANA_V3_STABLE_PROGRAM_STATE_CONTRACT,
    current_state_sha256: currentStateSha256,
    current_state: currentState,
    captures: [
      sourceFixture(
        'publicnode_solana_mainnet',
        0,
        1_000n,
        1_100n,
        BLOCKHASH_A,
        currentStateSha256
      ),
      sourceFixture('solana_official_mainnet', 5, 1_005n, 1_105n, BLOCKHASH_B, currentStateSha256),
    ],
    required_blockers: [...DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_REQUIRED_BLOCKERS],
    claims: {
      raw_rpc_semantics_replayed_in_memory: true,
      required_fixed_endpoint_set_matched: true,
      current_state_projection_agreed: true,
      provider_independence_verified: false,
      cryptographic_finality_verified: false,
      original_deployment_slot_verified: false,
      historical_code_epochs_verified: false,
      source_build_identity_verified: false,
      protocol_ownership_verified: false,
      protocol_invocation_verified: false,
      decoder_facts_verified: false,
      wallet_attribution_verified: false,
      metrics_verified: false,
      legal_clearance_verified: false,
    },
    authorization: {
      network_execution: false,
      raw_blob_persistence: false,
      decoder_fixture: false,
      serving: false,
      rank: false,
      score: false,
    },
  }
}

function finalize(core: DexSolanaV3CurrentProgramStateEvidenceCore = coreFixture()) {
  return finalizeDexSolanaV3CurrentProgramStateEvidence(core)
}

function sourceCore(
  source: DexSolanaV3CurrentProgramStateSource
): DexSolanaV3CurrentProgramStateSourceCore {
  const { source_binding_sha256: _binding, ...core } = source
  return core
}

function exchangeWithoutBinding(
  exchange: DexSolanaV3ProgramStateRpcExchange
): DexSolanaV3ProgramStateRpcExchangeCore {
  const { exchange_binding_sha256: _binding, ...core } = exchange
  return core
}

function rehashSource(core: DexSolanaV3CurrentProgramStateEvidenceCore, index: 0 | 1): void {
  const source = core.captures[index]
  for (const exchange of source.rpc_exchanges) {
    exchange.exchange_binding_sha256 = dexSolanaV3ProgramStateRpcExchangeBindingSha256({
      chain_namespace: 'solana',
      program_id: core.program_id,
      endpoint: source.endpoint,
      capture_completed_at: source.capture_completed_at,
      exchange: exchangeWithoutBinding(exchange),
    })
  }
  source.source_binding_sha256 = dexSolanaV3ProgramStateSourceBindingSha256({
    chain_namespace: 'solana',
    program_id: core.program_id,
    current_state_contract: DEX_SOLANA_V3_STABLE_PROGRAM_STATE_CONTRACT,
    current_state_sha256: core.current_state_sha256,
    source: sourceCore(source),
  })
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys)
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key)
      collectKeys(child, keys)
    }
  }
  return keys
}

describe('Solana loader-v3 current program-state evidence contract', () => {
  it('finalizes the exact two-endpoint metadata-only envelope and pins all closure hashes', () => {
    const evidence = finalize()

    expect(evidence.captures.map((source) => source.endpoint.endpoint_id)).toEqual([
      'publicnode_solana_mainnet',
      'solana_official_mainnet',
    ])
    expect(evidence.captures.map((source) => source.source_binding_sha256)).toEqual([
      '62bb506b8970f03ecfded5ce755cfd081ef8e1a8e53ca524b36197b3ef0784c5',
      '770898e255a0324a5c5b325876c198e56c52b98f5f75ed32c4f5184a8fbe4ca0',
    ])
    expect(evidence.captures[0].rpc_exchanges[0].exchange_binding_sha256).toBe(
      'b713694ac1dab0bc475c9f6020f9149d2b400fefc536b6e0ebed52f3993a7862'
    )
    expect(evidence.evidence_closure_sha256).toBe(
      'b755dab31996ff72c46da752929faf05606cf2280fdda95d5092330784af5c1a'
    )
    expect(evidence.current_state_sha256).toBe(
      dexSolanaV3StableProgramStateSha256(evidence.current_state)
    )
    expect(evidence.claims).toMatchObject({
      raw_rpc_semantics_replayed_in_memory: true,
      required_fixed_endpoint_set_matched: true,
      current_state_projection_agreed: true,
      provider_independence_verified: false,
      original_deployment_slot_verified: false,
      historical_code_epochs_verified: false,
      source_build_identity_verified: false,
      protocol_ownership_verified: false,
      protocol_invocation_verified: false,
    })

    const keys = collectKeys(evidence)
    for (const forbiddenKey of [
      'bytes',
      'base64',
      'url',
      'origin',
      'raw_request',
      'raw_response',
      'deployed_slot',
      'deployment_slot',
    ]) {
      expect(keys).not.toContain(forbiddenKey)
    }
  })

  it('is invariant to input object property order but requires canonical endpoint order', () => {
    const core = coreFixture()
    const reordered = Object.fromEntries(Object.entries(core).reverse())
    expect(finalizeDexSolanaV3CurrentProgramStateEvidence(reordered).evidence_closure_sha256).toBe(
      finalize(core).evidence_closure_sha256
    )

    const reversed = coreFixture()
    reversed.captures.reverse()
    expect(() => finalize(reversed)).toThrow('exact canonical endpoint set')
  })

  it('rejects a duplicate or forged pinned endpoint even after bindings are recomputed', () => {
    const duplicate = coreFixture()
    duplicate.captures[1].endpoint = { ...duplicate.captures[0].endpoint }
    rehashSource(duplicate, 1)
    expect(() => finalize(duplicate)).toThrow('exact canonical endpoint set')

    const forged = coreFixture()
    forged.captures[0].endpoint.connection_hash = hashText('forged endpoint')
    expect(() => finalize(forged)).toThrow('pinned credential-free public origin')
  })

  it('rejects lane order, method drift, and the stricter anchor response byte cap', () => {
    const reordered = coreFixture()
    ;[reordered.captures[0].rpc_exchanges[0], reordered.captures[0].rpc_exchanges[1]] = [
      reordered.captures[0].rpc_exchanges[1],
      reordered.captures[0].rpc_exchanges[0],
    ]
    expect(() => finalize(reordered)).toThrow('canonical lane order')

    const method = coreFixture()
    method.captures[0].rpc_exchanges[0].method = 'getSlot'
    expect(() => finalize(method)).toThrow('canonical lane order')

    const oversized = coreFixture()
    oversized.captures[0].rpc_exchanges[0].response.byte_length = 2 * 1024 * 1024 + 1
    expect(() => finalize(oversized)).toThrow('anchor response exceeds')

    const oversizedProgram = coreFixture()
    oversizedProgram.captures[0].rpc_exchanges[4].response.byte_length = 16 * 1024 * 1024 + 1
    expect(() => finalize(oversizedProgram)).toThrow()

    const oversizedRequest = coreFixture()
    oversizedRequest.captures[0].rpc_exchanges[0].request.byte_length = 64 * 1024 + 1
    expect(() => finalize(oversizedRequest)).toThrow()

    const legacyWrongBasis = coreFixture()
    Reflect.set(
      legacyWrongBasis.captures[0].rpc_exchanges[0].response,
      'hash_basis',
      'json_rpc_response_raw_bytes'
    )
    expect(() => finalize(legacyWrongBasis)).toThrow()
  })

  it('rejects exchange, source, and final closure binding drift', () => {
    const exchange = coreFixture()
    exchange.captures[0].rpc_exchanges[0].http_status = 201
    expect(() => finalize(exchange)).toThrow('RPC exchange binding')

    const source = coreFixture()
    source.captures[0].normalized_documents.current_program_observation.sha256 =
      hashText('changed observation')
    expect(() => finalize(source)).toThrow('source binding')

    const closure = finalize()
    closure.evidence_closure_sha256 = hashText('changed closure')
    expect(() => parseDexSolanaV3CurrentProgramStateEvidence(closure)).toThrow('closure hash')
  })

  it('rejects invalid root, context, effective-slot, and completion relationships', () => {
    const minimum = coreFixture()
    minimum.captures[0].requested_min_context_slot_decimal = '999'
    expect(() => finalize(minimum)).toThrow('slot relationships')

    const context = coreFixture()
    context.captures[0].accounts_context_slot_decimal = '899'
    expect(() => finalize(context)).toThrow('slot relationships')

    const selected = coreFixture()
    selected.captures[0].same_endpoint_anchor.selected_produced_slot_decimal = '1001'
    expect(() => finalize(selected)).toThrow('slot relationships')

    const unsafeJsonSlot = coreFixture()
    unsafeJsonSlot.captures[0].same_endpoint_anchor.finalized_root_slot_decimal = '9007199254740992'
    unsafeJsonSlot.captures[0].requested_min_context_slot_decimal = '9007199254740992'
    unsafeJsonSlot.captures[0].accounts_context_slot_decimal = '9007199254740992'
    expect(() => finalize(unsafeJsonSlot)).toThrow('positive JSON safe integer')

    const completion = coreFixture()
    completion.captures[0].capture_completed_at = '2026-07-18T10:00:03.000Z'
    rehashSource(completion, 0)
    expect(() => finalize(completion)).toThrow('capture lifecycle')

    const reorderedLifecycle = coreFixture()
    reorderedLifecycle.captures[0].rpc_exchanges[4].completed_at = '2026-07-18T10:00:02.000Z'
    reorderedLifecycle.captures[0].capture_completed_at = '2026-07-18T10:00:03.000Z'
    rehashSource(reorderedLifecycle, 0)
    expect(() => finalize(reorderedLifecycle)).toThrow('capture lifecycle')

    const earlyBlocks = coreFixture()
    earlyBlocks.captures[0].rpc_exchanges[2].completed_at = '2026-07-18T10:00:00.000Z'
    rehashSource(earlyBlocks, 0)
    expect(() => finalize(earlyBlocks)).toThrow('capture lifecycle')

    const generated = coreFixture()
    generated.generated_at = '2026-07-18T10:00:08.000Z'
    expect(() => finalize(generated)).toThrow('predates a source capture')
  })

  it('rejects stable-state disagreement or a source that is not bound to the common state', () => {
    const projection = coreFixture()
    projection.current_state.programdata_account.code_sha256 = hashText('different code')
    expect(() => finalize(projection)).toThrow('stable projection hash')

    const source = coreFixture()
    source.captures[1].current_state_sha256 = hashText('different current state')
    expect(() => finalize(source)).toThrow('normalized hashes do not close')
  })

  it('requires the exact blocker, claim, and authorization posture', () => {
    const blocker = coreFixture()
    blocker.required_blockers.pop()
    expect(() => finalize(blocker)).toThrow('exact canonical set')

    const claim = coreFixture()
    Reflect.set(claim.claims, 'provider_independence_verified', true)
    expect(() => finalize(claim)).toThrow()

    const authorized = coreFixture()
    Reflect.set(authorized.authorization, 'serving', true)
    expect(() => finalize(authorized)).toThrow()
  })

  it('rejects extra fields, accessors, exotic objects, and a forged stable contract before hashing', () => {
    const extra = coreFixture() as DexSolanaV3CurrentProgramStateEvidenceCore &
      Record<string, unknown>
    extra.endpoint_url = 'https://example.test'
    expect(() => finalize(extra)).toThrow()

    const accessor = coreFixture() as DexSolanaV3CurrentProgramStateEvidenceCore &
      Record<string, unknown>
    let getterCalls = 0
    Object.defineProperty(accessor, 'endpoint_url', {
      enumerable: true,
      get() {
        getterCalls += 1
        return 'https://example.test'
      },
    })
    expect(() => finalize(accessor)).toThrow('object accessors')
    expect(getterCalls).toBe(0)

    const exotic = Object.assign(Object.create({ inherited: true }), coreFixture())
    expect(() => finalizeDexSolanaV3CurrentProgramStateEvidence(exotic)).toThrow(
      'non-plain objects'
    )

    const contract = coreFixture()
    Reflect.set(contract, 'current_state_contract', 'arena.dex.other@1')
    expect(() => finalize(contract)).toThrow()
  })

  it('parses the normalized Observation before applying its document hash contract', () => {
    expect(() => dexSolanaV3CurrentProgramObservationDocumentSha256({})).toThrow()

    const extra = observationFixture() as SolanaV3ProgramDeploymentObservation &
      Record<string, unknown>
    extra.endpoint = 'solana_official_mainnet'
    expect(() => dexSolanaV3CurrentProgramObservationDocumentSha256(extra)).toThrow()

    const staleContext = observationFixture()
    staleContext.accounts_context_slot_decimal = '899'
    expect(() => dexSolanaV3CurrentProgramObservationDocumentSha256(staleContext)).toThrow(
      'context predates'
    )
  })

  it('does not let a valid closure authorize network, persistence, serving, rank, or score', () => {
    const evidence: DexSolanaV3CurrentProgramStateEvidence = finalize()
    expect(evidence.authorization).toEqual({
      network_execution: false,
      raw_blob_persistence: false,
      decoder_fixture: false,
      serving: false,
      rank: false,
      score: false,
    })
    expect(evidence.required_blockers).toEqual([
      ...DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_REQUIRED_BLOCKERS,
    ])
  })
})
