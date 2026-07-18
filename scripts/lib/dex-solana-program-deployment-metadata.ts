import { createHash } from 'node:crypto'
import { isProxy, isUint8Array } from 'node:util/types'

import {
  replaySolanaV3ProgramDeploymentRawCapture,
  type SolanaV3ProgramDeploymentRawCapture,
  type SolanaV3ProgramDeploymentReplayedRawCapture,
} from '../../lib/ingest/onchain/solana-program-deployment-evidence'
import {
  exactDataRecord,
  exactDenseArray,
  type SolanaRawRpcEvidenceExchange,
} from '../../lib/ingest/onchain/solana-evidence-core'
import { parseStrictJson } from '../../lib/ingest/onchain/strict-json'
import { strictCanonicalJson } from './dex-contract-hash'
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
  type DexSolanaV3CurrentProgramStateEvidence,
  type DexSolanaV3CurrentProgramStateEvidenceCore,
  type DexSolanaV3CurrentProgramStateSource,
  type DexSolanaV3CurrentProgramStateSourceCore,
  type DexSolanaV3ProgramStateRpcExchange,
  type DexSolanaV3ProgramStateRpcExchangeCore,
} from './dex-solana-v3-current-program-state-evidence'
import {
  dexGoldenRemoteEndpointIdentity,
  dexGoldenRpcParamsSha256,
} from './dex-golden-rpc-evidence'
import {
  buildDexSolanaV3StableProgramState,
  DEX_SOLANA_V3_STABLE_PROGRAM_STATE_CONTRACT,
  dexSolanaV3StableProgramStateSha256,
  type DexSolanaV3StableProgramState,
} from './dex-solana-v3-stable-program-state'

const INVALID_PREFIX = 'invalid Solana v3 current program-state compiler input:'
const ALLOWED_ENDPOINT_IDS = ['publicnode_solana_mainnet', 'solana_official_mainnet'] as const
const TYPED_ARRAY_FILL = Uint8Array.prototype.fill
const TYPED_ARRAY_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  'length'
)?.get

type AllowedEndpointId = (typeof ALLOWED_ENDPOINT_IDS)[number]

export interface DexSolanaV3ProgramStateCompilerInput {
  generated_at: string
  captures: readonly [SolanaV3ProgramDeploymentRawCapture, SolanaV3ProgramDeploymentRawCapture]
}

interface OwnedByteDiscovery {
  byteArrays: Set<Uint8Array>
  malformed: boolean
}

interface VerifiedCapture {
  endpointId: AllowedEndpointId
  replayed: SolanaV3ProgramDeploymentReplayedRawCapture
  stableState: DexSolanaV3StableProgramState
  stableStateSha256: string
}

function invalid(reason: string): never {
  throw new TypeError(`${INVALID_PREFIX} ${reason}`)
}

function collectOwnedByteArrays(value: unknown, discovery: OwnedByteDiscovery): void {
  const seen = new Set<object>()
  const worklist: unknown[] = [value]
  while (worklist.length > 0) {
    const current = worklist.pop()
    if (isUint8Array(current)) {
      // Raw byte arrays are terminal ownership leaves. Arbitrary objects that
      // callers attach to a TypedArray instance are never read or transferred.
      discovery.byteArrays.add(current)
      continue
    }
    if (typeof current !== 'object' || current === null || seen.has(current)) continue
    if (isProxy(current)) {
      discovery.malformed = true
      continue
    }
    seen.add(current)

    let keys: PropertyKey[]
    try {
      keys = Reflect.ownKeys(current)
    } catch {
      discovery.malformed = true
      continue
    }
    for (const key of keys) {
      let descriptor: PropertyDescriptor | undefined
      try {
        descriptor = Object.getOwnPropertyDescriptor(current, key)
      } catch {
        discovery.malformed = true
        continue
      }
      if (!descriptor || !('value' in descriptor)) {
        discovery.malformed = true
        continue
      }
      worklist.push(descriptor.value)
    }
  }
}

function discoverOwnedCaptureBytes(input: unknown, discovery: OwnedByteDiscovery): void {
  if (typeof input !== 'object' || input === null || isProxy(input)) {
    discovery.malformed = true
    return
  }
  let capturesDescriptor: PropertyDescriptor | undefined
  try {
    capturesDescriptor = Object.getOwnPropertyDescriptor(input, 'captures')
  } catch {
    discovery.malformed = true
    return
  }
  if (!capturesDescriptor || !('value' in capturesDescriptor)) {
    discovery.malformed = true
    return
  }
  collectOwnedByteArrays(capturesDescriptor.value, discovery)
}

function intrinsicByteLength(bytes: Uint8Array): number {
  if (!TYPED_ARRAY_LENGTH_GETTER) invalid('TypedArray length intrinsic is unavailable')
  const length: unknown = Reflect.apply(TYPED_ARRAY_LENGTH_GETTER, bytes, [])
  if (!Number.isSafeInteger(length) || Number(length) < 0) {
    invalid('raw byte array has an invalid internal length')
  }
  return Number(length)
}

function zeroAndVerifyByteArrays(byteArrays: Iterable<Uint8Array>): void {
  let failed = false
  for (const bytes of byteArrays) {
    try {
      Reflect.apply(TYPED_ARRAY_FILL, bytes, [0])
      const byteLength = intrinsicByteLength(bytes)
      for (let index = 0; index < byteLength; index += 1) {
        if (bytes[index] !== 0) {
          failed = true
          break
        }
      }
    } catch {
      failed = true
    }
  }
  if (failed) invalid('owned raw byte arrays could not all be zeroed')
}

function withOwnedCaptureBytes<T>(input: unknown, operation: () => T): T {
  const discovery: OwnedByteDiscovery = {
    byteArrays: new Set(),
    malformed: false,
  }
  try {
    discoverOwnedCaptureBytes(input, discovery)
    if (discovery.malformed) invalid('capture ownership tree is not descriptor-safe')
    return operation()
  } finally {
    zeroAndVerifyByteArrays(discovery.byteArrays)
  }
}

/**
 * Destructively clear every Uint8Array reached through own data properties
 * below the input `captures` field. Each reached byte array is a terminal
 * ownership leaf: arbitrary properties attached to that TypedArray and outer
 * sibling fields are outside the transfer. This operation is idempotent.
 */
export function disposeDexSolanaV3ProgramStateCompilerInputBytes(input: unknown): void {
  const discovery: OwnedByteDiscovery = {
    byteArrays: new Set(),
    malformed: false,
  }
  try {
    discoverOwnedCaptureBytes(input, discovery)
    if (discovery.malformed) invalid('capture ownership tree is not descriptor-safe')
  } finally {
    zeroAndVerifyByteArrays(discovery.byteArrays)
  }
}

function parseCompilerInput(input: unknown): DexSolanaV3ProgramStateCompilerInput {
  const root = exactDataRecord(input, ['generated_at', 'captures'])
  const captures = root ? exactDenseArray(root.captures) : null
  if (!root || typeof root.generated_at !== 'string' || !captures || captures.length !== 2) {
    invalid('input must contain generated_at and exactly two raw captures')
  }
  return {
    generated_at: root.generated_at,
    captures: [
      captures[0] as SolanaV3ProgramDeploymentRawCapture,
      captures[1] as SolanaV3ProgramDeploymentRawCapture,
    ],
  }
}

function endpointId(replayed: SolanaV3ProgramDeploymentReplayedRawCapture): AllowedEndpointId {
  const id = replayed.anchor.endpoint.endpointId
  if (!ALLOWED_ENDPOINT_IDS.includes(id as AllowedEndpointId)) {
    invalid('only the fixed PublicNode and Solana official endpoints are accepted')
  }
  const endpointId = id as AllowedEndpointId
  const expected = dexGoldenRemoteEndpointIdentity(endpointId)
  if (
    replayed.anchor.endpoint.providerId !== expected.provider_id ||
    replayed.anchor.endpoint.connectionHash !== expected.connection_hash
  ) {
    invalid('replayed anchor endpoint is not the pinned credential-free public origin')
  }
  return endpointId
}

function verifyCapture(input: SolanaV3ProgramDeploymentRawCapture): VerifiedCapture {
  const replayed = replaySolanaV3ProgramDeploymentRawCapture(input)
  const stableState = buildDexSolanaV3StableProgramState(replayed.observation)
  return {
    endpointId: endpointId(replayed),
    replayed,
    stableState,
    stableStateSha256: dexSolanaV3StableProgramStateSha256(stableState),
  }
}

function decodeRequestParams(exchange: SolanaRawRpcEvidenceExchange): unknown[] {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(exchange.request.bytes)
  } catch {
    return invalid('raw RPC request is not valid UTF-8')
  }
  let document: unknown
  try {
    document = parseStrictJson(text)
  } catch {
    return invalid('raw RPC request is not strict JSON')
  }
  const request = exactDataRecord(document, ['jsonrpc', 'id', 'method', 'params'])
  const params = request ? exactDenseArray(request.params) : null
  if (
    !request ||
    request.jsonrpc !== '2.0' ||
    request.id !== 1 ||
    request.method !== exchange.method ||
    !params
  ) {
    invalid('raw RPC request does not match its replayed exchange')
  }
  return params
}

function requestBodyMetadata(body: SolanaRawRpcEvidenceExchange['request']) {
  if (!isUint8Array(body.bytes)) invalid('raw RPC request bytes are unavailable')
  const byteLength = intrinsicByteLength(body.bytes)
  const sha256 = createHash('sha256').update(body.bytes).digest('hex')
  if (sha256 !== body.sha256 || byteLength !== body.byteLength) {
    invalid('raw RPC request metadata changed after replay')
  }
  return {
    sha256,
    byte_length: byteLength,
    media_type: 'application/json' as const,
    hash_basis: body.hashBasis,
    persistence_state: 'not_persisted' as const,
    content_available_for_replay: false as const,
    contains_secrets: false as const,
  }
}

function responseBodyMetadata(body: SolanaRawRpcEvidenceExchange['response']) {
  if (!isUint8Array(body.bytes)) invalid('raw RPC response bytes are unavailable')
  const byteLength = intrinsicByteLength(body.bytes)
  const sha256 = createHash('sha256').update(body.bytes).digest('hex')
  if (sha256 !== body.sha256 || byteLength !== body.byteLength) {
    invalid('raw RPC response metadata changed after replay')
  }
  return {
    sha256,
    byte_length: byteLength,
    media_type: 'application/json' as const,
    hash_basis: body.hashBasis,
    persistence_state: 'not_persisted' as const,
    content_available_for_replay: false as const,
    contains_secrets: false as const,
  }
}

function exchangeCore(
  exchange: SolanaRawRpcEvidenceExchange
): DexSolanaV3ProgramStateRpcExchangeCore {
  const params = decodeRequestParams(exchange)
  return {
    lane: exchange.lane as DexSolanaV3ProgramStateRpcExchangeCore['lane'],
    method: exchange.method,
    params_sha256: dexGoldenRpcParamsSha256(exchange.method, params),
    params_hash_basis: 'arena_dex_json_rpc_params_v1',
    http_status: exchange.httpStatus,
    completed_at: exchange.completedAt,
    request: requestBodyMetadata(exchange.request),
    response: responseBodyMetadata(exchange.response),
  }
}

function compileSource(
  capture: VerifiedCapture,
  commonStateSha256: string
): DexSolanaV3CurrentProgramStateSource {
  const { replayed } = capture
  const resolvedEndpoint = dexGoldenRemoteEndpointIdentity(capture.endpointId)
  const endpoint: DexSolanaV3CurrentProgramStateSourceCore['endpoint'] = {
    provider_id: resolvedEndpoint.provider_id,
    endpoint_id: capture.endpointId,
    connection_hash: resolvedEndpoint.connection_hash,
  }
  const programExchange = replayed.rawExchanges[4]
  const captureCompletedAt = programExchange.completedAt
  const exchanges = replayed.rawExchanges.map((rawExchange, index) => {
    const [lane, method] = DEX_SOLANA_V3_PROGRAM_STATE_RPC_LANES[index]
    if (rawExchange.lane !== lane || rawExchange.method !== method) {
      invalid('replayed raw exchanges are not in the canonical deployment lane order')
    }
    const core = exchangeCore(rawExchange)
    return {
      ...core,
      exchange_binding_sha256: dexSolanaV3ProgramStateRpcExchangeBindingSha256({
        chain_namespace: 'solana',
        program_id: capture.stableState.program_id,
        endpoint,
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

  const core: DexSolanaV3CurrentProgramStateSourceCore = {
    endpoint,
    capture_completed_at: captureCompletedAt,
    same_endpoint_anchor: {
      policy: DEX_SOLANA_VERIFIED_ANCHOR_DOCUMENT_CONTRACT,
      observed_at: replayed.anchor.observedAt,
      finalized_root_slot_decimal: String(replayed.anchor.finalizedRootSlot),
      selected_produced_slot_decimal: String(replayed.anchor.finalizedSlot),
      selected_blockhash: replayed.anchor.finalizedBlock.blockhash,
      semantic_sha256: replayed.anchor.semanticHash,
    },
    requested_min_context_slot_decimal: replayed.observation.requested_min_context_slot_decimal,
    accounts_context_slot_decimal: replayed.observation.accounts_context_slot_decimal,
    current_state_sha256: commonStateSha256,
    rpc_exchanges: exchanges,
    normalized_documents: {
      verified_anchor: {
        sha256: replayed.anchor.semanticHash,
        hash_contract: DEX_SOLANA_VERIFIED_ANCHOR_DOCUMENT_CONTRACT,
        persistence_state: 'not_persisted',
        content_available_for_replay: false,
        contains_secrets: false,
      },
      current_program_observation: {
        sha256: dexSolanaV3CurrentProgramObservationDocumentSha256(replayed.observation),
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
      program_id: capture.stableState.program_id,
      current_state_contract: DEX_SOLANA_V3_STABLE_PROGRAM_STATE_CONTRACT,
      current_state_sha256: commonStateSha256,
      source: core,
    }),
  }
}

function compileInternal(input: unknown): DexSolanaV3CurrentProgramStateEvidence {
  const parsed = parseCompilerInput(input)
  const verified = parsed.captures.map(verifyCapture)
  const endpointIds = new Set(verified.map((capture) => capture.endpointId))
  if (
    endpointIds.size !== ALLOWED_ENDPOINT_IDS.length ||
    !ALLOWED_ENDPOINT_IDS.every((id) => endpointIds.has(id))
  ) {
    invalid('both fixed PublicNode and Solana official captures are required')
  }

  const firstStateJson = strictCanonicalJson(verified[0].stableState)
  const secondStateJson = strictCanonicalJson(verified[1].stableState)
  if (
    firstStateJson !== secondStateJson ||
    verified[0].stableStateSha256 !== verified[1].stableStateSha256
  ) {
    invalid('the two fixed endpoints disagree on the complete stable program state')
  }

  const sorted = verified.sort((left, right) =>
    left.endpointId < right.endpointId ? -1 : left.endpointId > right.endpointId ? 1 : 0
  )
  const currentState = sorted[0].stableState
  const currentStateSha256 = sorted[0].stableStateSha256
  const captures = sorted.map((capture) => compileSource(capture, currentStateSha256)) as [
    DexSolanaV3CurrentProgramStateSource,
    DexSolanaV3CurrentProgramStateSource,
  ]

  const core: DexSolanaV3CurrentProgramStateEvidenceCore = {
    schema_version: DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_EVIDENCE_SCHEMA_VERSION,
    data_contract: DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_EVIDENCE_CONTRACT,
    purpose: DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_EVIDENCE_PURPOSE,
    proof_boundary: DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_EVIDENCE_PROOF_BOUNDARY,
    verification_state: DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_EVIDENCE_VERIFICATION_STATE,
    generated_at: parsed.generated_at,
    chain: {
      namespace: 'solana',
      cluster: 'mainnet-beta',
      genesis_hash: currentState.chain.genesis_hash,
    },
    program_id: currentState.program_id,
    current_state_contract: DEX_SOLANA_V3_STABLE_PROGRAM_STATE_CONTRACT,
    current_state_sha256: currentStateSha256,
    current_state: currentState,
    captures,
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
  return finalizeDexSolanaV3CurrentProgramStateEvidence(core)
}

/**
 * Compile exactly two already captured in-memory raw witnesses into a
 * metadata-only current loader-v3 state agreement.
 *
 * This function performs no network I/O. It takes ownership of every
 * Uint8Array reached through descriptor-safe container data properties below
 * `input.captures`, treating each byte array as a terminal leaf. It overwrites
 * every transferred byte array in `finally`, on success and every rejection.
 */
export function compileDexSolanaV3CurrentProgramStateEvidence(
  input: unknown
): DexSolanaV3CurrentProgramStateEvidence {
  return withOwnedCaptureBytes(input, () => compileInternal(input))
}
