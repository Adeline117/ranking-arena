/**
 * Strict, shadow-only BSC chain evidence.
 *
 * This module deliberately does not reuse the serving fetcher's permissive
 * JSON-RPC transport. Evidence must remain bound to one named endpoint, the
 * BSC mainnet genesis block, and BSC's standard economic-finality block tag.
 */

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
const QUANTITY_RE = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/

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
  local_bsc_node: { providerId: 'local', origin: null, allowAnyPath: true },
} as const

export type BscCallerEndpointId = keyof typeof CALLER_ENDPOINTS
export type BscEvidenceProviderId =
  | 'alchemy'
  | (typeof CALLER_ENDPOINTS)[BscCallerEndpointId]['providerId']

export interface BscEvidenceEndpointIdentity {
  providerId: BscEvidenceProviderId
  endpointId: string
}

export interface BscEvidenceProvider {
  servedBy: BscEvidenceEndpointIdentity | null
  attempted: BscEvidenceEndpointIdentity[]
}

export type BscEvidenceUnavailableReason =
  | 'provider_unconfigured'
  | 'not_found'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'timeout'
  | 'transport_error'
  | 'rpc_error'
  | 'response_too_large'
  | 'malformed_response'
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
}

interface BscRpcFailure {
  ok: false
  reason: Exclude<BscEvidenceUnavailableReason, 'not_found' | 'wrong_chain' | 'wrong_genesis'>
  provider: BscEvidenceProvider
  rpcCode: number | null
  httpStatus: number | null
}

type BscRpcResult = BscRpcSuccess | BscRpcFailure

function endpointCopy(endpoint: BscEvidenceEndpointIdentity): BscEvidenceEndpointIdentity {
  return { ...endpoint }
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
          (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
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
        identity: { providerId: config.providerId, endpointId: opts.endpointId },
      }
    } catch {
      return null
    }
  }

  const key = process.env.ALCHEMY_API_KEY
  if (!key || key.trim().length === 0) return null
  return {
    url: `https://bnb-mainnet.g.alchemy.com/v2/${encodeURIComponent(key)}`,
    identity: { providerId: 'alchemy', endpointId: 'alchemy_bnb_mainnet' },
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
          // The fixed reason is sufficient; never retain raw stream failures.
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
  timeoutMs: number
): Promise<BscRpcResult> {
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
      payload = responseText.text ? JSON.parse(responseText.text) : null
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
  reason: 'not_found' | 'malformed_response' | 'wrong_chain' | 'wrong_genesis'
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

function sameEndpoint(
  left: BscEvidenceEndpointIdentity,
  right: BscEvidenceEndpointIdentity
): boolean {
  return left.providerId === right.providerId && left.endpointId === right.endpointId
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

function parseApprovedEndpoint(value: unknown): BscEvidenceEndpointIdentity | null {
  const endpoint = exactDataRecord(value, ['providerId', 'endpointId'])
  if (
    !endpoint ||
    typeof endpoint.providerId !== 'string' ||
    typeof endpoint.endpointId !== 'string'
  ) {
    return null
  }
  if (endpoint.endpointId === 'alchemy_bnb_mainnet' && endpoint.providerId === 'alchemy') {
    return { providerId: 'alchemy', endpointId: 'alchemy_bnb_mainnet' }
  }
  if (!Object.hasOwn(CALLER_ENDPOINTS, endpoint.endpointId)) return null
  const endpointId = endpoint.endpointId as BscCallerEndpointId
  const expectedProvider = CALLER_ENDPOINTS[endpointId].providerId
  if (endpoint.providerId !== expectedProvider) return null
  return { providerId: expectedProvider, endpointId }
}

function parseSoleProvider(value: unknown): BscEvidenceEndpointIdentity | null {
  const provider = exactDataRecord(value, ['servedBy', 'attempted'])
  if (!provider || !Array.isArray(provider.attempted) || provider.attempted.length !== 1)
    return null
  const arrayKeys = Reflect.ownKeys(provider.attempted)
  const itemDescriptor = Object.getOwnPropertyDescriptor(provider.attempted, '0')
  if (
    arrayKeys.length !== 2 ||
    !arrayKeys.includes('0') ||
    !arrayKeys.includes('length') ||
    !itemDescriptor ||
    !itemDescriptor.enumerable ||
    !('value' in itemDescriptor)
  ) {
    return null
  }
  const servedBy = parseApprovedEndpoint(provider.servedBy)
  const attempted = parseApprovedEndpoint(itemDescriptor.value)
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
  return header ? parseBlockHeader(header) : null
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
export async function fetchBscChainAnchorEvidence(
  opts: BscEvidenceRpcOpts = {}
): Promise<BscChainAnchorEvidence> {
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
      ...base,
      observedAt: new Date().toISOString(),
      chainId: unconfiguredLane(),
      genesisBlock: unconfiguredLane(),
      finalizedBlock: unconfiguredLane(),
      headBlock: unconfiguredLane(),
    }
  }

  const timeoutMs = parsedOpts.timeoutMs ?? 20_000
  const [chainId, genesisBlock, finalizedBlock] = await Promise.all([
    bscEvidenceRpc(endpoint, 'eth_chainId', [], timeoutMs),
    bscEvidenceRpc(endpoint, 'eth_getBlockByNumber', ['0x0', false], timeoutMs),
    bscEvidenceRpc(endpoint, 'eth_getBlockByNumber', ['finalized', false], timeoutMs),
  ])
  // Fetch head after the cutoff so a moving chain cannot create a false
  // head-below-finalized result merely because parallel requests raced.
  const headBlock = await bscEvidenceRpc(
    endpoint,
    'eth_getBlockByNumber',
    ['latest', false],
    timeoutMs
  )

  return {
    ...base,
    observedAt: new Date().toISOString(),
    chainId: chainIdLane(chainId),
    genesisBlock: blockLane(genesisBlock, 'genesis'),
    finalizedBlock: blockLane(finalizedBlock, 'produced'),
    headBlock: blockLane(headBlock, 'produced'),
  }
}
