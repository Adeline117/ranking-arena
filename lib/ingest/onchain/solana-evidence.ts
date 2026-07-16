/**
 * Strict, shadow-only Solana mainnet chain evidence.
 *
 * A verified value from this module is a same-provider rooted RPC assertion;
 * it is not an independently replayed ledger or proof-of-history proof.
 */

import { createHash } from 'node:crypto'

import { hasBase58DecodedByteLength } from '@/lib/utils/base58'

import { parseStrictJson } from './strict-json'

export const SOLANA_MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' as const

const RPC_REQUEST_ID = 1
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_TIMEOUT_MS = 120_000
const MAX_FUTURE_BLOCK_SKEW_MS = 60_000
const MAX_CURRENT_ANCHOR_LAG_MS = 900_000
const CONNECTION_HASH_RE = /^[0-9a-f]{64}$/
const SOLANA_BLOCK_UNAVAILABLE_RPC_CODES = new Set([
  -32_001, // block cleaned up
  -32_004, // block not available
  -32_007, // slot skipped
  -32_009, // long-term storage slot skipped
  -32_011, // transaction history unavailable
  -32_014, // block status not available yet
  -32_019, // long-term storage unreachable
])
const SOLANA_OFFICIAL_ORIGIN = 'https://api.mainnet-beta.solana.com'
const HELIUS_ORIGIN = 'https://mainnet.helius-rpc.com'
const ALCHEMY_SOLANA_ORIGIN = 'https://solana-mainnet.g.alchemy.com'

const CALLER_ENDPOINTS = {
  solana_official_mainnet: {
    providerId: 'solana_foundation',
    origin: SOLANA_OFFICIAL_ORIGIN,
    route: 'root',
  },
  helius_solana_mainnet: {
    providerId: 'helius',
    origin: HELIUS_ORIGIN,
    route: 'helius_key',
  },
  alchemy_solana_mainnet: {
    providerId: 'alchemy',
    origin: ALCHEMY_SOLANA_ORIGIN,
    route: 'alchemy_key',
  },
  local_solana_node: { providerId: 'local', origin: null, route: 'local_root' },
} as const

export type SolanaEvidenceEndpointId = keyof typeof CALLER_ENDPOINTS
export type SolanaEvidenceProviderId =
  (typeof CALLER_ENDPOINTS)[SolanaEvidenceEndpointId]['providerId']

export interface SolanaEvidenceEndpointIdentity {
  providerId: SolanaEvidenceProviderId
  endpointId: SolanaEvidenceEndpointId
  /** SHA-256 of the approved, secret-free logical RPC origin. */
  connectionHash: string
}

export interface SolanaEvidenceProvider {
  servedBy: SolanaEvidenceEndpointIdentity | null
  attempted: SolanaEvidenceEndpointIdentity[]
}

export type SolanaEvidenceUnavailableReason =
  | 'provider_unconfigured'
  | 'dependency_unavailable'
  | 'not_found_or_unavailable'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'timeout'
  | 'transport_error'
  | 'rpc_error'
  | 'response_too_large'
  | 'malformed_response'
  | 'wrong_genesis'

export interface SolanaEvidenceAvailable<T> {
  status: 'available'
  value: T
  provider: SolanaEvidenceProvider
  httpStatus: number | null
}

export interface SolanaEvidenceUnavailable {
  status: 'unavailable'
  reason: SolanaEvidenceUnavailableReason
  provider: SolanaEvidenceProvider
  rpcCode: number | null
  httpStatus: number | null
}

export type SolanaEvidenceLane<T> = SolanaEvidenceAvailable<T> | SolanaEvidenceUnavailable

export interface SolanaFinalizedBlockEvidence {
  /** Requested finalized slot; getBlock does not repeat it in the result. */
  slot: number
  blockhash: string
  previousBlockhash: string
  parentSlot: number
  /** Officially nullable stake-weighted estimate. */
  blockTime: number | null
  /** Officially nullable ledger block height. */
  blockHeight: number | null
}

export interface SolanaChainAnchorEvidence {
  chain: {
    cluster: 'mainnet-beta'
    genesisHash: typeof SOLANA_MAINNET_GENESIS_HASH
  }
  /** Local capture completion time; never presented as chain time. */
  observedAt: string
  anchorPolicy: {
    version: 'solana_current_finalized_block_v1'
    genesisMethod: 'getGenesisHash'
    slotMethod: 'getSlot'
    blockMethod: 'getBlock'
    commitment: 'finalized'
    encoding: 'json'
    transactionDetails: 'none'
    maxSupportedTransactionVersion: 0
    rewards: false
    maxFutureBlockSkewMs: 60_000
    maxCurrentAnchorLagMs: 900_000
  }
  genesisHash: SolanaEvidenceLane<typeof SOLANA_MAINNET_GENESIS_HASH>
  finalizedSlot: SolanaEvidenceLane<number>
  finalizedBlock: SolanaEvidenceLane<SolanaFinalizedBlockEvidence>
}

export interface SolanaVerifiedChainAnchor {
  chain: {
    cluster: 'mainnet-beta'
    genesisHash: typeof SOLANA_MAINNET_GENESIS_HASH
  }
  anchorPolicy: SolanaChainAnchorEvidence['anchorPolicy']
  endpoint: SolanaEvidenceEndpointIdentity
  observedAt: string
  genesisHash: typeof SOLANA_MAINNET_GENESIS_HASH
  finalizedSlot: number
  finalizedBlock: SolanaFinalizedBlockEvidence
  semanticHashPolicy: 'solana_verified_anchor_semantics_v1'
  semanticHash: string
}

export interface SolanaEvidenceRpcOpts {
  /** A single approved endpoint. endpointId is mandatory when this is set. */
  rpcUrl?: string
  endpointId?: SolanaEvidenceEndpointId
  /** Per JSON-RPC request; capture has two sequential request rounds. */
  timeoutMs?: number
}

interface SolanaEvidenceEndpoint {
  url: string
  identity: SolanaEvidenceEndpointIdentity
}

interface ParsedSolanaEvidenceRpcOpts {
  rpcUrl: string | undefined
  endpointId: SolanaEvidenceEndpointId | undefined
  timeoutMs: number | undefined
}

interface SolanaRpcSuccess {
  ok: true
  result: unknown
  provider: SolanaEvidenceProvider
  httpStatus: number | null
}

interface SolanaRpcFailure {
  ok: false
  reason: Exclude<
    SolanaEvidenceUnavailableReason,
    | 'provider_unconfigured'
    | 'dependency_unavailable'
    | 'not_found_or_unavailable'
    | 'wrong_genesis'
  >
  provider: SolanaEvidenceProvider
  rpcCode: number | null
  httpStatus: number | null
}

type SolanaRpcResult = SolanaRpcSuccess | SolanaRpcFailure

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function endpointConnectionHash(providerId: string, endpointId: string, rpcOrigin: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['solana_evidence_connection_v1', providerId, endpointId, rpcOrigin]))
    .digest('hex')
}

function endpointCopy(endpoint: SolanaEvidenceEndpointIdentity): SolanaEvidenceEndpointIdentity {
  return {
    providerId: endpoint.providerId,
    endpointId: endpoint.endpointId,
    connectionHash: endpoint.connectionHash,
  }
}

function providerEvidence(
  servedBy: SolanaEvidenceEndpointIdentity | null,
  attempted: SolanaEvidenceEndpointIdentity[]
): SolanaEvidenceProvider {
  return {
    servedBy: servedBy ? endpointCopy(servedBy) : null,
    attempted: attempted.map(endpointCopy),
  }
}

function parseOpts(input: SolanaEvidenceRpcOpts): ParsedSolanaEvidenceRpcOpts {
  if (!isRecord(input)) throw new TypeError('Solana evidence options must be a plain object')
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Solana evidence options must be a plain object')
  }
  const allowedKeys = new Set(['rpcUrl', 'endpointId', 'timeoutMs'])
  const ownKeys = Reflect.ownKeys(input)
  if (ownKeys.some((key) => typeof key !== 'string' || !allowedKeys.has(key))) {
    throw new TypeError('Solana evidence options contain an unknown field')
  }
  const readDataProperty = (key: 'rpcUrl' | 'endpointId' | 'timeoutMs'): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor) return undefined
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('Solana evidence options must use enumerable data properties')
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
    endpointId: endpointId as SolanaEvidenceEndpointId | undefined,
    timeoutMs,
  }
}

function parseOptsOrThrow(input: SolanaEvidenceRpcOpts): ParsedSolanaEvidenceRpcOpts {
  try {
    return parseOpts(input)
  } catch {
    throw new TypeError('invalid Solana evidence options')
  }
}

function approvedCallerRoute(parsed: URL, endpointId: SolanaEvidenceEndpointId): boolean {
  const config = CALLER_ENDPOINTS[endpointId]
  if (parsed.username || parsed.password || parsed.hash) return false
  if (endpointId === 'local_solana_node') {
    return (
      ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) &&
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.pathname === '/' &&
      parsed.search.length === 0
    )
  }
  if (parsed.protocol !== 'https:' || parsed.origin !== config.origin) return false
  if (config.route === 'root') return parsed.pathname === '/' && parsed.search.length === 0
  if (config.route === 'helius_key') {
    const keys = [...parsed.searchParams.keys()]
    return (
      parsed.pathname === '/' &&
      keys.length === 1 &&
      keys[0] === 'api-key' &&
      (parsed.searchParams.get('api-key')?.length ?? 0) > 0
    )
  }
  return (
    config.route === 'alchemy_key' &&
    parsed.search.length === 0 &&
    /^\/v2\/[^/]+$/.test(parsed.pathname)
  )
}

function endpointIdentity(
  endpointId: SolanaEvidenceEndpointId,
  rpcOrigin: string
): SolanaEvidenceEndpointIdentity {
  const providerId = CALLER_ENDPOINTS[endpointId].providerId
  return {
    providerId,
    endpointId,
    connectionHash: endpointConnectionHash(providerId, endpointId, rpcOrigin),
  }
}

function resolveEndpoint(opts: ParsedSolanaEvidenceRpcOpts): SolanaEvidenceEndpoint | null {
  if (opts.rpcUrl !== undefined) {
    if (!opts.endpointId || opts.rpcUrl.length === 0 || opts.rpcUrl.trim() !== opts.rpcUrl) {
      return null
    }
    try {
      const parsed = new URL(opts.rpcUrl)
      if (!approvedCallerRoute(parsed, opts.endpointId)) return null
      return {
        url: opts.rpcUrl,
        identity: endpointIdentity(opts.endpointId, parsed.origin),
      }
    } catch {
      return null
    }
  }

  const heliusKey = process.env.HELIUS_API_KEY
  if (heliusKey && heliusKey.trim().length > 0) {
    const url = new URL(HELIUS_ORIGIN)
    url.searchParams.set('api-key', heliusKey)
    return {
      url: url.toString(),
      identity: endpointIdentity('helius_solana_mainnet', HELIUS_ORIGIN),
    }
  }
  const alchemyKey = process.env.ALCHEMY_API_KEY
  if (alchemyKey && alchemyKey.trim().length > 0) {
    return {
      url: `${ALCHEMY_SOLANA_ORIGIN}/v2/${encodeURIComponent(alchemyKey)}`,
      identity: endpointIdentity('alchemy_solana_mainnet', ALCHEMY_SOLANA_ORIGIN),
    }
  }
  return null
}

function normalizedHttpStatus(response: Response): number | null {
  return Number.isSafeInteger(response.status) && response.status >= 0 ? response.status : null
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Evidence intentionally excludes transport details.
  }
}

async function readBoundedResponseText(
  response: Response
): Promise<
  { ok: true; text: string } | { ok: false; reason: 'response_too_large' | 'malformed_response' }
> {
  const contentLength = response.headers?.get?.('content-length')
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_RESPONSE_BYTES) {
    await discardResponseBody(response)
    return { ok: false, reason: 'response_too_large' }
  }
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let totalBytes = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      totalBytes += chunk.value.byteLength
      if (totalBytes > MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel()
        } catch {
          // Fixed reasons are sufficient; never retain raw stream failures.
        }
        return { ok: false, reason: 'response_too_large' }
      }
      chunks.push(chunk.value)
    }
    const bytes = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    try {
      return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    } catch {
      return { ok: false, reason: 'malformed_response' }
    }
  }
  const text = await response.text()
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    return { ok: false, reason: 'response_too_large' }
  }
  return { ok: true, text }
}

function quotaMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('quota') ||
    normalized.includes('max usage') ||
    normalized.includes('usage limit') ||
    normalized.includes('credits exhausted')
  )
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

function rpcFailure(
  endpoint: SolanaEvidenceEndpointIdentity,
  reason: SolanaRpcFailure['reason'],
  rpcCode: number | null = null,
  httpStatus: number | null = null
): SolanaRpcFailure {
  return {
    ok: false,
    reason,
    provider: providerEvidence(null, [endpoint]),
    rpcCode,
    httpStatus,
  }
}

async function solanaEvidenceRpc(
  endpoint: SolanaEvidenceEndpoint,
  method: string,
  params: unknown[],
  timeoutMs: number
): Promise<SolanaRpcResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: RPC_REQUEST_ID, method, params }),
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
    const responseText = await readBoundedResponseText(response)
    if (!responseText.ok) {
      return rpcFailure(endpoint.identity, responseText.reason, null, httpStatus)
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
    return {
      ok: true,
      result: payload.result,
      provider: providerEvidence(endpoint.identity, [endpoint.identity]),
      httpStatus,
    }
  } catch (error) {
    return rpcFailure(endpoint.identity, timeoutError(error) ? 'timeout' : 'transport_error')
  } finally {
    clearTimeout(timer)
  }
}

function unavailableFromRpc(result: SolanaRpcFailure): SolanaEvidenceUnavailable {
  return {
    status: 'unavailable',
    reason: result.reason,
    provider: result.provider,
    rpcCode: result.rpcCode,
    httpStatus: result.httpStatus,
  }
}

function unavailableFromSuccess(
  result: SolanaRpcSuccess,
  reason: 'not_found_or_unavailable' | 'malformed_response' | 'wrong_genesis'
): SolanaEvidenceUnavailable {
  return {
    status: 'unavailable',
    reason,
    provider: result.provider,
    rpcCode: null,
    httpStatus: result.httpStatus,
  }
}

function unconfiguredLane(): SolanaEvidenceUnavailable {
  return {
    status: 'unavailable',
    reason: 'provider_unconfigured',
    provider: providerEvidence(null, []),
    rpcCode: null,
    httpStatus: null,
  }
}

function dependencyUnavailableLane(): SolanaEvidenceUnavailable {
  return {
    status: 'unavailable',
    reason: 'dependency_unavailable',
    provider: providerEvidence(null, []),
    rpcCode: null,
    httpStatus: null,
  }
}

function genesisLane(
  result: SolanaRpcResult
): SolanaEvidenceLane<typeof SOLANA_MAINNET_GENESIS_HASH> {
  if (!result.ok) return unavailableFromRpc(result)
  if (typeof result.result !== 'string' || !hasBase58DecodedByteLength(result.result, 32)) {
    return unavailableFromSuccess(result, 'malformed_response')
  }
  if (result.result !== SOLANA_MAINNET_GENESIS_HASH) {
    return unavailableFromSuccess(result, 'wrong_genesis')
  }
  return {
    status: 'available',
    value: SOLANA_MAINNET_GENESIS_HASH,
    provider: result.provider,
    httpStatus: result.httpStatus,
  }
}

function safeNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function slotLane(result: SolanaRpcResult): SolanaEvidenceLane<number> {
  if (!result.ok) return unavailableFromRpc(result)
  const slot = safeNonNegativeInteger(result.result)
  if (slot === null) return unavailableFromSuccess(result, 'malformed_response')
  return {
    status: 'available',
    value: slot,
    provider: result.provider,
    httpStatus: result.httpStatus,
  }
}

function parseFinalizedBlock(value: unknown, slot: number): SolanaFinalizedBlockEvidence | null {
  if (!isRecord(value)) return null
  const blockhash = value.blockhash
  const previousBlockhash = value.previousBlockhash
  const parentSlot = safeNonNegativeInteger(value.parentSlot)
  const blockTime = value.blockTime === null ? null : safeNonNegativeInteger(value.blockTime)
  const blockHeight = value.blockHeight === null ? null : safeNonNegativeInteger(value.blockHeight)
  if (
    typeof blockhash !== 'string' ||
    !hasBase58DecodedByteLength(blockhash, 32) ||
    typeof previousBlockhash !== 'string' ||
    !hasBase58DecodedByteLength(previousBlockhash, 32) ||
    blockhash === previousBlockhash ||
    parentSlot === null ||
    parentSlot >= slot ||
    !Object.hasOwn(value, 'blockTime') ||
    (value.blockTime !== null && blockTime === null) ||
    !Object.hasOwn(value, 'blockHeight') ||
    (value.blockHeight !== null && blockHeight === null)
  ) {
    return null
  }
  return { slot, blockhash, previousBlockhash, parentSlot, blockTime, blockHeight }
}

function blockLane(
  result: SolanaRpcResult,
  slot: number
): SolanaEvidenceLane<SolanaFinalizedBlockEvidence> {
  if (!result.ok) {
    const unavailable = unavailableFromRpc(result)
    return result.rpcCode !== null && SOLANA_BLOCK_UNAVAILABLE_RPC_CODES.has(result.rpcCode)
      ? { ...unavailable, reason: 'not_found_or_unavailable' }
      : unavailable
  }
  if (result.result === null) {
    return unavailableFromSuccess(result, 'not_found_or_unavailable')
  }
  const block = parseFinalizedBlock(result.result, slot)
  if (!block) return unavailableFromSuccess(result, 'malformed_response')
  return {
    status: 'available',
    value: block,
    provider: result.provider,
    httpStatus: result.httpStatus,
  }
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

function parseApprovedEndpoint(value: unknown): SolanaEvidenceEndpointIdentity | null {
  const endpoint = exactDataRecord(value, ['providerId', 'endpointId', 'connectionHash'])
  if (
    !endpoint ||
    typeof endpoint.providerId !== 'string' ||
    typeof endpoint.endpointId !== 'string' ||
    typeof endpoint.connectionHash !== 'string' ||
    !CONNECTION_HASH_RE.test(endpoint.connectionHash) ||
    !Object.hasOwn(CALLER_ENDPOINTS, endpoint.endpointId)
  ) {
    return null
  }
  const endpointId = endpoint.endpointId as SolanaEvidenceEndpointId
  const config = CALLER_ENDPOINTS[endpointId]
  if (endpoint.providerId !== config.providerId) return null
  if (endpointId !== 'local_solana_node') {
    if (typeof config.origin !== 'string') return null
    const expected = endpointConnectionHash(config.providerId, endpointId, config.origin)
    if (endpoint.connectionHash !== expected) return null
  }
  return {
    providerId: config.providerId,
    endpointId,
    connectionHash: endpoint.connectionHash,
  }
}

function sameEndpoint(
  left: SolanaEvidenceEndpointIdentity,
  right: SolanaEvidenceEndpointIdentity
): boolean {
  return (
    left.providerId === right.providerId &&
    left.endpointId === right.endpointId &&
    left.connectionHash === right.connectionHash
  )
}

function parseSoleProvider(value: unknown): SolanaEvidenceEndpointIdentity | null {
  const provider = exactDataRecord(value, ['servedBy', 'attempted'])
  const attempted = provider ? exactDenseArray(provider.attempted) : null
  if (!provider || !attempted || attempted.length !== 1) return null
  const servedBy = parseApprovedEndpoint(provider.servedBy)
  const attemptedEndpoint = parseApprovedEndpoint(attempted[0])
  if (!servedBy || !attemptedEndpoint || !sameEndpoint(servedBy, attemptedEndpoint)) return null
  return servedBy
}

function parseAvailableLane(
  value: unknown
): { value: unknown; endpoint: SolanaEvidenceEndpointIdentity } | null {
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

function parseExactFinalizedBlock(value: unknown): SolanaFinalizedBlockEvidence | null {
  const block = exactDataRecord(value, [
    'slot',
    'blockhash',
    'previousBlockhash',
    'parentSlot',
    'blockTime',
    'blockHeight',
  ])
  if (!block) return null
  const slot = safeNonNegativeInteger(block.slot)
  if (slot === null) return null
  const parsed = parseFinalizedBlock(block, slot)
  if (
    !parsed ||
    block.slot !== parsed.slot ||
    block.blockhash !== parsed.blockhash ||
    block.previousBlockhash !== parsed.previousBlockhash ||
    block.parentSlot !== parsed.parentSlot ||
    block.blockTime !== parsed.blockTime ||
    block.blockHeight !== parsed.blockHeight
  ) {
    return null
  }
  return parsed
}

function canonicalTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return null
  return parsed
}

function unixTimestampMs(value: number | null): number | null {
  if (value === null) return null
  const milliseconds = BigInt(value) * 1000n
  return milliseconds <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(milliseconds) : null
}

function copyFinalizedBlock(block: SolanaFinalizedBlockEvidence): SolanaFinalizedBlockEvidence {
  return {
    slot: block.slot,
    blockhash: block.blockhash,
    previousBlockhash: block.previousBlockhash,
    parentSlot: block.parentSlot,
    blockTime: block.blockTime,
    blockHeight: block.blockHeight,
  }
}

function solanaAnchorSemanticHash(
  endpoint: SolanaEvidenceEndpointIdentity,
  observedAt: string,
  block: SolanaFinalizedBlockEvidence
): string {
  const fields = [
    'solana_verified_anchor_semantics_v1',
    'mainnet-beta',
    SOLANA_MAINNET_GENESIS_HASH,
    'solana_current_finalized_block_v1',
    'getGenesisHash',
    'getSlot',
    'getBlock',
    'finalized',
    'json',
    'none',
    0,
    false,
    MAX_FUTURE_BLOCK_SKEW_MS,
    MAX_CURRENT_ANCHOR_LAG_MS,
    endpoint.providerId,
    endpoint.endpointId,
    endpoint.connectionHash,
    observedAt,
    block.slot,
    block.blockhash,
    block.previousBlockhash,
    block.parentSlot,
    block.blockTime,
    block.blockHeight,
  ]
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex')
}

function invalidVerifiedAnchor(): never {
  throw new TypeError('Solana chain anchor is not fully verified')
}

function requireSolanaVerifiedChainAnchorInternal(evidence: unknown): SolanaVerifiedChainAnchor {
  const root = exactDataRecord(evidence, [
    'chain',
    'observedAt',
    'anchorPolicy',
    'genesisHash',
    'finalizedSlot',
    'finalizedBlock',
  ])
  if (!root) return invalidVerifiedAnchor()
  const chain = exactDataRecord(root.chain, ['cluster', 'genesisHash'])
  const policy = exactDataRecord(root.anchorPolicy, [
    'version',
    'genesisMethod',
    'slotMethod',
    'blockMethod',
    'commitment',
    'encoding',
    'transactionDetails',
    'maxSupportedTransactionVersion',
    'rewards',
    'maxFutureBlockSkewMs',
    'maxCurrentAnchorLagMs',
  ])
  const genesisLaneValue = parseAvailableLane(root.genesisHash)
  const slotLaneValue = parseAvailableLane(root.finalizedSlot)
  const blockLaneValue = parseAvailableLane(root.finalizedBlock)
  const finalizedSlot = slotLaneValue ? safeNonNegativeInteger(slotLaneValue.value) : null
  const finalizedBlock = blockLaneValue ? parseExactFinalizedBlock(blockLaneValue.value) : null
  const observedAtMs = canonicalTimestampMs(root.observedAt)
  const blockTimeMs = unixTimestampMs(finalizedBlock?.blockTime ?? null)
  if (
    !chain ||
    chain.cluster !== 'mainnet-beta' ||
    chain.genesisHash !== SOLANA_MAINNET_GENESIS_HASH ||
    !policy ||
    policy.version !== 'solana_current_finalized_block_v1' ||
    policy.genesisMethod !== 'getGenesisHash' ||
    policy.slotMethod !== 'getSlot' ||
    policy.blockMethod !== 'getBlock' ||
    policy.commitment !== 'finalized' ||
    policy.encoding !== 'json' ||
    policy.transactionDetails !== 'none' ||
    policy.maxSupportedTransactionVersion !== 0 ||
    policy.rewards !== false ||
    policy.maxFutureBlockSkewMs !== MAX_FUTURE_BLOCK_SKEW_MS ||
    policy.maxCurrentAnchorLagMs !== MAX_CURRENT_ANCHOR_LAG_MS ||
    !genesisLaneValue ||
    genesisLaneValue.value !== SOLANA_MAINNET_GENESIS_HASH ||
    !slotLaneValue ||
    finalizedSlot === null ||
    finalizedSlot <= 0 ||
    !blockLaneValue ||
    !finalizedBlock ||
    finalizedBlock.slot !== finalizedSlot ||
    (finalizedBlock.blockHeight !== null && finalizedBlock.blockHeight > finalizedSlot) ||
    observedAtMs === null ||
    blockTimeMs === null ||
    blockTimeMs > observedAtMs + MAX_FUTURE_BLOCK_SKEW_MS ||
    observedAtMs - blockTimeMs > MAX_CURRENT_ANCHOR_LAG_MS ||
    !sameEndpoint(genesisLaneValue.endpoint, slotLaneValue.endpoint) ||
    !sameEndpoint(genesisLaneValue.endpoint, blockLaneValue.endpoint)
  ) {
    return invalidVerifiedAnchor()
  }
  const endpoint = endpointCopy(genesisLaneValue.endpoint)
  const observedAt = new Date(observedAtMs).toISOString()
  return {
    chain: { cluster: 'mainnet-beta', genesisHash: SOLANA_MAINNET_GENESIS_HASH },
    anchorPolicy: {
      version: 'solana_current_finalized_block_v1',
      genesisMethod: 'getGenesisHash',
      slotMethod: 'getSlot',
      blockMethod: 'getBlock',
      commitment: 'finalized',
      encoding: 'json',
      transactionDetails: 'none',
      maxSupportedTransactionVersion: 0,
      rewards: false,
      maxFutureBlockSkewMs: MAX_FUTURE_BLOCK_SKEW_MS,
      maxCurrentAnchorLagMs: MAX_CURRENT_ANCHOR_LAG_MS,
    },
    endpoint,
    observedAt,
    genesisHash: SOLANA_MAINNET_GENESIS_HASH,
    finalizedSlot,
    finalizedBlock: copyFinalizedBlock(finalizedBlock),
    semanticHashPolicy: 'solana_verified_anchor_semantics_v1',
    semanticHash: solanaAnchorSemanticHash(endpoint, observedAt, finalizedBlock),
  }
}

/**
 * Deterministically revalidate capture-time freshness. This deliberately does
 * not consult Date.now(); callers needing present-time freshness must compare
 * observedAt with their own trusted clock before using a stored anchor.
 */
export function requireSolanaVerifiedChainAnchor(evidence: unknown): SolanaVerifiedChainAnchor {
  try {
    return requireSolanaVerifiedChainAnchorInternal(evidence)
  } catch {
    return invalidVerifiedAnchor()
  }
}

/**
 * Capture one mainnet identity + highest finalized slot/block observation from
 * one resolved endpoint. Provider failover requires restarting this function.
 * Never expose the local-node endpoint option directly to untrusted callers.
 */
export async function fetchSolanaChainAnchorEvidence(
  opts: SolanaEvidenceRpcOpts = {}
): Promise<SolanaChainAnchorEvidence> {
  const parsedOpts = parseOptsOrThrow(opts)
  const endpoint = resolveEndpoint(parsedOpts)
  const base = {
    chain: {
      cluster: 'mainnet-beta',
      genesisHash: SOLANA_MAINNET_GENESIS_HASH,
    } as const,
    anchorPolicy: {
      version: 'solana_current_finalized_block_v1',
      genesisMethod: 'getGenesisHash',
      slotMethod: 'getSlot',
      blockMethod: 'getBlock',
      commitment: 'finalized',
      encoding: 'json',
      transactionDetails: 'none',
      maxSupportedTransactionVersion: 0,
      rewards: false,
      maxFutureBlockSkewMs: MAX_FUTURE_BLOCK_SKEW_MS,
      maxCurrentAnchorLagMs: MAX_CURRENT_ANCHOR_LAG_MS,
    } as const,
  }
  if (!endpoint) {
    return {
      ...base,
      observedAt: new Date().toISOString(),
      genesisHash: unconfiguredLane(),
      finalizedSlot: unconfiguredLane(),
      finalizedBlock: unconfiguredLane(),
    }
  }

  const timeoutMs = parsedOpts.timeoutMs ?? 20_000
  const [genesisResult, slotResult] = await Promise.all([
    solanaEvidenceRpc(endpoint, 'getGenesisHash', [], timeoutMs),
    solanaEvidenceRpc(endpoint, 'getSlot', [{ commitment: 'finalized' }], timeoutMs),
  ])
  const genesisHash = genesisLane(genesisResult)
  const finalizedSlot = slotLane(slotResult)
  let finalizedBlock: SolanaEvidenceLane<SolanaFinalizedBlockEvidence> = dependencyUnavailableLane()
  if (finalizedSlot.status === 'available') {
    const blockResult = await solanaEvidenceRpc(
      endpoint,
      'getBlock',
      [
        finalizedSlot.value,
        {
          commitment: 'finalized',
          encoding: 'json',
          transactionDetails: 'none',
          maxSupportedTransactionVersion: 0,
          rewards: false,
        },
      ],
      timeoutMs
    )
    finalizedBlock = blockLane(blockResult, finalizedSlot.value)
  }

  return {
    ...base,
    observedAt: new Date().toISOString(),
    genesisHash,
    finalizedSlot,
    finalizedBlock,
  }
}
