/**
 * Strict, shadow-only BSC chain evidence.
 *
 * This module deliberately does not reuse the serving fetcher's permissive
 * JSON-RPC transport. Evidence must remain bound to one named endpoint, the
 * BSC mainnet genesis block, and BSC's standard economic-finality block tag.
 */

import { createHash } from 'node:crypto'

import {
  RAW_RPC_REQUEST_HASH_BASIS,
  RAW_RPC_RESPONSE_HASH_BASIS,
  encodeJsonRpcRequestBody,
  rawRpcBodyEvidence,
  readBoundedRpcResponse,
  type RawRpcBodyEvidence,
} from './raw-rpc-evidence'
import { parseStrictJson } from './strict-json'

export const BSC_MAINNET_CHAIN_ID = '0x38' as const
export const BSC_MAINNET_GENESIS_HASH =
  '0x0d21840abff46b96c84b2ac9e10e4f5cdaeb5693cb665db62a2f3b02d2d57b5b' as const

const ZERO_HASH = `0x${'0'.repeat(64)}`
// Verified against three BNB Chain public seeds on 2026-07-16. Pin every
// retained field so a correct genesis hash cannot be paired with fake fields.
const BSC_MAINNET_GENESIS_TIMESTAMP = '0x5e9da7ce'
const BSC_MAINNET_GENESIS_STATE_ROOT =
  '0x919fcc7ad870b53db0aa76eb588da06bacb6d230195100699fc928511003b422'
const BSC_MAINNET_EMPTY_TRIE_ROOT =
  '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421'
const RPC_REQUEST_ID = 1
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_TIMEOUT_MS = 120_000
const MAX_FUTURE_BLOCK_SKEW_MS = 60_000
const MAX_CURRENT_ANCHOR_LAG_MS = 900_000
const HASH_RE = /^0x[0-9a-fA-F]{64}$/
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const DATA_RE = /^0x(?:[0-9a-fA-F]{2})*$/
const QUANTITY_RE = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/
const CONNECTION_HASH_RE = /^[0-9a-f]{64}$/
const ALCHEMY_BSC_ORIGIN = 'https://bnb-mainnet.g.alchemy.com'

const CALLER_ENDPOINTS = {
  bnb_official_public_seed: {
    providerId: 'bnb_chain',
    origin: 'https://bsc-dataseed.bnbchain.org',
    allowAnyPath: false,
  },
  bnb_official_public_seed_1: {
    providerId: 'bnb_chain',
    origin: 'https://bsc-dataseed1.bnbchain.org',
    allowAnyPath: false,
  },
  bnb_official_public_seed_2: {
    providerId: 'bnb_chain',
    origin: 'https://bsc-dataseed2.bnbchain.org',
    allowAnyPath: false,
  },
  publicnode_bsc_mainnet: {
    providerId: 'publicnode',
    origin: 'https://bsc-rpc.publicnode.com',
    allowAnyPath: false,
  },
  defibit_bsc_mainnet: {
    providerId: 'defibit',
    origin: 'https://bsc-dataseed1.defibit.io',
    allowAnyPath: false,
  },
  local_bsc_node: { providerId: 'local', origin: null, allowAnyPath: false },
} as const

export type BscCallerEndpointId = keyof typeof CALLER_ENDPOINTS
export type BscEvidenceProviderId =
  | 'alchemy'
  | (typeof CALLER_ENDPOINTS)[BscCallerEndpointId]['providerId']

export interface BscEvidenceEndpointIdentity {
  providerId: BscEvidenceProviderId
  endpointId: string
  /** SHA-256 of the approved, secret-free logical RPC origin. */
  connectionHash: string
}

export interface BscEvidenceProvider {
  servedBy: BscEvidenceEndpointIdentity | null
  attempted: BscEvidenceEndpointIdentity[]
}

export type BscEvidenceUnavailableReason =
  | 'provider_unconfigured'
  | 'dependency_unavailable'
  | 'not_found'
  | 'not_found_or_unindexed'
  | 'pending'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'timeout'
  | 'transport_error'
  | 'rpc_error'
  | 'response_too_large'
  | 'malformed_response'
  | 'evidence_capture_error'
  | 'wrong_chain'
  | 'wrong_genesis'

export interface BscEvidenceAvailable<T> {
  status: 'available'
  value: T
  provider: BscEvidenceProvider
  httpStatus: number | null
}

export interface BscEvidenceUnavailable {
  status: 'unavailable'
  reason: BscEvidenceUnavailableReason
  provider: BscEvidenceProvider
  rpcCode: number | null
  httpStatus: number | null
}

export type BscEvidenceLane<T> = BscEvidenceAvailable<T> | BscEvidenceUnavailable

/**
 * A normalized JSON-RPC block-header observation. Dynamic finalized headers
 * are provider assertions; this module does not claim to RLP-rehash them.
 */
export interface BscBlockHeaderEvidence {
  number: string
  hash: string
  parentHash: string
  timestamp: string
  stateRoot: string
  transactionsRoot: string
  receiptsRoot: string
}

export interface BscChainAnchorEvidence {
  chain: { namespace: 'eip155'; reference: '56' }
  /** Local capture time; never presented as chain time. */
  observedAt: string
  finalityPolicy: {
    version: 'bsc_standard_finalized_current_v1'
    method: 'eth_getBlockByNumber'
    blockTag: 'finalized'
    headBlockTag: 'latest'
    fullTransactions: false
    maxFutureBlockSkewMs: 60_000
    maxCurrentAnchorLagMs: 900_000
  }
  chainId: BscEvidenceLane<typeof BSC_MAINNET_CHAIN_ID>
  genesisBlock: BscEvidenceLane<BscBlockHeaderEvidence>
  finalizedBlock: BscEvidenceLane<BscBlockHeaderEvidence>
  /** Diagnostic head only; it never substitutes for the finalized lane. */
  headBlock: BscEvidenceLane<BscBlockHeaderEvidence>
}

export interface BscEvidenceRpcOpts {
  /** A single actual endpoint. An endpoint ID is mandatory when this is set. */
  rpcUrl?: string
  /** Approved, non-secret identity such as `bnb_official_public_seed`; never a URL. */
  endpointId?: BscCallerEndpointId
  /** Per JSON-RPC request; capture has two sequential request rounds. */
  timeoutMs?: number
}

/**
 * Internally consistent, current endpoint observation. Dynamic headers remain
 * RPC assertions until an independent lane or cryptographic proof agrees.
 */
export interface BscVerifiedChainAnchor {
  chain: { namespace: 'eip155'; reference: '56' }
  finalityPolicy: BscChainAnchorEvidence['finalityPolicy']
  endpoint: BscEvidenceEndpointIdentity
  chainId: typeof BSC_MAINNET_CHAIN_ID
  observedAt: string
  genesisBlock: BscBlockHeaderEvidence
  finalizedBlock: BscBlockHeaderEvidence
  headBlock: BscBlockHeaderEvidence
}

export interface BscMinedTransactionEvidence {
  hash: string
  from: string
  to: string | null
  input: string
  /** Canonical raw quantity; never converted through a JS number. */
  value: string
  blockNumber: string
  blockHash: string
  transactionIndex: string
}

export interface BscReceiptLogEvidence {
  address: string
  topics: string[]
  data: string
  blockNumber: string
  transactionHash: string
  transactionIndex: string
  blockHash: string
  logIndex: string
  removed: false
}

export interface BscTransactionReceiptEvidence {
  transactionHash: string
  transactionIndex: string
  blockNumber: string
  blockHash: string
  from: string
  to: string | null
  /** `0x0` is retained finalized failure evidence, never a successful hit. */
  status: '0x0' | '0x1'
  logs: BscReceiptLogEvidence[]
}

export interface BscBlockMembershipEvidence extends BscBlockHeaderEvidence {
  /** Hash-only result from eth_getBlockByNumber(number, false). */
  transactions: string[]
}

export interface BscTransactionMembershipEvidence {
  chain: { namespace: 'eip155'; reference: '56' }
  txHash: string
  /** Local completion time; never presented as block or transaction time. */
  capturedAt: string
  membershipPolicy: {
    version: 'bsc_transaction_membership_v1'
    transactionMethod: 'eth_getTransactionByHash'
    receiptMethod: 'eth_getTransactionReceipt'
    blockMethod: 'eth_getBlockByNumber'
    indexedTransactionMethod: 'eth_getTransactionByBlockNumberAndIndex'
    fullTransactions: false
  }
  anchor: {
    endpoint: BscEvidenceEndpointIdentity
    /** SHA-256 of the full, strictly reconstructed verified anchor semantics. */
    verifiedAnchorHash: string
    verifiedAnchorHashPolicy: 'bsc_verified_anchor_semantics_v1'
    observedAt: string
    finalityPolicy: BscChainAnchorEvidence['finalityPolicy']
    finalizedBlock: BscBlockHeaderEvidence
  }
  transaction: BscEvidenceLane<BscMinedTransactionEvidence>
  receipt: BscEvidenceLane<BscTransactionReceiptEvidence>
  canonicalBlock: BscEvidenceLane<BscBlockMembershipEvidence>
  indexedTransaction: BscEvidenceLane<BscMinedTransactionEvidence>
}

/**
 * A same-provider canonical/finalized RPC assertion. This does not claim an
 * independently rehashed block header or Merkle-Patricia inclusion proof.
 */
export interface BscVerifiedTransactionFinality {
  chain: { namespace: 'eip155'; reference: '56' }
  txHash: string
  capturedAt: string
  membershipPolicy: BscTransactionMembershipEvidence['membershipPolicy']
  anchor: BscTransactionMembershipEvidence['anchor']
  transaction: BscMinedTransactionEvidence
  receipt: BscTransactionReceiptEvidence
  canonicalBlock: BscBlockMembershipEvidence
  indexedTransaction: BscMinedTransactionEvidence
}

interface BscEvidenceEndpoint {
  url: string
  identity: BscEvidenceEndpointIdentity
}

interface ParsedBscEvidenceRpcOpts {
  rpcUrl: string | undefined
  endpointId: BscCallerEndpointId | undefined
  timeoutMs: number | undefined
}

interface BscRpcSuccess {
  ok: true
  result: unknown
  provider: BscEvidenceProvider
  httpStatus: number | null
  /** Present only for an explicit in-memory raw capture request. */
  rawExchange?: BscRawRpcEvidenceExchange
}

interface BscRpcFailure {
  ok: false
  reason: Exclude<
    BscEvidenceUnavailableReason,
    | 'provider_unconfigured'
    | 'dependency_unavailable'
    | 'not_found'
    | 'not_found_or_unindexed'
    | 'pending'
    | 'wrong_chain'
    | 'wrong_genesis'
  >
  provider: BscEvidenceProvider
  rpcCode: number | null
  httpStatus: number | null
}

type BscRpcResult = BscRpcSuccess | BscRpcFailure

export const BSC_RAW_RPC_EVIDENCE_LANES = [
  'chain_identity',
  'genesis_block',
  'finalized_anchor_block',
  'head_diagnostic_block',
  'transaction',
  'receipt',
  'membership_block',
  'indexed_transaction',
] as const

export type BscRawRpcEvidenceLane = (typeof BSC_RAW_RPC_EVIDENCE_LANES)[number]

const BSC_RAW_RPC_LANE_METHODS: Record<BscRawRpcEvidenceLane, string> = {
  chain_identity: 'eth_chainId',
  genesis_block: 'eth_getBlockByNumber',
  finalized_anchor_block: 'eth_getBlockByNumber',
  head_diagnostic_block: 'eth_getBlockByNumber',
  transaction: 'eth_getTransactionByHash',
  receipt: 'eth_getTransactionReceipt',
  membership_block: 'eth_getBlockByNumber',
  indexed_transaction: 'eth_getTransactionByBlockNumberAndIndex',
}

export interface BscRawRpcEvidenceExchange {
  chain: 'bsc'
  trustBoundary: 'json_rpc_result_transport_only_semantic_lane_not_yet_verified'
  lane: BscRawRpcEvidenceLane
  method: string
  endpoint: BscEvidenceEndpointIdentity
  httpStatus: number
  completedAt: string
  request: RawRpcBodyEvidence & {
    hashBasis: typeof RAW_RPC_REQUEST_HASH_BASIS
  }
  response: RawRpcBodyEvidence & {
    hashBasis: typeof RAW_RPC_RESPONSE_HASH_BASIS
  }
}

interface BscRawRpcCapture {
  lane: BscRawRpcEvidenceLane
}

function endpointCopy(endpoint: BscEvidenceEndpointIdentity): BscEvidenceEndpointIdentity {
  return {
    providerId: endpoint.providerId,
    endpointId: endpoint.endpointId,
    connectionHash: endpoint.connectionHash,
  }
}

function endpointConnectionHash(providerId: string, endpointId: string, rpcOrigin: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['bsc_evidence_connection_v1', providerId, endpointId, rpcOrigin]))
    .digest('hex')
}

function verifiedChainAnchorHash(anchor: BscVerifiedChainAnchor): string {
  const headerFields = (header: BscBlockHeaderEvidence): string[] => [
    header.number,
    header.hash,
    header.parentHash,
    header.timestamp,
    header.stateRoot,
    header.transactionsRoot,
    header.receiptsRoot,
  ]
  const semanticFields = [
    'bsc_verified_anchor_semantics_v1',
    anchor.chain.namespace,
    anchor.chain.reference,
    anchor.finalityPolicy.version,
    anchor.finalityPolicy.method,
    anchor.finalityPolicy.blockTag,
    anchor.finalityPolicy.headBlockTag,
    anchor.finalityPolicy.fullTransactions,
    anchor.finalityPolicy.maxFutureBlockSkewMs,
    anchor.finalityPolicy.maxCurrentAnchorLagMs,
    anchor.endpoint.providerId,
    anchor.endpoint.endpointId,
    anchor.endpoint.connectionHash,
    anchor.chainId,
    anchor.observedAt,
    ...headerFields(anchor.genesisBlock),
    ...headerFields(anchor.finalizedBlock),
    ...headerFields(anchor.headBlock),
  ]
  return createHash('sha256').update(JSON.stringify(semanticFields)).digest('hex')
}

function providerEvidence(
  servedBy: BscEvidenceEndpointIdentity | null,
  attempted: BscEvidenceEndpointIdentity[]
): BscEvidenceProvider {
  return {
    servedBy: servedBy ? endpointCopy(servedBy) : null,
    attempted: attempted.map(endpointCopy),
  }
}

function parseOpts(input: BscEvidenceRpcOpts): ParsedBscEvidenceRpcOpts {
  if (!isRecord(input)) throw new TypeError('BSC evidence options must be a plain object')
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('BSC evidence options must be a plain object')
  }
  const allowedKeys = new Set(['rpcUrl', 'endpointId', 'timeoutMs'])
  const ownKeys = Reflect.ownKeys(input)
  if (ownKeys.some((key) => typeof key !== 'string' || !allowedKeys.has(key))) {
    throw new TypeError('BSC evidence options contain an unknown field')
  }
  const readDataProperty = (key: 'rpcUrl' | 'endpointId' | 'timeoutMs'): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor) return undefined
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('BSC evidence options must use enumerable data properties')
    }
    return descriptor.value
  }
  const rpcUrl = readDataProperty('rpcUrl')
  const endpointId = readDataProperty('endpointId')
  const timeoutMs = readDataProperty('timeoutMs')
  if (rpcUrl !== undefined && typeof rpcUrl !== 'string') {
    throw new TypeError('rpcUrl must be a string')
  }
  if (endpointId !== undefined && typeof endpointId !== 'string') {
    throw new TypeError('endpointId must be an approved identifier')
  }
  if (endpointId !== undefined && !Object.hasOwn(CALLER_ENDPOINTS, endpointId)) {
    throw new TypeError('endpointId must be an approved identifier')
  }
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > MAX_TIMEOUT_MS)
  ) {
    throw new RangeError(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`)
  }
  if (rpcUrl === undefined && endpointId !== undefined) {
    throw new TypeError('endpointId is only valid with rpcUrl')
  }
  return {
    rpcUrl,
    endpointId: endpointId as BscCallerEndpointId | undefined,
    timeoutMs,
  }
}

function parseOptsOrThrow(input: BscEvidenceRpcOpts): ParsedBscEvidenceRpcOpts {
  try {
    return parseOpts(input)
  } catch {
    throw new TypeError('invalid BSC evidence options')
  }
}

function resolveEndpoint(opts: ParsedBscEvidenceRpcOpts): BscEvidenceEndpoint | null {
  if (opts.rpcUrl !== undefined) {
    if (!opts.endpointId || opts.rpcUrl.length === 0 || opts.rpcUrl.trim() !== opts.rpcUrl) {
      return null
    }
    try {
      const parsed = new URL(opts.rpcUrl)
      if (parsed.username || parsed.password || parsed.hash) return null
      const config = CALLER_ENDPOINTS[opts.endpointId]
      if (opts.endpointId === 'local_bsc_node') {
        if (
          !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
          (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
          parsed.pathname !== '/' ||
          parsed.search.length > 0
        ) {
          return null
        }
      } else if (
        parsed.protocol !== 'https:' ||
        parsed.origin !== config.origin ||
        (!config.allowAnyPath &&
          (parsed.pathname !== '/' || parsed.search.length > 0 || parsed.hash.length > 0))
      ) {
        return null
      }
      return {
        url: opts.rpcUrl,
        identity: {
          providerId: config.providerId,
          endpointId: opts.endpointId,
          connectionHash: endpointConnectionHash(config.providerId, opts.endpointId, parsed.origin),
        },
      }
    } catch {
      return null
    }
  }

  const key = process.env.ALCHEMY_API_KEY
  if (!key || key.trim().length === 0) return null
  return {
    url: `${ALCHEMY_BSC_ORIGIN}/v2/${encodeURIComponent(key)}`,
    identity: {
      providerId: 'alchemy',
      endpointId: 'alchemy_bnb_mainnet',
      connectionHash: endpointConnectionHash('alchemy', 'alchemy_bnb_mainnet', ALCHEMY_BSC_ORIGIN),
    },
  }
}

function normalizedHttpStatus(response: Response): number | null {
  return Number.isSafeInteger(response.status) && response.status >= 0 ? response.status : null
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Failure evidence intentionally excludes transport details.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function quotaMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return normalized.includes('quota') || normalized.includes('monthly capacity')
}

function rateLimitMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('429') ||
    normalized.includes('rate limit') ||
    normalized.includes('throughput')
  )
}

function timeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const normalized = error.message.toLowerCase()
  return (
    error.name === 'AbortError' || normalized.includes('aborted') || normalized.includes('timeout')
  )
}

function endpointSecretFragments(endpoint: BscEvidenceEndpoint): string[] | null {
  if (endpoint.identity.endpointId !== 'alchemy_bnb_mainnet') return []
  try {
    const parsed = new URL(endpoint.url)
    const encoded = parsed.pathname.split('/').filter(Boolean).at(-1) ?? ''
    let decoded = ''
    try {
      decoded = decodeURIComponent(encoded)
    } catch {
      // The encoded credential is still a secret and remains scannable.
    }
    return [
      ...new Set(
        [encoded, decoded, decoded ? encodeURIComponent(decoded) : ''].filter(
          (candidate) => candidate.length > 0
        )
      ),
    ]
  } catch {
    return null
  }
}

function parseRawCapture(value: unknown): BscRawRpcCapture | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new TypeError('invalid BSC raw RPC evidence capture')
  const prototype = Object.getPrototypeOf(value)
  const keys = Reflect.ownKeys(value)
  const laneDescriptor = Object.getOwnPropertyDescriptor(value, 'lane')
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== 1 ||
    keys[0] !== 'lane' ||
    !laneDescriptor ||
    !laneDescriptor.enumerable ||
    !('value' in laneDescriptor) ||
    typeof laneDescriptor.value !== 'string' ||
    !BSC_RAW_RPC_EVIDENCE_LANES.includes(laneDescriptor.value as BscRawRpcEvidenceLane)
  ) {
    throw new TypeError('invalid BSC raw RPC evidence capture')
  }
  return { lane: laneDescriptor.value as BscRawRpcEvidenceLane }
}

function rpcFailure(
  endpoint: BscEvidenceEndpointIdentity,
  reason: BscRpcFailure['reason'],
  rpcCode: number | null = null,
  httpStatus: number | null = null
): BscRpcFailure {
  return {
    ok: false,
    reason,
    provider: providerEvidence(null, [endpoint]),
    rpcCode,
    httpStatus,
  }
}

async function bscEvidenceRpc(
  endpoint: BscEvidenceEndpoint,
  method: string,
  params: unknown[],
  timeoutMs: number,
  rawCapture?: BscRawRpcCapture
): Promise<BscRpcResult> {
  let parsedRawCapture: BscRawRpcCapture | undefined
  try {
    parsedRawCapture = parseRawCapture(rawCapture)
  } catch {
    throw new TypeError('invalid BSC raw RPC evidence capture')
  }
  if (parsedRawCapture && BSC_RAW_RPC_LANE_METHODS[parsedRawCapture.lane] !== method) {
    throw new TypeError('invalid BSC raw RPC evidence capture')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const requestBody = encodeJsonRpcRequestBody(RPC_REQUEST_ID, method, params)
    const response = await fetch(endpoint.url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: requestBody.text,
      signal: controller.signal,
    })
    const httpStatus = normalizedHttpStatus(response)
    if (httpStatus === 429) {
      await discardResponseBody(response)
      return rpcFailure(endpoint.identity, 'rate_limited', null, httpStatus)
    }
    if (httpStatus === 402) {
      await discardResponseBody(response)
      return rpcFailure(endpoint.identity, 'quota_exhausted', null, httpStatus)
    }
    if (httpStatus !== null && (httpStatus < 200 || httpStatus >= 300)) {
      await discardResponseBody(response)
      return rpcFailure(endpoint.identity, 'rpc_error', null, httpStatus)
    }

    const responseText = await readBoundedRpcResponse(
      response,
      MAX_RESPONSE_BYTES,
      parsedRawCapture !== undefined
    )
    if (!responseText.ok) {
      return rpcFailure(
        endpoint.identity,
        responseText.reason === 'raw_capture_unavailable'
          ? 'evidence_capture_error'
          : responseText.reason,
        null,
        httpStatus
      )
    }
    let payload: unknown
    try {
      payload = responseText.text ? parseStrictJson(responseText.text) : null
    } catch {
      return rpcFailure(endpoint.identity, 'malformed_response', null, httpStatus)
    }
    if (!isRecord(payload)) {
      return rpcFailure(endpoint.identity, 'malformed_response', null, httpStatus)
    }

    const hasResult = Object.hasOwn(payload, 'result')
    const hasError = Object.hasOwn(payload, 'error')
    if (payload.jsonrpc !== '2.0' || payload.id !== RPC_REQUEST_ID || hasResult === hasError) {
      return rpcFailure(endpoint.identity, 'malformed_response', null, httpStatus)
    }
    if (hasError) {
      if (
        !isRecord(payload.error) ||
        !Number.isSafeInteger(payload.error.code) ||
        typeof payload.error.message !== 'string'
      ) {
        return rpcFailure(endpoint.identity, 'malformed_response', null, httpStatus)
      }
      const rpcCode = Number(payload.error.code)
      const message = payload.error.message
      if (quotaMessage(message)) {
        return rpcFailure(endpoint.identity, 'quota_exhausted', rpcCode, httpStatus)
      }
      if (rateLimitMessage(message)) {
        return rpcFailure(endpoint.identity, 'rate_limited', rpcCode, httpStatus)
      }
      return rpcFailure(endpoint.identity, 'rpc_error', rpcCode, httpStatus)
    }

    let rawExchange: BscRawRpcEvidenceExchange | undefined
    if (parsedRawCapture) {
      if (httpStatus === null || responseText.bytes === null) {
        return rpcFailure(endpoint.identity, 'evidence_capture_error', null, httpStatus)
      }
      const secretFragments = endpointSecretFragments(endpoint)
      if (
        secretFragments === null ||
        secretFragments.some(
          (secret) => requestBody.text.includes(secret) || responseText.text.includes(secret)
        )
      ) {
        return rpcFailure(endpoint.identity, 'evidence_capture_error', null, httpStatus)
      }
      rawExchange = {
        chain: 'bsc',
        trustBoundary: 'json_rpc_result_transport_only_semantic_lane_not_yet_verified',
        lane: parsedRawCapture.lane,
        method,
        endpoint: endpointCopy(endpoint.identity),
        httpStatus,
        completedAt: new Date().toISOString(),
        request: {
          ...requestBody.evidence,
          hashBasis: RAW_RPC_REQUEST_HASH_BASIS,
        },
        response: {
          ...rawRpcBodyEvidence(responseText.bytes),
          hashBasis: RAW_RPC_RESPONSE_HASH_BASIS,
        },
      }
    }

    return {
      ok: true,
      result: payload.result,
      provider: providerEvidence(endpoint.identity, [endpoint.identity]),
      httpStatus,
      ...(rawExchange ? { rawExchange } : {}),
    }
  } catch (error) {
    return rpcFailure(endpoint.identity, timeoutError(error) ? 'timeout' : 'transport_error')
  } finally {
    clearTimeout(timer)
  }
}

function canonicalHash(value: unknown): string | null {
  if (typeof value !== 'string' || !HASH_RE.test(value)) return null
  return value.toLowerCase()
}

function canonicalQuantity(value: unknown, maxNibbles = 64): string | null {
  if (typeof value !== 'string' || !QUANTITY_RE.test(value) || value.length - 2 > maxNibbles) {
    return null
  }
  return value.toLowerCase()
}

function canonicalAddress(value: unknown): string | null {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value)) return null
  return value.toLowerCase()
}

function canonicalData(value: unknown): string | null {
  if (typeof value !== 'string' || !DATA_RE.test(value)) return null
  return value.toLowerCase()
}

function parseMinedTransaction(value: unknown): BscMinedTransactionEvidence | null {
  if (!isRecord(value)) return null
  const hash = canonicalHash(value.hash)
  const from = canonicalAddress(value.from)
  const to = value.to === null ? null : canonicalAddress(value.to)
  const input = canonicalData(value.input)
  const rawValue = canonicalQuantity(value.value)
  const blockNumber = canonicalQuantity(value.blockNumber, 16)
  const blockHash = canonicalHash(value.blockHash)
  const transactionIndex = canonicalQuantity(value.transactionIndex, 16)
  if (
    hash === null ||
    from === null ||
    (value.to !== null && to === null) ||
    input === null ||
    rawValue === null ||
    blockNumber === null ||
    blockHash === null ||
    transactionIndex === null
  ) {
    return null
  }
  return {
    hash,
    from,
    to,
    input,
    value: rawValue,
    blockNumber,
    blockHash,
    transactionIndex,
  }
}

function isPendingTransaction(value: unknown, expectedHash: string): boolean {
  if (!isRecord(value)) return false
  const to = value.to === null ? null : canonicalAddress(value.to)
  return (
    canonicalHash(value.hash) === expectedHash &&
    canonicalAddress(value.from) !== null &&
    (value.to === null || to !== null) &&
    canonicalData(value.input) !== null &&
    canonicalQuantity(value.value) !== null &&
    value.blockNumber === null &&
    value.blockHash === null &&
    value.transactionIndex === null
  )
}

function parseReceiptLog(
  value: unknown,
  receiptIdentity: {
    transactionHash: string
    transactionIndex: string
    blockNumber: string
    blockHash: string
  }
): BscReceiptLogEvidence | null {
  if (!isRecord(value)) return null
  const address = canonicalAddress(value.address)
  const data = canonicalData(value.data)
  const blockNumber = canonicalQuantity(value.blockNumber, 16)
  const transactionHash = canonicalHash(value.transactionHash)
  const transactionIndex = canonicalQuantity(value.transactionIndex, 16)
  const blockHash = canonicalHash(value.blockHash)
  const logIndex = canonicalQuantity(value.logIndex, 16)
  if (
    address === null ||
    data === null ||
    blockNumber !== receiptIdentity.blockNumber ||
    transactionHash !== receiptIdentity.transactionHash ||
    transactionIndex !== receiptIdentity.transactionIndex ||
    blockHash !== receiptIdentity.blockHash ||
    logIndex === null ||
    value.removed !== false ||
    !Array.isArray(value.topics) ||
    value.topics.length > 4
  ) {
    return null
  }
  const topics: string[] = []
  for (let index = 0; index < value.topics.length; index += 1) {
    if (!Object.hasOwn(value.topics, index)) return null
    const topic = canonicalHash(value.topics[index])
    if (topic === null) return null
    topics.push(topic)
  }
  return {
    address,
    topics,
    data,
    blockNumber,
    transactionHash,
    transactionIndex,
    blockHash,
    logIndex,
    removed: false,
  }
}

function parseTransactionReceipt(value: unknown): BscTransactionReceiptEvidence | null {
  if (!isRecord(value) || !Array.isArray(value.logs)) return null
  const transactionHash = canonicalHash(value.transactionHash)
  const transactionIndex = canonicalQuantity(value.transactionIndex, 16)
  const blockNumber = canonicalQuantity(value.blockNumber, 16)
  const blockHash = canonicalHash(value.blockHash)
  const from = canonicalAddress(value.from)
  const to = value.to === null ? null : canonicalAddress(value.to)
  const status = value.status === '0x0' || value.status === '0x1' ? value.status : null
  if (
    transactionHash === null ||
    transactionIndex === null ||
    blockNumber === null ||
    blockHash === null ||
    from === null ||
    (value.to !== null && to === null) ||
    status === null
  ) {
    return null
  }

  const identity = { transactionHash, transactionIndex, blockNumber, blockHash }
  const logs: BscReceiptLogEvidence[] = []
  const seenLogIndexes = new Set<string>()
  let previousLogIndex: bigint | null = null
  for (let index = 0; index < value.logs.length; index += 1) {
    if (!Object.hasOwn(value.logs, index)) return null
    const log = parseReceiptLog(value.logs[index], identity)
    if (!log || seenLogIndexes.has(log.logIndex)) return null
    const numericLogIndex = BigInt(log.logIndex)
    if (previousLogIndex !== null && numericLogIndex <= previousLogIndex) return null
    seenLogIndexes.add(log.logIndex)
    previousLogIndex = numericLogIndex
    logs.push(log)
  }
  if (status === '0x0' && logs.length > 0) return null
  return {
    transactionHash,
    transactionIndex,
    blockNumber,
    blockHash,
    from,
    to,
    status,
    logs,
  }
}

function parseBlockHeader(value: unknown): BscBlockHeaderEvidence | null {
  if (!isRecord(value)) return null
  const number = canonicalQuantity(value.number, 16)
  const hash = canonicalHash(value.hash)
  const parentHash = canonicalHash(value.parentHash)
  const timestamp = canonicalQuantity(value.timestamp, 16)
  const stateRoot = canonicalHash(value.stateRoot)
  const transactionsRoot = canonicalHash(value.transactionsRoot)
  const receiptsRoot = canonicalHash(value.receiptsRoot)
  if (
    number === null ||
    hash === null ||
    hash === ZERO_HASH ||
    parentHash === null ||
    timestamp === null ||
    stateRoot === null ||
    stateRoot === ZERO_HASH ||
    transactionsRoot === null ||
    transactionsRoot === ZERO_HASH ||
    receiptsRoot === null ||
    receiptsRoot === ZERO_HASH
  ) {
    return null
  }
  return { number, hash, parentHash, timestamp, stateRoot, transactionsRoot, receiptsRoot }
}

function isExpectedGenesis(block: BscBlockHeaderEvidence): boolean {
  return (
    block.number === '0x0' &&
    block.hash === BSC_MAINNET_GENESIS_HASH &&
    block.parentHash === ZERO_HASH &&
    block.timestamp === BSC_MAINNET_GENESIS_TIMESTAMP &&
    block.stateRoot === BSC_MAINNET_GENESIS_STATE_ROOT &&
    block.transactionsRoot === BSC_MAINNET_EMPTY_TRIE_ROOT &&
    block.receiptsRoot === BSC_MAINNET_EMPTY_TRIE_ROOT
  )
}

function isPlausibleProducedHeader(block: BscBlockHeaderEvidence): boolean {
  return (
    BigInt(block.number) > 0n &&
    BigInt(block.timestamp) > BigInt(BSC_MAINNET_GENESIS_TIMESTAMP) &&
    block.hash !== BSC_MAINNET_GENESIS_HASH &&
    block.hash !== block.parentHash &&
    block.parentHash !== ZERO_HASH
  )
}

function parseBlockMembership(value: unknown): BscBlockMembershipEvidence | null {
  if (!isRecord(value) || !Array.isArray(value.transactions)) return null
  const header = parseBlockHeader(value)
  if (!header || !isPlausibleProducedHeader(header)) return null
  const transactions: string[] = []
  const seen = new Set<string>()
  for (let index = 0; index < value.transactions.length; index += 1) {
    if (!Object.hasOwn(value.transactions, index)) return null
    const hash = canonicalHash(value.transactions[index])
    if (hash === null || seen.has(hash)) return null
    seen.add(hash)
    transactions.push(hash)
  }
  return { ...header, transactions }
}

function canonicalTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return null
  return parsed
}

function blockTimestampMs(block: BscBlockHeaderEvidence): number | null {
  const milliseconds = BigInt(block.timestamp) * 1000n
  return milliseconds <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(milliseconds) : null
}

function unavailableFromRpc(result: BscRpcFailure): BscEvidenceUnavailable {
  return {
    status: 'unavailable',
    reason: result.reason,
    provider: result.provider,
    rpcCode: result.rpcCode,
    httpStatus: result.httpStatus,
  }
}

function unavailableFromSuccess(
  result: BscRpcSuccess,
  reason:
    | 'not_found'
    | 'not_found_or_unindexed'
    | 'pending'
    | 'malformed_response'
    | 'wrong_chain'
    | 'wrong_genesis'
): BscEvidenceUnavailable {
  return {
    status: 'unavailable',
    reason,
    provider: result.provider,
    rpcCode: null,
    httpStatus: result.httpStatus,
  }
}

function unconfiguredLane(): BscEvidenceUnavailable {
  return {
    status: 'unavailable',
    reason: 'provider_unconfigured',
    provider: providerEvidence(null, []),
    rpcCode: null,
    httpStatus: null,
  }
}

function chainIdLane(result: BscRpcResult): BscEvidenceLane<typeof BSC_MAINNET_CHAIN_ID> {
  if (!result.ok) return unavailableFromRpc(result)
  if (result.result !== BSC_MAINNET_CHAIN_ID) return unavailableFromSuccess(result, 'wrong_chain')
  return {
    status: 'available',
    value: BSC_MAINNET_CHAIN_ID,
    provider: result.provider,
    httpStatus: result.httpStatus,
  }
}

function blockLane(
  result: BscRpcResult,
  kind: 'genesis' | 'produced'
): BscEvidenceLane<BscBlockHeaderEvidence> {
  if (!result.ok) return unavailableFromRpc(result)
  if (result.result === null) return unavailableFromSuccess(result, 'not_found')
  const block = parseBlockHeader(result.result)
  if (!block) return unavailableFromSuccess(result, 'malformed_response')

  if (kind === 'genesis') {
    if (!isExpectedGenesis(block)) {
      return unavailableFromSuccess(result, 'wrong_genesis')
    }
  } else if (!isPlausibleProducedHeader(block)) {
    return unavailableFromSuccess(result, 'malformed_response')
  }

  return {
    status: 'available',
    value: block,
    provider: result.provider,
    httpStatus: result.httpStatus,
  }
}

function availableFromSuccess<T>(result: BscRpcSuccess, value: T): BscEvidenceAvailable<T> {
  return {
    status: 'available',
    value,
    provider: result.provider,
    httpStatus: result.httpStatus,
  }
}

function transactionLane(
  result: BscRpcResult,
  expectedHash: string
): BscEvidenceLane<BscMinedTransactionEvidence> {
  if (!result.ok) return unavailableFromRpc(result)
  if (result.result === null) return unavailableFromSuccess(result, 'not_found_or_unindexed')
  const transaction = parseMinedTransaction(result.result)
  if (!transaction) {
    return unavailableFromSuccess(
      result,
      isPendingTransaction(result.result, expectedHash) ? 'pending' : 'malformed_response'
    )
  }
  if (transaction.hash !== expectedHash) {
    return unavailableFromSuccess(result, 'malformed_response')
  }
  return availableFromSuccess(result, transaction)
}

function receiptLane(
  result: BscRpcResult,
  expectedHash: string
): BscEvidenceLane<BscTransactionReceiptEvidence> {
  if (!result.ok) return unavailableFromRpc(result)
  if (result.result === null) return unavailableFromSuccess(result, 'not_found_or_unindexed')
  const receipt = parseTransactionReceipt(result.result)
  if (!receipt || receipt.transactionHash !== expectedHash) {
    return unavailableFromSuccess(result, 'malformed_response')
  }
  return availableFromSuccess(result, receipt)
}

function blockMembershipLane(result: BscRpcResult): BscEvidenceLane<BscBlockMembershipEvidence> {
  if (!result.ok) return unavailableFromRpc(result)
  if (result.result === null) return unavailableFromSuccess(result, 'not_found_or_unindexed')
  const block = parseBlockMembership(result.result)
  if (!block) return unavailableFromSuccess(result, 'malformed_response')
  return availableFromSuccess(result, block)
}

function dependencyUnavailableLane(): BscEvidenceUnavailable {
  return {
    status: 'unavailable',
    reason: 'dependency_unavailable',
    provider: providerEvidence(null, []),
    rpcCode: null,
    httpStatus: null,
  }
}

function sameEndpoint(
  left: BscEvidenceEndpointIdentity,
  right: BscEvidenceEndpointIdentity
): boolean {
  return (
    left.providerId === right.providerId &&
    left.endpointId === right.endpointId &&
    left.connectionHash === right.connectionHash
  )
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[]
): Record<string, unknown> | null {
  if (!isRecord(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const expected = new Set(expectedKeys)
  const ownKeys = Reflect.ownKeys(value)
  if (
    ownKeys.length !== expectedKeys.length ||
    ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
  ) {
    return null
  }
  const snapshot: Record<string, unknown> = {}
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null
    snapshot[key] = descriptor.value
  }
  return snapshot
}

function exactDenseArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null
  const keys = Reflect.ownKeys(value)
  const keySet = new Set<PropertyKey>(keys)
  if (keys.length !== value.length + 1 || !keySet.has('length')) return null
  const items: unknown[] = []
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index)
    if (!keySet.has(key)) return null
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null
    items.push(descriptor.value)
  }
  return items
}

function parseApprovedEndpoint(value: unknown): BscEvidenceEndpointIdentity | null {
  const endpoint = exactDataRecord(value, ['providerId', 'endpointId', 'connectionHash'])
  if (
    !endpoint ||
    typeof endpoint.providerId !== 'string' ||
    typeof endpoint.endpointId !== 'string' ||
    typeof endpoint.connectionHash !== 'string' ||
    !CONNECTION_HASH_RE.test(endpoint.connectionHash)
  ) {
    return null
  }
  if (endpoint.endpointId === 'alchemy_bnb_mainnet' && endpoint.providerId === 'alchemy') {
    const expected = endpointConnectionHash('alchemy', 'alchemy_bnb_mainnet', ALCHEMY_BSC_ORIGIN)
    return endpoint.connectionHash === expected
      ? {
          providerId: 'alchemy',
          endpointId: 'alchemy_bnb_mainnet',
          connectionHash: expected,
        }
      : null
  }
  if (!Object.hasOwn(CALLER_ENDPOINTS, endpoint.endpointId)) return null
  const endpointId = endpoint.endpointId as BscCallerEndpointId
  const expectedProvider = CALLER_ENDPOINTS[endpointId].providerId
  if (endpoint.providerId !== expectedProvider) return null
  if (endpointId !== 'local_bsc_node') {
    const rpcOrigin = CALLER_ENDPOINTS[endpointId].origin
    const expected = endpointConnectionHash(expectedProvider, endpointId, rpcOrigin)
    if (endpoint.connectionHash !== expected) return null
  }
  return { providerId: expectedProvider, endpointId, connectionHash: endpoint.connectionHash }
}

function parseSoleProvider(value: unknown): BscEvidenceEndpointIdentity | null {
  const provider = exactDataRecord(value, ['servedBy', 'attempted'])
  const attemptedItems = provider ? exactDenseArray(provider.attempted) : null
  if (!provider || !attemptedItems || attemptedItems.length !== 1) return null
  const servedBy = parseApprovedEndpoint(provider.servedBy)
  const attempted = parseApprovedEndpoint(attemptedItems[0])
  if (!servedBy || !attempted || !sameEndpoint(servedBy, attempted)) return null
  return servedBy
}

function parseAvailableLane(
  value: unknown
): { value: unknown; endpoint: BscEvidenceEndpointIdentity } | null {
  const lane = exactDataRecord(value, ['status', 'value', 'provider', 'httpStatus'])
  if (
    !lane ||
    lane.status !== 'available' ||
    typeof lane.httpStatus !== 'number' ||
    !Number.isSafeInteger(lane.httpStatus) ||
    lane.httpStatus < 200 ||
    lane.httpStatus >= 300
  ) {
    return null
  }
  const endpoint = parseSoleProvider(lane.provider)
  return endpoint ? { value: lane.value, endpoint } : null
}

function parseExactBlockHeader(value: unknown): BscBlockHeaderEvidence | null {
  const header = exactDataRecord(value, [
    'number',
    'hash',
    'parentHash',
    'timestamp',
    'stateRoot',
    'transactionsRoot',
    'receiptsRoot',
  ])
  if (!header) return null
  const parsed = parseBlockHeader(header)
  if (
    !parsed ||
    header.number !== parsed.number ||
    header.hash !== parsed.hash ||
    header.parentHash !== parsed.parentHash ||
    header.timestamp !== parsed.timestamp ||
    header.stateRoot !== parsed.stateRoot ||
    header.transactionsRoot !== parsed.transactionsRoot ||
    header.receiptsRoot !== parsed.receiptsRoot
  ) {
    return null
  }
  return parsed
}

function copyBlockHeader(header: BscBlockHeaderEvidence): BscBlockHeaderEvidence {
  return {
    number: header.number,
    hash: header.hash,
    parentHash: header.parentHash,
    timestamp: header.timestamp,
    stateRoot: header.stateRoot,
    transactionsRoot: header.transactionsRoot,
    receiptsRoot: header.receiptsRoot,
  }
}

function sameBlockHeader(left: BscBlockHeaderEvidence, right: BscBlockHeaderEvidence): boolean {
  return (
    left.number === right.number &&
    left.hash === right.hash &&
    left.parentHash === right.parentHash &&
    left.timestamp === right.timestamp &&
    left.stateRoot === right.stateRoot &&
    left.transactionsRoot === right.transactionsRoot &&
    left.receiptsRoot === right.receiptsRoot
  )
}

function parseExactMinedTransaction(value: unknown): BscMinedTransactionEvidence | null {
  const transaction = exactDataRecord(value, [
    'hash',
    'from',
    'to',
    'input',
    'value',
    'blockNumber',
    'blockHash',
    'transactionIndex',
  ])
  if (!transaction) return null
  const parsed = parseMinedTransaction(transaction)
  if (
    !parsed ||
    transaction.hash !== parsed.hash ||
    transaction.from !== parsed.from ||
    transaction.to !== parsed.to ||
    transaction.input !== parsed.input ||
    transaction.value !== parsed.value ||
    transaction.blockNumber !== parsed.blockNumber ||
    transaction.blockHash !== parsed.blockHash ||
    transaction.transactionIndex !== parsed.transactionIndex
  ) {
    return null
  }
  return parsed
}

function parseExactTransactionReceipt(value: unknown): BscTransactionReceiptEvidence | null {
  const receipt = exactDataRecord(value, [
    'transactionHash',
    'transactionIndex',
    'blockNumber',
    'blockHash',
    'from',
    'to',
    'status',
    'logs',
  ])
  const logItems = receipt ? exactDenseArray(receipt.logs) : null
  if (!receipt || !logItems) return null
  const strictLogs: Record<string, unknown>[] = []
  for (const item of logItems) {
    const log = exactDataRecord(item, [
      'address',
      'topics',
      'data',
      'blockNumber',
      'transactionHash',
      'transactionIndex',
      'blockHash',
      'logIndex',
      'removed',
    ])
    const topics = log ? exactDenseArray(log.topics) : null
    if (!log || !topics) return null
    strictLogs.push({
      address: log.address,
      topics,
      data: log.data,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      transactionIndex: log.transactionIndex,
      blockHash: log.blockHash,
      logIndex: log.logIndex,
      removed: log.removed,
    })
  }
  const strictReceipt = {
    transactionHash: receipt.transactionHash,
    transactionIndex: receipt.transactionIndex,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    from: receipt.from,
    to: receipt.to,
    status: receipt.status,
    logs: strictLogs,
  }
  const parsed = parseTransactionReceipt(strictReceipt)
  return parsed && JSON.stringify(strictReceipt) === JSON.stringify(parsed) ? parsed : null
}

function parseExactBlockMembership(value: unknown): BscBlockMembershipEvidence | null {
  const block = exactDataRecord(value, [
    'number',
    'hash',
    'parentHash',
    'timestamp',
    'stateRoot',
    'transactionsRoot',
    'receiptsRoot',
    'transactions',
  ])
  const transactions = block ? exactDenseArray(block.transactions) : null
  if (!block || !transactions) return null
  const strictBlock = {
    number: block.number,
    hash: block.hash,
    parentHash: block.parentHash,
    timestamp: block.timestamp,
    stateRoot: block.stateRoot,
    transactionsRoot: block.transactionsRoot,
    receiptsRoot: block.receiptsRoot,
    transactions,
  }
  const parsed = parseBlockMembership(strictBlock)
  return parsed && JSON.stringify(strictBlock) === JSON.stringify(parsed) ? parsed : null
}

function sameMinedTransaction(
  left: BscMinedTransactionEvidence,
  right: BscMinedTransactionEvidence
): boolean {
  return (
    left.hash === right.hash &&
    left.from === right.from &&
    left.to === right.to &&
    left.input === right.input &&
    left.value === right.value &&
    left.blockNumber === right.blockNumber &&
    left.blockHash === right.blockHash &&
    left.transactionIndex === right.transactionIndex
  )
}

function copyMinedTransaction(
  transaction: BscMinedTransactionEvidence
): BscMinedTransactionEvidence {
  return {
    hash: transaction.hash,
    from: transaction.from,
    to: transaction.to,
    input: transaction.input,
    value: transaction.value,
    blockNumber: transaction.blockNumber,
    blockHash: transaction.blockHash,
    transactionIndex: transaction.transactionIndex,
  }
}

function copyReceiptLog(log: BscReceiptLogEvidence): BscReceiptLogEvidence {
  return {
    address: log.address,
    topics: log.topics.map((topic) => topic),
    data: log.data,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex,
    blockHash: log.blockHash,
    logIndex: log.logIndex,
    removed: false,
  }
}

function copyTransactionReceipt(
  receipt: BscTransactionReceiptEvidence
): BscTransactionReceiptEvidence {
  return {
    transactionHash: receipt.transactionHash,
    transactionIndex: receipt.transactionIndex,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    from: receipt.from,
    to: receipt.to,
    status: receipt.status,
    logs: receipt.logs.map(copyReceiptLog),
  }
}

function copyBlockMembership(block: BscBlockMembershipEvidence): BscBlockMembershipEvidence {
  return {
    number: block.number,
    hash: block.hash,
    parentHash: block.parentHash,
    timestamp: block.timestamp,
    stateRoot: block.stateRoot,
    transactionsRoot: block.transactionsRoot,
    receiptsRoot: block.receiptsRoot,
    transactions: block.transactions.map((hash) => hash),
  }
}

function invalidVerifiedAnchor(): never {
  throw new TypeError('BSC chain anchor is not fully verified')
}

/**
 * Fail-closed aggregate used by later transaction evidence. A finalized block
 * lane alone is never a verified BSC anchor.
 */
function requireBscVerifiedChainAnchorInternal(evidence: unknown): BscVerifiedChainAnchor {
  const root = exactDataRecord(evidence, [
    'chain',
    'observedAt',
    'finalityPolicy',
    'chainId',
    'genesisBlock',
    'finalizedBlock',
    'headBlock',
  ])
  if (!root) return invalidVerifiedAnchor()
  const chain = exactDataRecord(root.chain, ['namespace', 'reference'])
  const finalityPolicy = exactDataRecord(root.finalityPolicy, [
    'version',
    'method',
    'blockTag',
    'headBlockTag',
    'fullTransactions',
    'maxFutureBlockSkewMs',
    'maxCurrentAnchorLagMs',
  ])
  const chainLane = parseAvailableLane(root.chainId)
  const genesisLane = parseAvailableLane(root.genesisBlock)
  const finalizedLane = parseAvailableLane(root.finalizedBlock)
  const headLane = parseAvailableLane(root.headBlock)
  const genesisBlock = genesisLane ? parseExactBlockHeader(genesisLane.value) : null
  const finalizedBlock = finalizedLane ? parseExactBlockHeader(finalizedLane.value) : null
  const headBlock = headLane ? parseExactBlockHeader(headLane.value) : null
  const observedAtMs = canonicalTimestampMs(root.observedAt)
  const finalizedTimestampMs = finalizedBlock ? blockTimestampMs(finalizedBlock) : null
  const headTimestampMs = headBlock ? blockTimestampMs(headBlock) : null
  const finalizedNumber = finalizedBlock ? BigInt(finalizedBlock.number) : null
  const headNumber = headBlock ? BigInt(headBlock.number) : null
  if (
    !chain ||
    chain.namespace !== 'eip155' ||
    chain.reference !== '56' ||
    !finalityPolicy ||
    finalityPolicy.version !== 'bsc_standard_finalized_current_v1' ||
    finalityPolicy.method !== 'eth_getBlockByNumber' ||
    finalityPolicy.blockTag !== 'finalized' ||
    finalityPolicy.headBlockTag !== 'latest' ||
    finalityPolicy.fullTransactions !== false ||
    finalityPolicy.maxFutureBlockSkewMs !== MAX_FUTURE_BLOCK_SKEW_MS ||
    finalityPolicy.maxCurrentAnchorLagMs !== MAX_CURRENT_ANCHOR_LAG_MS ||
    !chainLane ||
    chainLane.value !== BSC_MAINNET_CHAIN_ID ||
    !genesisLane ||
    !genesisBlock ||
    !isExpectedGenesis(genesisBlock) ||
    !finalizedLane ||
    !finalizedBlock ||
    !isPlausibleProducedHeader(finalizedBlock) ||
    !headLane ||
    !headBlock ||
    !isPlausibleProducedHeader(headBlock) ||
    observedAtMs === null ||
    finalizedTimestampMs === null ||
    headTimestampMs === null ||
    finalizedTimestampMs > observedAtMs + MAX_FUTURE_BLOCK_SKEW_MS ||
    headTimestampMs > observedAtMs + MAX_FUTURE_BLOCK_SKEW_MS ||
    observedAtMs - finalizedTimestampMs > MAX_CURRENT_ANCHOR_LAG_MS ||
    observedAtMs - headTimestampMs > MAX_CURRENT_ANCHOR_LAG_MS ||
    finalizedNumber === null ||
    headNumber === null ||
    finalizedNumber > headNumber ||
    BigInt(finalizedBlock.timestamp) > BigInt(headBlock.timestamp) ||
    (finalizedNumber === headNumber && !sameBlockHeader(finalizedBlock, headBlock)) ||
    (headNumber === finalizedNumber + 1n && headBlock.parentHash !== finalizedBlock.hash) ||
    (finalizedNumber !== headNumber && finalizedBlock.hash === headBlock.hash) ||
    !sameEndpoint(chainLane.endpoint, genesisLane.endpoint) ||
    !sameEndpoint(chainLane.endpoint, finalizedLane.endpoint) ||
    !sameEndpoint(chainLane.endpoint, headLane.endpoint)
  ) {
    return invalidVerifiedAnchor()
  }
  return {
    chain: { namespace: 'eip155', reference: '56' },
    finalityPolicy: {
      version: 'bsc_standard_finalized_current_v1',
      method: 'eth_getBlockByNumber',
      blockTag: 'finalized',
      headBlockTag: 'latest',
      fullTransactions: false,
      maxFutureBlockSkewMs: MAX_FUTURE_BLOCK_SKEW_MS,
      maxCurrentAnchorLagMs: MAX_CURRENT_ANCHOR_LAG_MS,
    },
    endpoint: endpointCopy(chainLane.endpoint),
    chainId: BSC_MAINNET_CHAIN_ID,
    observedAt: new Date(observedAtMs).toISOString(),
    genesisBlock: copyBlockHeader(genesisBlock),
    finalizedBlock: copyBlockHeader(finalizedBlock),
    headBlock: copyBlockHeader(headBlock),
  }
}

export function requireBscVerifiedChainAnchor(evidence: unknown): BscVerifiedChainAnchor {
  try {
    return requireBscVerifiedChainAnchorInternal(evidence)
  } catch {
    return invalidVerifiedAnchor()
  }
}

/**
 * Capture one immutable BSC mainnet/finality anchor from one actual endpoint.
 * `latest` is retained only as a diagnostic head and never replaces the
 * finalized tag, confirmation depth, or another endpoint.
 */
async function fetchBscChainAnchorEvidenceInternal(
  opts: BscEvidenceRpcOpts,
  captureRaw: boolean
): Promise<{
  evidence: BscChainAnchorEvidence
  rawExchanges: BscRawRpcEvidenceExchange[]
}> {
  const parsedOpts = parseOptsOrThrow(opts)
  const endpoint = resolveEndpoint(parsedOpts)
  const base = {
    chain: { namespace: 'eip155', reference: '56' } as const,
    finalityPolicy: {
      version: 'bsc_standard_finalized_current_v1',
      method: 'eth_getBlockByNumber',
      blockTag: 'finalized',
      headBlockTag: 'latest',
      fullTransactions: false,
      maxFutureBlockSkewMs: MAX_FUTURE_BLOCK_SKEW_MS,
      maxCurrentAnchorLagMs: MAX_CURRENT_ANCHOR_LAG_MS,
    } as const,
  }
  if (!endpoint) {
    return {
      evidence: {
        ...base,
        observedAt: new Date().toISOString(),
        chainId: unconfiguredLane(),
        genesisBlock: unconfiguredLane(),
        finalizedBlock: unconfiguredLane(),
        headBlock: unconfiguredLane(),
      },
      rawExchanges: [],
    }
  }

  const timeoutMs = parsedOpts.timeoutMs ?? 20_000
  const [chainId, genesisBlock, finalizedBlock] = await Promise.all([
    bscEvidenceRpc(
      endpoint,
      'eth_chainId',
      [],
      timeoutMs,
      captureRaw ? { lane: 'chain_identity' } : undefined
    ),
    bscEvidenceRpc(
      endpoint,
      'eth_getBlockByNumber',
      ['0x0', false],
      timeoutMs,
      captureRaw ? { lane: 'genesis_block' } : undefined
    ),
    bscEvidenceRpc(
      endpoint,
      'eth_getBlockByNumber',
      ['finalized', false],
      timeoutMs,
      captureRaw ? { lane: 'finalized_anchor_block' } : undefined
    ),
  ])
  // Fetch head after the cutoff so a moving chain cannot create a false
  // head-below-finalized result merely because parallel requests raced.
  const headBlock = await bscEvidenceRpc(
    endpoint,
    'eth_getBlockByNumber',
    ['latest', false],
    timeoutMs,
    captureRaw ? { lane: 'head_diagnostic_block' } : undefined
  )

  return {
    evidence: {
      ...base,
      observedAt: new Date().toISOString(),
      chainId: chainIdLane(chainId),
      genesisBlock: blockLane(genesisBlock, 'genesis'),
      finalizedBlock: blockLane(finalizedBlock, 'produced'),
      headBlock: blockLane(headBlock, 'produced'),
    },
    rawExchanges: captureRaw
      ? [chainId, genesisBlock, finalizedBlock, headBlock]
          .map((result) => (result.ok ? result.rawExchange : undefined))
          .filter((exchange): exchange is BscRawRpcEvidenceExchange => exchange !== undefined)
      : [],
  }
}

export async function fetchBscChainAnchorEvidence(
  opts: BscEvidenceRpcOpts = {}
): Promise<BscChainAnchorEvidence> {
  return (await fetchBscChainAnchorEvidenceInternal(opts, false)).evidence
}

export interface BscVerifiedChainAnchorRawCapture {
  evidence: BscChainAnchorEvidence
  verified: BscVerifiedChainAnchor
  rawExchanges: BscRawRpcEvidenceExchange[]
}

/**
 * Capture the exact same response bytes consumed by the strict BSC anchor
 * verifier. Nothing is persisted here; callers must separately scan and
 * authorize any raw artifact storage.
 */
export async function captureBscVerifiedChainAnchorEvidence(
  opts: BscEvidenceRpcOpts = {}
): Promise<BscVerifiedChainAnchorRawCapture> {
  const captured = await fetchBscChainAnchorEvidenceInternal(opts, true)
  const verified = requireBscVerifiedChainAnchor(captured.evidence)
  const expectedLanes = [
    'chain_identity',
    'genesis_block',
    'finalized_anchor_block',
    'head_diagnostic_block',
  ] as const
  if (
    captured.rawExchanges.length !== expectedLanes.length ||
    captured.rawExchanges.some((exchange, index) => exchange.lane !== expectedLanes[index])
  ) {
    throw new TypeError('BSC anchor raw evidence capture is incomplete')
  }
  return { evidence: captured.evidence, verified, rawExchanges: captured.rawExchanges }
}

/**
 * Capture the four same-endpoint observations needed to establish transaction
 * membership. This is still an RPC-provider assertion, not an MPT inclusion
 * proof; callers must run the strict aggregate verifier before using it.
 */
async function fetchBscTransactionMembershipEvidenceInternal(
  txHashInput: string,
  anchorEvidence: unknown,
  opts: BscEvidenceRpcOpts,
  captureRaw: boolean
): Promise<{
  evidence: BscTransactionMembershipEvidence
  rawExchanges: BscRawRpcEvidenceExchange[]
}> {
  if (typeof txHashInput !== 'string' || !HASH_RE.test(txHashInput)) {
    throw new TypeError('txHash must be a 0x-prefixed 32-byte hex string')
  }
  const txHash = txHashInput.toLowerCase()
  const anchor = requireBscVerifiedChainAnchor(anchorEvidence)
  const parsedOpts = parseOptsOrThrow(opts)
  const endpoint = resolveEndpoint(parsedOpts)
  if (!endpoint) throw new TypeError('BSC transaction membership endpoint is unavailable')
  if (!sameEndpoint(endpoint.identity, anchor.endpoint)) {
    throw new TypeError('BSC transaction membership endpoint does not match anchor')
  }

  const timeoutMs = parsedOpts.timeoutMs ?? 20_000
  const [transactionResult, receiptResult] = await Promise.all([
    bscEvidenceRpc(
      endpoint,
      'eth_getTransactionByHash',
      [txHash],
      timeoutMs,
      captureRaw ? { lane: 'transaction' } : undefined
    ),
    bscEvidenceRpc(
      endpoint,
      'eth_getTransactionReceipt',
      [txHash],
      timeoutMs,
      captureRaw ? { lane: 'receipt' } : undefined
    ),
  ])
  const transaction = transactionLane(transactionResult, txHash)
  const receipt = receiptLane(receiptResult, txHash)

  let canonicalBlock: BscEvidenceLane<BscBlockMembershipEvidence> = dependencyUnavailableLane()
  let indexedTransaction: BscEvidenceLane<BscMinedTransactionEvidence> = dependencyUnavailableLane()
  let blockResult: BscRpcResult | null = null
  let indexedTransactionResult: BscRpcResult | null = null
  if (receipt.status === 'available') {
    ;[blockResult, indexedTransactionResult] = await Promise.all([
      bscEvidenceRpc(
        endpoint,
        'eth_getBlockByNumber',
        [receipt.value.blockNumber, false],
        timeoutMs,
        captureRaw ? { lane: 'membership_block' } : undefined
      ),
      bscEvidenceRpc(
        endpoint,
        'eth_getTransactionByBlockNumberAndIndex',
        [receipt.value.blockNumber, receipt.value.transactionIndex],
        timeoutMs,
        captureRaw ? { lane: 'indexed_transaction' } : undefined
      ),
    ])
    canonicalBlock = blockMembershipLane(blockResult)
    indexedTransaction = transactionLane(indexedTransactionResult, txHash)
  }

  return {
    evidence: {
      chain: { namespace: 'eip155', reference: '56' },
      txHash,
      capturedAt: new Date().toISOString(),
      membershipPolicy: {
        version: 'bsc_transaction_membership_v1',
        transactionMethod: 'eth_getTransactionByHash',
        receiptMethod: 'eth_getTransactionReceipt',
        blockMethod: 'eth_getBlockByNumber',
        indexedTransactionMethod: 'eth_getTransactionByBlockNumberAndIndex',
        fullTransactions: false,
      },
      anchor: {
        endpoint: endpointCopy(anchor.endpoint),
        verifiedAnchorHash: verifiedChainAnchorHash(anchor),
        verifiedAnchorHashPolicy: 'bsc_verified_anchor_semantics_v1',
        observedAt: anchor.observedAt,
        finalityPolicy: {
          version: 'bsc_standard_finalized_current_v1',
          method: 'eth_getBlockByNumber',
          blockTag: 'finalized',
          headBlockTag: 'latest',
          fullTransactions: false,
          maxFutureBlockSkewMs: MAX_FUTURE_BLOCK_SKEW_MS,
          maxCurrentAnchorLagMs: MAX_CURRENT_ANCHOR_LAG_MS,
        },
        finalizedBlock: copyBlockHeader(anchor.finalizedBlock),
      },
      transaction,
      receipt,
      canonicalBlock,
      indexedTransaction,
    },
    rawExchanges: captureRaw
      ? [transactionResult, receiptResult, blockResult, indexedTransactionResult]
          .map((result) => (result?.ok ? result.rawExchange : undefined))
          .filter((exchange): exchange is BscRawRpcEvidenceExchange => exchange !== undefined)
      : [],
  }
}

export async function fetchBscTransactionMembershipEvidence(
  txHashInput: string,
  anchorEvidence: unknown,
  opts: BscEvidenceRpcOpts = {}
): Promise<BscTransactionMembershipEvidence> {
  return (
    await fetchBscTransactionMembershipEvidenceInternal(txHashInput, anchorEvidence, opts, false)
  ).evidence
}

export interface BscVerifiedTransactionFinalityRawCapture {
  evidence: BscTransactionMembershipEvidence
  verified: BscVerifiedTransactionFinality
  rawExchanges: BscRawRpcEvidenceExchange[]
}

/**
 * Capture the exact same response bytes consumed by the strict transaction
 * finality verifier. This does not capture trace/internal native cashflow and
 * cannot by itself verify a DEX protocol invocation or authorize persistence.
 */
export async function captureBscVerifiedTransactionFinalityEvidence(
  txHashInput: string,
  anchorEvidence: unknown,
  opts: BscEvidenceRpcOpts = {}
): Promise<BscVerifiedTransactionFinalityRawCapture> {
  const captured = await fetchBscTransactionMembershipEvidenceInternal(
    txHashInput,
    anchorEvidence,
    opts,
    true
  )
  const verified = requireBscVerifiedTransactionFinality(captured.evidence, anchorEvidence)
  const expectedLanes = [
    'transaction',
    'receipt',
    'membership_block',
    'indexed_transaction',
  ] as const
  if (
    captured.rawExchanges.length !== expectedLanes.length ||
    captured.rawExchanges.some((exchange, index) => exchange.lane !== expectedLanes[index])
  ) {
    throw new TypeError('BSC transaction raw evidence capture is incomplete')
  }
  return { evidence: captured.evidence, verified, rawExchanges: captured.rawExchanges }
}

function invalidVerifiedTransactionFinality(): never {
  throw new TypeError('BSC transaction finality evidence is not fully verified')
}

function requireBscVerifiedTransactionFinalityInternal(
  evidence: unknown,
  anchorEvidence: unknown
): BscVerifiedTransactionFinality {
  const anchor = requireBscVerifiedChainAnchor(anchorEvidence)
  const root = exactDataRecord(evidence, [
    'chain',
    'txHash',
    'capturedAt',
    'membershipPolicy',
    'anchor',
    'transaction',
    'receipt',
    'canonicalBlock',
    'indexedTransaction',
  ])
  if (!root) return invalidVerifiedTransactionFinality()
  const chain = exactDataRecord(root.chain, ['namespace', 'reference'])
  const membershipPolicy = exactDataRecord(root.membershipPolicy, [
    'version',
    'transactionMethod',
    'receiptMethod',
    'blockMethod',
    'indexedTransactionMethod',
    'fullTransactions',
  ])
  const anchorBinding = exactDataRecord(root.anchor, [
    'endpoint',
    'verifiedAnchorHash',
    'verifiedAnchorHashPolicy',
    'observedAt',
    'finalityPolicy',
    'finalizedBlock',
  ])
  const boundEndpoint = anchorBinding ? parseApprovedEndpoint(anchorBinding.endpoint) : null
  const boundFinalityPolicy = anchorBinding
    ? exactDataRecord(anchorBinding.finalityPolicy, [
        'version',
        'method',
        'blockTag',
        'headBlockTag',
        'fullTransactions',
        'maxFutureBlockSkewMs',
        'maxCurrentAnchorLagMs',
      ])
    : null
  const boundFinalizedBlock = anchorBinding
    ? parseExactBlockHeader(anchorBinding.finalizedBlock)
    : null
  const transactionLaneValue = parseAvailableLane(root.transaction)
  const receiptLaneValue = parseAvailableLane(root.receipt)
  const blockLaneValue = parseAvailableLane(root.canonicalBlock)
  const indexedLaneValue = parseAvailableLane(root.indexedTransaction)
  const transaction = transactionLaneValue
    ? parseExactMinedTransaction(transactionLaneValue.value)
    : null
  const receipt = receiptLaneValue ? parseExactTransactionReceipt(receiptLaneValue.value) : null
  const canonicalBlock = blockLaneValue ? parseExactBlockMembership(blockLaneValue.value) : null
  const indexedTransaction = indexedLaneValue
    ? parseExactMinedTransaction(indexedLaneValue.value)
    : null
  const txHash = canonicalHash(root.txHash)
  const capturedAtMs = canonicalTimestampMs(root.capturedAt)
  const anchorObservedAtMs = canonicalTimestampMs(anchor.observedAt)
  const candidateTimestampMs = canonicalBlock ? blockTimestampMs(canonicalBlock) : null
  const candidateNumber = canonicalBlock ? BigInt(canonicalBlock.number) : null
  const finalizedNumber = BigInt(anchor.finalizedBlock.number)
  const expectedAnchorHash = verifiedChainAnchorHash(anchor)
  if (
    !chain ||
    chain.namespace !== 'eip155' ||
    chain.reference !== '56' ||
    txHash === null ||
    root.txHash !== txHash ||
    capturedAtMs === null ||
    anchorObservedAtMs === null ||
    capturedAtMs + MAX_FUTURE_BLOCK_SKEW_MS < anchorObservedAtMs ||
    !membershipPolicy ||
    membershipPolicy.version !== 'bsc_transaction_membership_v1' ||
    membershipPolicy.transactionMethod !== 'eth_getTransactionByHash' ||
    membershipPolicy.receiptMethod !== 'eth_getTransactionReceipt' ||
    membershipPolicy.blockMethod !== 'eth_getBlockByNumber' ||
    membershipPolicy.indexedTransactionMethod !== 'eth_getTransactionByBlockNumberAndIndex' ||
    membershipPolicy.fullTransactions !== false ||
    !anchorBinding ||
    !boundEndpoint ||
    !sameEndpoint(boundEndpoint, anchor.endpoint) ||
    anchorBinding.verifiedAnchorHashPolicy !== 'bsc_verified_anchor_semantics_v1' ||
    anchorBinding.verifiedAnchorHash !== expectedAnchorHash ||
    anchorBinding.observedAt !== anchor.observedAt ||
    !boundFinalityPolicy ||
    boundFinalityPolicy.version !== anchor.finalityPolicy.version ||
    boundFinalityPolicy.method !== anchor.finalityPolicy.method ||
    boundFinalityPolicy.blockTag !== anchor.finalityPolicy.blockTag ||
    boundFinalityPolicy.headBlockTag !== anchor.finalityPolicy.headBlockTag ||
    boundFinalityPolicy.fullTransactions !== anchor.finalityPolicy.fullTransactions ||
    boundFinalityPolicy.maxFutureBlockSkewMs !== anchor.finalityPolicy.maxFutureBlockSkewMs ||
    boundFinalityPolicy.maxCurrentAnchorLagMs !== anchor.finalityPolicy.maxCurrentAnchorLagMs ||
    !boundFinalizedBlock ||
    !sameBlockHeader(boundFinalizedBlock, anchor.finalizedBlock) ||
    !transactionLaneValue ||
    !receiptLaneValue ||
    !blockLaneValue ||
    !indexedLaneValue ||
    !transaction ||
    !receipt ||
    !canonicalBlock ||
    !indexedTransaction ||
    !sameEndpoint(transactionLaneValue.endpoint, boundEndpoint) ||
    !sameEndpoint(receiptLaneValue.endpoint, boundEndpoint) ||
    !sameEndpoint(blockLaneValue.endpoint, boundEndpoint) ||
    !sameEndpoint(indexedLaneValue.endpoint, boundEndpoint) ||
    transaction.hash !== txHash ||
    receipt.transactionHash !== txHash ||
    indexedTransaction.hash !== txHash ||
    !sameMinedTransaction(transaction, indexedTransaction) ||
    transaction.from !== receipt.from ||
    transaction.to !== receipt.to ||
    transaction.blockNumber !== receipt.blockNumber ||
    transaction.blockHash !== receipt.blockHash ||
    transaction.transactionIndex !== receipt.transactionIndex ||
    canonicalBlock.number !== receipt.blockNumber ||
    canonicalBlock.hash !== receipt.blockHash ||
    candidateTimestampMs === null ||
    candidateNumber === null ||
    candidateTimestampMs > capturedAtMs + MAX_FUTURE_BLOCK_SKEW_MS ||
    candidateNumber > finalizedNumber ||
    BigInt(canonicalBlock.timestamp) > BigInt(anchor.finalizedBlock.timestamp) ||
    (candidateNumber === finalizedNumber &&
      !sameBlockHeader(canonicalBlock, anchor.finalizedBlock)) ||
    (candidateNumber !== finalizedNumber && canonicalBlock.hash === anchor.finalizedBlock.hash)
  ) {
    return invalidVerifiedTransactionFinality()
  }
  const numericIndex = BigInt(transaction.transactionIndex)
  if (
    numericIndex >= BigInt(canonicalBlock.transactions.length) ||
    canonicalBlock.transactions[Number(numericIndex)] !== txHash
  ) {
    return invalidVerifiedTransactionFinality()
  }

  return {
    chain: { namespace: 'eip155', reference: '56' },
    txHash,
    capturedAt: new Date(capturedAtMs).toISOString(),
    membershipPolicy: {
      version: 'bsc_transaction_membership_v1',
      transactionMethod: 'eth_getTransactionByHash',
      receiptMethod: 'eth_getTransactionReceipt',
      blockMethod: 'eth_getBlockByNumber',
      indexedTransactionMethod: 'eth_getTransactionByBlockNumberAndIndex',
      fullTransactions: false,
    },
    anchor: {
      endpoint: endpointCopy(boundEndpoint),
      verifiedAnchorHash: expectedAnchorHash,
      verifiedAnchorHashPolicy: 'bsc_verified_anchor_semantics_v1',
      observedAt: anchor.observedAt,
      finalityPolicy: {
        version: 'bsc_standard_finalized_current_v1',
        method: 'eth_getBlockByNumber',
        blockTag: 'finalized',
        headBlockTag: 'latest',
        fullTransactions: false,
        maxFutureBlockSkewMs: MAX_FUTURE_BLOCK_SKEW_MS,
        maxCurrentAnchorLagMs: MAX_CURRENT_ANCHOR_LAG_MS,
      },
      finalizedBlock: copyBlockHeader(anchor.finalizedBlock),
    },
    transaction: copyMinedTransaction(transaction),
    receipt: copyTransactionReceipt(receipt),
    canonicalBlock: copyBlockMembership(canonicalBlock),
    indexedTransaction: copyMinedTransaction(indexedTransaction),
  }
}

export function requireBscVerifiedTransactionFinality(
  evidence: unknown,
  anchorEvidence: unknown
): BscVerifiedTransactionFinality {
  try {
    return requireBscVerifiedTransactionFinalityInternal(evidence, anchorEvidence)
  } catch {
    return invalidVerifiedTransactionFinality()
  }
}
