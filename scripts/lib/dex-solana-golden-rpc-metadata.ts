import { createHash } from 'node:crypto'
import { isUint8Array } from 'node:util/types'

import {
  SOLANA_MAINNET_GENESIS_HASH,
  requireSolanaVerifiedChainAnchor,
  type SolanaRawRpcEvidenceExchange,
  type SolanaVerifiedChainAnchor,
  type SolanaVerifiedChainAnchorRawCapture,
} from '../../lib/ingest/onchain/solana-evidence'
import {
  RAW_RPC_REQUEST_HASH_BASIS,
  RAW_RPC_RESPONSE_HASH_BASIS,
} from '../../lib/ingest/onchain/raw-rpc-evidence'
import { parseStrictJson } from '../../lib/ingest/onchain/strict-json'
import {
  requireSolanaVerifiedTransactionFinality,
  type SolanaVerifiedTransactionFinality,
  type SolanaVerifiedTransactionFinalityRawCapture,
} from '../../lib/ingest/onchain/solana-transaction-evidence'
import { strictCanonicalJson } from './dex-contract-hash'
import {
  DEX_GOLDEN_RPC_EVIDENCE_CONTRACT,
  DEX_GOLDEN_RPC_EVIDENCE_SCHEMA_VERSION,
  DEX_GOLDEN_RPC_REQUIRED_BLOCKERS,
  DEX_SOLANA_GOLDEN_RPC_LANES,
  dexGoldenRemoteEndpointIdentity,
  dexGoldenRpcExchangeBindingSha256,
  dexGoldenRpcParamsSha256,
  parseDexGoldenRpcEvidence,
  type DexGoldenRpcCapture,
  type DexGoldenRpcEvidence,
  type DexGoldenRpcExchange,
} from './dex-golden-rpc-evidence'
import {
  DEX_SOLANA_STABLE_TRANSACTION_FACTS_CONTRACT,
  buildDexSolanaStableTransactionFacts,
  dexSolanaStableTransactionFactsSha256,
} from './dex-golden-transaction-facts'
import {
  dexSolanaProgramHitProjectionSha256,
  projectDexSolanaProgramHits,
  type DexSolanaProgramHitProjection,
} from './dex-solana-program-hit-projection'

const ALLOWED_ENDPOINT_IDS = ['publicnode_solana_mainnet', 'solana_official_mainnet'] as const
const CREDENTIAL_KEY_NAMES = new Set([
  'apikey',
  'authorization',
  'accesstoken',
  'authtoken',
  'bearertoken',
  'clientsecret',
  'credential',
  'credentials',
  'jwt',
  'password',
  'privatekey',
  'secret',
])
const SECRET_TEXT_PATTERNS = [
  /\bbearer\s+[a-z0-9._~+/-]{8,}=*/iu,
  /\beyJ[a-z0-9_-]{5,}\.[a-z0-9_-]{5,}\.[a-z0-9_-]{5,}\b/iu,
  /\b(?:pk|rk|sk)_live_[a-z0-9]{8,}\b/iu,
  /[?&](?:api[-_]?key|apikey|access[-_]?token|auth(?:orization)?|client[-_]?secret|password|private[-_]?key|secret)=[^&#\s]+/iu,
  /\b(?:authorization|x-api-key|api-key)\s*[:=]\s*[^\s,;]{8,}/iu,
] as const
const SHA256 = /^[0-9a-f]{64}$/
const TYPED_ARRAY_FILL = Uint8Array.prototype.fill
const TYPED_ARRAY_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  'length'
)?.get

type AllowedEndpointId = (typeof ALLOWED_ENDPOINT_IDS)[number]

export interface DexSolanaGoldenRpcMetadataCaptureInput {
  anchor: SolanaVerifiedChainAnchorRawCapture
  transaction: SolanaVerifiedTransactionFinalityRawCapture
}

export interface DexSolanaGoldenRpcMetadataInput {
  generated_at: string
  captures: readonly [
    DexSolanaGoldenRpcMetadataCaptureInput,
    DexSolanaGoldenRpcMetadataCaptureInput,
  ]
}

export interface DexSolanaGoldenRpcMetadataWithProgramHitsInput {
  metadata_input: DexSolanaGoldenRpcMetadataInput
  target_program_id: string
}

export interface DexSolanaGoldenRpcProgramHitSourceDerivation {
  endpoint: DexGoldenRpcCapture['endpoint']
  capture_completed_at: string
  transaction_exchange_binding_sha256: string
  transaction_response_sha256: string
  program_hit_projection_sha256: string
}

export interface DexSolanaGoldenRpcCommonTransactionMembership {
  stable_transaction_facts_sha256: string
  canonical_blockhash: string
  transaction_index: number
}

export interface DexSolanaGoldenRpcMetadataWithProgramHits {
  golden_rpc_evidence: DexGoldenRpcEvidence
  common_transaction_membership: DexSolanaGoldenRpcCommonTransactionMembership
  common_program_hit_projection: DexSolanaProgramHitProjection
  common_program_hit_projection_sha256: string
  source_derivations: readonly [
    DexSolanaGoldenRpcProgramHitSourceDerivation,
    DexSolanaGoldenRpcProgramHitSourceDerivation,
  ]
}

interface VerifiedCapture {
  endpointId: AllowedEndpointId
  anchor: SolanaVerifiedChainAnchor
  transaction: SolanaVerifiedTransactionFinality
  anchorDocument: unknown
  membershipDocument: unknown
  rawExchanges: SolanaRawRpcEvidenceExchange[]
}

interface CompiledCapture {
  metadata: DexGoldenRpcCapture
  transactionResult: unknown
  verifiedTransaction: SolanaVerifiedTransactionFinality
}

interface CompiledMetadata {
  evidence: DexGoldenRpcEvidence
  captures: readonly [CompiledCapture, CompiledCapture]
}

interface EphemeralByteScope {
  track<T extends Uint8Array>(bytes: T): T
}

function invalid(reason: string): never {
  throw new TypeError(`invalid Solana golden RPC metadata input: ${reason}`)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertExactRecord(
  value: unknown,
  keys: readonly string[],
  label: string
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) invalid(`${label} must be a plain object`)
  const ownKeys = Reflect.ownKeys(value)
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    invalid(`${label} has an unexpected shape`)
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      invalid(`${label} must contain enumerable data properties`)
    }
  }
}

function canonicalTimestampMs(value: unknown, label: string): number {
  if (typeof value !== 'string') invalid(`${label} must be a canonical timestamp`)
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    invalid(`${label} must be a canonical timestamp`)
  }
  return parsed
}

function credentialKeyName(key: string): boolean {
  return CREDENTIAL_KEY_NAMES.has(key.replace(/[-_\s]/gu, '').toLowerCase())
}

function assertSafeText(text: string): void {
  if (SECRET_TEXT_PATTERNS.some((pattern) => pattern.test(text))) {
    invalid('credential-like text is forbidden')
  }
}

function assertNoCredentialMaterial(value: unknown, seen = new Set<object>()): void {
  if (typeof value === 'string') {
    assertSafeText(value)
    return
  }
  if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value)) return
  if (seen.has(value)) return
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') invalid('symbol keys are forbidden')
    if (credentialKeyName(key)) invalid('credential-named keys are forbidden')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) invalid('accessor properties are forbidden')
    assertNoCredentialMaterial(descriptor.value, seen)
  }
}

function byteView(value: unknown): Uint8Array | null {
  return isUint8Array(value) ? value : null
}

function intrinsicByteLength(bytes: Uint8Array): number {
  if (!TYPED_ARRAY_LENGTH_GETTER) invalid('TypedArray length intrinsic is unavailable')
  const length: unknown = Reflect.apply(TYPED_ARRAY_LENGTH_GETTER, bytes, [])
  if (!Number.isSafeInteger(length) || Number(length) < 0) {
    invalid('raw byte array has an invalid internal length')
  }
  return Number(length)
}

function collectByteArrays(
  value: unknown,
  arrays: Set<Uint8Array>,
  seen = new Set<object>()
): void {
  const bytes = byteView(value)
  if (bytes) {
    arrays.add(bytes)
    return
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) return
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor && 'value' in descriptor) collectByteArrays(descriptor.value, arrays, seen)
  }
}

function zeroByteArrays(arrays: Iterable<Uint8Array>): void {
  let failed = false
  for (const bytes of arrays) {
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
  if (failed) invalid('ephemeral byte arrays could not all be zeroed')
}

function withOwnedBytes<T>(root: unknown, operation: (scope: EphemeralByteScope) => T): T {
  const byteArrays = new Set<Uint8Array>()
  const scope: EphemeralByteScope = {
    track<TBytes extends Uint8Array>(bytes: TBytes): TBytes {
      byteArrays.add(bytes)
      return bytes
    },
  }
  try {
    collectByteArrays(root, byteArrays)
    return operation(scope)
  } finally {
    zeroByteArrays(byteArrays)
  }
}

function decodeStrictJson(bytes: Uint8Array, label: string): unknown {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return invalid(`${label} is not valid UTF-8`)
  }
  assertSafeText(text)
  let parsed: unknown
  try {
    parsed = parseStrictJson(text)
  } catch {
    return invalid(`${label} is not strict JSON`)
  }
  assertNoCredentialMaterial(parsed)
  return parsed
}

function sameJson(left: unknown, right: unknown): boolean {
  return strictCanonicalJson(left) === strictCanonicalJson(right)
}

function assertEndpointMatches(
  exchange: SolanaRawRpcEvidenceExchange,
  anchor: SolanaVerifiedChainAnchor
): void {
  if (
    exchange.endpoint.providerId !== anchor.endpoint.providerId ||
    exchange.endpoint.endpointId !== anchor.endpoint.endpointId ||
    exchange.endpoint.connectionHash !== anchor.endpoint.connectionHash
  ) {
    invalid('raw RPC endpoint does not match its verified anchor')
  }
}

function parseRequest(
  exchange: SolanaRawRpcEvidenceExchange,
  expectedMethod: string,
  expectedParams: unknown
): { method: string; params: unknown } {
  const request = decodeStrictJson(exchange.request.bytes, 'raw RPC request')
  assertExactRecord(request, ['jsonrpc', 'id', 'method', 'params'], 'JSON-RPC request')
  if (
    request.jsonrpc !== '2.0' ||
    request.id !== 1 ||
    request.method !== expectedMethod ||
    !Array.isArray(request.params) ||
    !sameJson(request.params, expectedParams)
  ) {
    invalid('raw RPC request method or params do not match the verified evidence')
  }
  return { method: request.method, params: request.params }
}

function parseResponse(exchange: SolanaRawRpcEvidenceExchange): unknown {
  const response = decodeStrictJson(exchange.response.bytes, 'raw RPC response')
  assertExactRecord(response, ['jsonrpc', 'id', 'result'], 'JSON-RPC response')
  if (response.jsonrpc !== '2.0' || response.id !== 1 || !Object.hasOwn(response, 'result')) {
    invalid('raw RPC response is not a successful JSON-RPC result')
  }
  return response.result
}

function assertRecordFields(
  value: unknown,
  expected: Record<string, unknown>,
  label: string
): void {
  if (!isPlainRecord(value)) invalid(`${label} is not an object`)
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (!Object.hasOwn(value, key) || !sameJson(value[key], expectedValue)) {
      invalid(`${label} does not match normalized evidence`)
    }
  }
}

function assertRawResultBinding(
  lane: string,
  result: unknown,
  anchor: SolanaVerifiedChainAnchor,
  transaction: SolanaVerifiedTransactionFinality
): void {
  if (lane === 'genesis_hash') {
    if (result !== SOLANA_MAINNET_GENESIS_HASH) invalid('genesis result does not match evidence')
    return
  }
  if (lane === 'finalized_anchor_slot') {
    if (result !== anchor.finalizedRootSlot)
      invalid('finalized root result does not match evidence')
    return
  }
  if (lane === 'finalized_anchor_produced_slots') {
    if (!sameJson(result, anchor.producedSlotResolution.producedSlots)) {
      invalid('produced-slot result does not match evidence')
    }
    return
  }
  if (lane === 'finalized_anchor_block') {
    const block = anchor.finalizedBlock
    assertRecordFields(
      result,
      {
        blockhash: block.blockhash,
        previousBlockhash: block.previousBlockhash,
        parentSlot: block.parentSlot,
        blockTime: block.blockTime,
        blockHeight: block.blockHeight,
      },
      'finalized anchor block result'
    )
    return
  }
  if (lane === 'transaction') {
    const normalized = transaction.transaction
    assertRecordFields(
      result,
      {
        slot: normalized.slot,
        blockTime: normalized.blockTime,
        version: normalized.version,
      },
      'transaction result'
    )
    if (!isPlainRecord(result)) invalid('transaction result is not an object')
    assertRecordFields(
      result.transaction,
      { signatures: normalized.signatures },
      'transaction signature result'
    )
    assertRecordFields(
      result.meta,
      { err: normalized.err, status: normalized.status },
      'transaction metadata result'
    )
    if (
      normalized.reportedTransactionIndex === null
        ? Object.hasOwn(result, 'transactionIndex')
        : result.transactionIndex !== normalized.reportedTransactionIndex
    ) {
      invalid('transaction index result does not match evidence')
    }
    return
  }
  if (lane === 'signature_status') {
    const normalized = transaction.signatureStatus
    if (!isPlainRecord(result)) invalid('signature status result is not an object')
    assertRecordFields(result.context, { slot: normalized.contextSlot }, 'signature status context')
    if (!Array.isArray(result.value) || result.value.length !== 1) {
      invalid('signature status result does not contain one row')
    }
    assertRecordFields(
      result.value[0],
      {
        slot: normalized.slot,
        confirmations: null,
        confirmationStatus: 'finalized',
        err: normalized.err,
        status: normalized.status,
      },
      'signature status row'
    )
    return
  }
  if (lane === 'membership_block') {
    const block = transaction.canonicalBlock
    assertRecordFields(
      result,
      {
        blockhash: block.blockhash,
        previousBlockhash: block.previousBlockhash,
        parentSlot: block.parentSlot,
        blockTime: block.blockTime,
        blockHeight: block.blockHeight,
        signatures: block.signatures,
      },
      'membership block result'
    )
    return
  }
  invalid('unknown raw RPC lane')
}

function bodyMetadata(
  body: SolanaRawRpcEvidenceExchange['request'] | SolanaRawRpcEvidenceExchange['response'],
  kind: 'request'
): DexGoldenRpcExchange['request']
function bodyMetadata(
  body: SolanaRawRpcEvidenceExchange['request'] | SolanaRawRpcEvidenceExchange['response'],
  kind: 'response'
): DexGoldenRpcExchange['response']
function bodyMetadata(
  body: SolanaRawRpcEvidenceExchange['request'] | SolanaRawRpcEvidenceExchange['response'],
  kind: 'request' | 'response'
): DexGoldenRpcExchange['request'] | DexGoldenRpcExchange['response'] {
  const bytes = byteView(body.bytes)
  if (!bytes) invalid(`raw RPC ${kind} bytes are missing`)
  const byteLength = intrinsicByteLength(bytes)
  if (byteLength < 1) invalid(`raw RPC ${kind} bytes are missing`)
  const actualSha256 = createHash('sha256').update(bytes).digest('hex')
  if (!SHA256.test(body.sha256) || body.sha256 !== actualSha256 || body.byteLength !== byteLength) {
    invalid(`raw RPC ${kind} hash or byte length is forged`)
  }
  const hashBasis = kind === 'request' ? RAW_RPC_REQUEST_HASH_BASIS : RAW_RPC_RESPONSE_HASH_BASIS
  if (body.hashBasis !== hashBasis) invalid(`raw RPC ${kind} hash basis is invalid`)
  const shared = {
    sha256: actualSha256,
    byte_length: byteLength,
    media_type: 'application/json' as const,
    persistence_state: 'not_persisted' as const,
    content_available_for_replay: false as const,
    contains_secrets: false as const,
  }
  return kind === 'request'
    ? { ...shared, hash_basis: RAW_RPC_REQUEST_HASH_BASIS }
    : { ...shared, hash_basis: RAW_RPC_RESPONSE_HASH_BASIS }
}

function expectedParams(
  lane: string,
  anchor: SolanaVerifiedChainAnchor,
  transaction: SolanaVerifiedTransactionFinality
): unknown[] {
  switch (lane) {
    case 'genesis_hash':
      return []
    case 'finalized_anchor_slot':
      return [{ commitment: 'finalized' }]
    case 'finalized_anchor_produced_slots':
      return [
        anchor.producedSlotResolution.rangeStartSlot,
        anchor.finalizedRootSlot,
        { commitment: 'finalized', minContextSlot: anchor.finalizedRootSlot },
      ]
    case 'finalized_anchor_block':
      return [
        anchor.finalizedSlot,
        {
          commitment: 'finalized',
          encoding: 'json',
          transactionDetails: 'none',
          maxSupportedTransactionVersion: 0,
          rewards: false,
        },
      ]
    case 'transaction':
      return [
        transaction.signature,
        {
          commitment: 'finalized',
          encoding: 'json',
          maxSupportedTransactionVersion: 0,
        },
      ]
    case 'signature_status':
      return [[transaction.signature], { searchTransactionHistory: true }]
    case 'membership_block':
      return [
        transaction.transaction.slot,
        {
          commitment: 'finalized',
          encoding: 'json',
          transactionDetails: 'signatures',
          rewards: false,
        },
      ]
    default:
      return invalid('unknown raw RPC lane')
  }
}

function normalizedDocument(value: unknown, scope: EphemeralByteScope) {
  const body = strictCanonicalJson(value)
  const bytes = scope.track(new TextEncoder().encode(body))
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  return {
    sha256,
    byte_length: bytes.byteLength,
    hash_basis: 'strict_canonical_json_utf8_bytes' as const,
    persistence_state: 'not_persisted' as const,
    content_available_for_replay: false as const,
    contains_secrets: false as const,
  }
}

function endpointId(anchor: SolanaVerifiedChainAnchor): AllowedEndpointId {
  if (
    !ALLOWED_ENDPOINT_IDS.includes(anchor.endpoint.endpointId as AllowedEndpointId) ||
    anchor.endpoint.providerId !==
      dexGoldenRemoteEndpointIdentity(anchor.endpoint.endpointId as AllowedEndpointId).provider_id
  ) {
    invalid('only the two pinned credential-free public Solana endpoints are accepted')
  }
  const id = anchor.endpoint.endpointId as AllowedEndpointId
  const expected = dexGoldenRemoteEndpointIdentity(id)
  if (anchor.endpoint.connectionHash !== expected.connection_hash) {
    invalid('verified endpoint connection hash is not the pinned public origin')
  }
  return id
}

function verifyCapture(input: DexSolanaGoldenRpcMetadataCaptureInput): VerifiedCapture {
  assertExactRecord(input, ['anchor', 'transaction'], 'capture pair')
  assertExactRecord(input.anchor, ['evidence', 'verified', 'rawExchanges'], 'anchor capture')
  assertExactRecord(
    input.transaction,
    ['evidence', 'verified', 'rawExchanges'],
    'transaction capture'
  )
  if (!Array.isArray(input.anchor.rawExchanges) || input.anchor.rawExchanges.length !== 4) {
    invalid('anchor capture must contain exactly four raw exchanges')
  }
  if (
    !Array.isArray(input.transaction.rawExchanges) ||
    input.transaction.rawExchanges.length !== 3
  ) {
    invalid('transaction capture must contain exactly three raw exchanges')
  }

  // The embedded `verified` fields are deliberately ignored. Re-run both
  // strict normalized verifiers from their original evidence documents.
  const anchor = requireSolanaVerifiedChainAnchor(input.anchor.evidence)
  const transaction = requireSolanaVerifiedTransactionFinality(
    input.transaction.evidence,
    input.anchor.evidence
  )
  const id = endpointId(anchor)
  const rawExchanges = [...input.anchor.rawExchanges, ...input.transaction.rawExchanges]
  if (
    transaction.anchor.endpoint.endpointId !== id ||
    transaction.anchor.endpoint.connectionHash !== anchor.endpoint.connectionHash
  ) {
    invalid('transaction evidence is not bound to its verified anchor endpoint')
  }
  return {
    endpointId: id,
    anchor,
    transaction,
    anchorDocument: input.anchor.evidence,
    membershipDocument: input.transaction.evidence,
    rawExchanges,
  }
}

function compileCapture(capture: VerifiedCapture, scope: EphemeralByteScope): CompiledCapture {
  const completedTimes: number[] = [
    canonicalTimestampMs(capture.anchor.observedAt, 'anchor observedAt'),
    canonicalTimestampMs(capture.transaction.capturedAt, 'transaction capturedAt'),
  ]
  for (const exchange of capture.rawExchanges) {
    completedTimes.push(canonicalTimestampMs(exchange.completedAt, 'raw exchange completedAt'))
  }
  const captureCompletedAt = new Date(Math.max(...completedTimes)).toISOString()
  const endpoint = dexGoldenRemoteEndpointIdentity(capture.endpointId)
  let transactionResult: unknown
  let transactionResultObserved = false
  const rpcExchanges: DexGoldenRpcExchange[] = capture.rawExchanges.map((exchange, index) => {
    const [lane, method] = DEX_SOLANA_GOLDEN_RPC_LANES[index]
    if (
      exchange.chain !== 'solana' ||
      exchange.trustBoundary !== 'json_rpc_result_transport_only_semantic_lane_not_yet_verified' ||
      exchange.lane !== lane ||
      exchange.method !== method ||
      !Number.isSafeInteger(exchange.httpStatus) ||
      exchange.httpStatus < 200 ||
      exchange.httpStatus > 299
    ) {
      invalid('raw RPC exchanges do not use the exact canonical lane and method order')
    }
    assertEndpointMatches(exchange, capture.anchor)
    const params = expectedParams(lane, capture.anchor, capture.transaction)
    const parsedRequest = parseRequest(exchange, method, params)
    const responseResult = parseResponse(exchange)
    assertRawResultBinding(lane, responseResult, capture.anchor, capture.transaction)
    if (lane === 'transaction') {
      transactionResult = responseResult
      transactionResultObserved = true
    }
    const core = {
      lane,
      method,
      params_sha256: dexGoldenRpcParamsSha256(parsedRequest.method, parsedRequest.params),
      params_hash_basis: 'arena_dex_json_rpc_params_v1' as const,
      http_status: exchange.httpStatus,
      request: bodyMetadata(exchange.request, 'request'),
      response: bodyMetadata(exchange.response, 'response'),
    }
    return {
      ...core,
      exchange_binding_sha256: dexGoldenRpcExchangeBindingSha256({
        chain_namespace: 'solana',
        transaction_id: capture.transaction.signature,
        endpoint,
        capture_completed_at: captureCompletedAt,
        exchange: core,
      }),
    }
  })

  if (!transactionResultObserved) invalid('transaction response result is missing')
  const metadata: DexGoldenRpcCapture = {
    endpoint,
    endpoint_assertion_state: 'declared_not_replayed',
    capture_completed_at: captureCompletedAt,
    rpc_exchanges: rpcExchanges,
    normalized_documents: {
      chain_anchor: normalizedDocument(capture.anchorDocument, scope),
      transaction_membership: normalizedDocument(capture.membershipDocument, scope),
      verified_finality: normalizedDocument(capture.transaction, scope),
    },
    provider_finality_witness: {
      policy: 'solana_verified_transaction_finality_semantics_v2',
      semantic_sha256: capture.transaction.semanticHash,
    },
    stable_transaction_facts_sha256: dexSolanaStableTransactionFactsSha256(capture.transaction),
  }
  return {
    metadata,
    transactionResult,
    verifiedTransaction: capture.transaction,
  }
}

function compileInternal(
  input: DexSolanaGoldenRpcMetadataInput,
  scope: EphemeralByteScope
): CompiledMetadata {
  assertExactRecord(input, ['generated_at', 'captures'], 'compiler input')
  assertNoCredentialMaterial(input)
  canonicalTimestampMs(input.generated_at, 'generated_at')
  if (!Array.isArray(input.captures) || input.captures.length !== 2) {
    invalid('exactly two capture pairs are required')
  }

  const verified = input.captures.map(verifyCapture)
  if (verified[0].transaction.signature !== verified[1].transaction.signature) {
    invalid('both providers must verify the same public transaction signature')
  }
  const endpointIds = new Set(verified.map((capture) => capture.endpointId))
  if (endpointIds.size !== 2 || !ALLOWED_ENDPOINT_IDS.every((id) => endpointIds.has(id))) {
    invalid('the official and PublicNode Solana endpoints are both required')
  }

  const firstFacts = buildDexSolanaStableTransactionFacts(verified[0].transaction)
  const secondFacts = buildDexSolanaStableTransactionFacts(verified[1].transaction)
  const firstFactsHash = dexSolanaStableTransactionFactsSha256(verified[0].transaction)
  const secondFactsHash = dexSolanaStableTransactionFactsSha256(verified[1].transaction)
  if (!sameJson(firstFacts, secondFacts) || firstFactsHash !== secondFactsHash) {
    invalid('the two providers disagree on stable transaction facts')
  }

  const compiledCaptures = verified
    .sort((left, right) => {
      const leftEndpoint = dexGoldenRemoteEndpointIdentity(left.endpointId)
      const rightEndpoint = dexGoldenRemoteEndpointIdentity(right.endpointId)
      const leftKey = `${leftEndpoint.provider_id}:${leftEndpoint.endpoint_id}`
      const rightKey = `${rightEndpoint.provider_id}:${rightEndpoint.endpoint_id}`
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
    })
    .map((capture) => compileCapture(capture, scope))

  if (compiledCaptures.length !== 2) invalid('exactly two compiled captures are required')
  const captures = compiledCaptures as [CompiledCapture, CompiledCapture]
  const evidence = parseDexGoldenRpcEvidence({
    schema_version: DEX_GOLDEN_RPC_EVIDENCE_SCHEMA_VERSION,
    data_contract: DEX_GOLDEN_RPC_EVIDENCE_CONTRACT,
    purpose: 'phase0_shadow_finality_membership_evidence_only',
    proof_boundary:
      'same_provider_rpc_assertions_not_cryptographic_inclusion_or_protocol_hit_proof',
    verification_state: 'declared_not_replayed',
    generated_at: input.generated_at,
    chain: {
      namespace: 'solana',
      cluster: 'mainnet-beta',
      genesis_hash: SOLANA_MAINNET_GENESIS_HASH,
      product_source_slug: 'okx_web3_solana',
      chain_stream_slug: 'solana_mainnet',
    },
    transaction_id: verified[0].transaction.signature,
    stable_transaction_facts_contract: DEX_SOLANA_STABLE_TRANSACTION_FACTS_CONTRACT,
    stable_transaction_facts_sha256: firstFactsHash,
    captures: captures.map((capture) => capture.metadata),
    required_blockers: [...DEX_GOLDEN_RPC_REQUIRED_BLOCKERS],
    claims: {
      normalized_documents_replayed: false,
      provider_independence_verified: false,
      finality_membership_verified: false,
      protocol_invocation_verified: false,
      decoder_facts_verified: false,
    },
    authorization: {
      network_execution: false,
      raw_blob_persistence: false,
      decoder_fixture: false,
      serving: false,
      rank: false,
      score: false,
    },
  })
  return { evidence, captures }
}

/**
 * Compile metadata from two already captured in-memory Solana witnesses.
 *
 * No raw or normalized body is returned or persisted. Every input byte array
 * discovered before validation is overwritten in `finally`, including on
 * malformed input, verifier rejection, or secret detection.
 */
export function compileDexSolanaGoldenRpcMetadata(
  input: DexSolanaGoldenRpcMetadataInput
): DexGoldenRpcEvidence {
  return withOwnedBytes(input, (scope) => compileInternal(input, scope).evidence)
}

function sourceProgramHitDerivation(
  capture: CompiledCapture,
  targetProgramId: string
): {
  projection: DexSolanaProgramHitProjection
  source: DexSolanaGoldenRpcProgramHitSourceDerivation
} {
  const projection = projectDexSolanaProgramHits({
    signature: capture.verifiedTransaction.signature,
    target_program_id: targetProgramId,
    transaction_result: capture.transactionResult,
  })
  if (
    projection.signature !== capture.verifiedTransaction.signature ||
    projection.slot_decimal !== String(capture.verifiedTransaction.transaction.slot) ||
    projection.transaction_version !== capture.verifiedTransaction.transaction.version ||
    projection.execution_status !== capture.verifiedTransaction.executionStatus
  ) {
    invalid('program-hit projection conflicts with verified transaction finality')
  }
  const transactionExchange = capture.metadata.rpc_exchanges.find(
    (exchange) => exchange.lane === 'transaction'
  )
  if (transactionExchange === undefined) invalid('compiled transaction exchange is missing')
  const projectionSha256 = dexSolanaProgramHitProjectionSha256(projection)
  return {
    projection,
    source: {
      endpoint: { ...capture.metadata.endpoint },
      capture_completed_at: capture.metadata.capture_completed_at,
      transaction_exchange_binding_sha256: transactionExchange.exchange_binding_sha256,
      transaction_response_sha256: transactionExchange.response.sha256,
      program_hit_projection_sha256: projectionSha256,
    },
  }
}

/**
 * Compile the existing metadata-only evidence and derive one exact program-hit
 * projection from each transaction response before the owned response bytes
 * are zeroed. Parsed responses never escape this fixed derivation path.
 */
export function compileDexSolanaGoldenRpcMetadataWithProgramHits(
  input: DexSolanaGoldenRpcMetadataWithProgramHitsInput
): DexSolanaGoldenRpcMetadataWithProgramHits {
  return withOwnedBytes(input, (scope) => {
    assertExactRecord(input, ['metadata_input', 'target_program_id'], 'program-hit compiler input')
    const compiled = compileInternal(input.metadata_input, scope)
    const first = sourceProgramHitDerivation(compiled.captures[0], input.target_program_id)
    const second = sourceProgramHitDerivation(compiled.captures[1], input.target_program_id)
    const firstSha256 = first.source.program_hit_projection_sha256
    const secondSha256 = second.source.program_hit_projection_sha256
    if (firstSha256 !== secondSha256 || !sameJson(first.projection, second.projection)) {
      invalid('the two providers disagree on the complete program-hit projection')
    }
    return {
      golden_rpc_evidence: compiled.evidence,
      common_transaction_membership: {
        stable_transaction_facts_sha256: compiled.evidence.stable_transaction_facts_sha256,
        canonical_blockhash: compiled.captures[0].verifiedTransaction.canonicalBlock.blockhash,
        transaction_index: compiled.captures[0].verifiedTransaction.transactionIndex,
      },
      common_program_hit_projection: first.projection,
      common_program_hit_projection_sha256: firstSha256,
      source_derivations: [first.source, second.source],
    }
  })
}
