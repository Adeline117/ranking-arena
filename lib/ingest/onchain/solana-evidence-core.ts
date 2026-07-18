/**
 * Shared strict transport and serialized-evidence primitives for Solana
 * evidence capture. Domain-specific chain and transaction semantics belong in
 * their respective evidence modules.
 */

import { createHash } from 'node:crypto'

import { hasBase58DecodedByteLength } from '@/lib/utils/base58'

import { parseStrictJson } from './strict-json'
import {
  RAW_RPC_REQUEST_HASH_BASIS,
  RAW_RPC_RESPONSE_HASH_BASIS,
  disposeRawRpcBytes,
  encodeJsonRpcRequestBody,
  readBoundedRpcResponse,
  takeRawRpcBodyEvidence,
  type RawRpcBodyEvidence,
} from './raw-rpc-evidence'

const RPC_REQUEST_ID = 1
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const PROGRAM_ACCOUNTS_MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const MAX_TIMEOUT_MS = 120_000
export const DEFAULT_SOLANA_EVIDENCE_TIMEOUT_MS = 20_000
const PUBLICNODE_SOLANA_HISTORY_SETTLE_MS = 20_000
const CONNECTION_HASH_RE = /^[0-9a-f]{64}$/
const SOLANA_OFFICIAL_ORIGIN = 'https://api.mainnet-beta.solana.com'
const PUBLICNODE_SOLANA_ORIGIN = 'https://solana-rpc.publicnode.com'
const HELIUS_ORIGIN = 'https://mainnet.helius-rpc.com'
const ALCHEMY_SOLANA_ORIGIN = 'https://solana-mainnet.g.alchemy.com'

const CALLER_ENDPOINTS = {
  solana_official_mainnet: {
    providerId: 'solana_foundation',
    origin: SOLANA_OFFICIAL_ORIGIN,
    route: 'root',
  },
  publicnode_solana_mainnet: {
    providerId: 'publicnode',
    origin: PUBLICNODE_SOLANA_ORIGIN,
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
  | 'metadata_unavailable'
  | 'not_found_or_unavailable'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'timeout'
  | 'transport_error'
  | 'rpc_error'
  | 'response_too_large'
  | 'malformed_response'
  | 'evidence_capture_error'
  | 'unsupported_transaction_version'
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

export interface SolanaEvidenceRpcOpts {
  /** A single approved endpoint. endpointId is mandatory when this is set. */
  rpcUrl?: string
  endpointId?: SolanaEvidenceEndpointId
  /** Per JSON-RPC request; anchor capture has three sequential request rounds. */
  timeoutMs?: number
}

/** Ephemeral only: url may contain credentials and must never enter evidence. */
export interface SolanaEvidenceEndpoint {
  url: string
  identity: SolanaEvidenceEndpointIdentity
}

export interface ParsedSolanaEvidenceRpcOpts {
  rpcUrl: string | undefined
  endpointId: SolanaEvidenceEndpointId | undefined
  timeoutMs: number | undefined
}

export interface SolanaRpcSuccess {
  ok: true
  result: unknown
  provider: SolanaEvidenceProvider
  httpStatus: number | null
  /** Present only for an explicit in-memory raw capture request. */
  rawExchange?: SolanaRawRpcEvidenceExchange
}

export interface SolanaRpcFailure {
  ok: false
  reason: Exclude<
    SolanaEvidenceUnavailableReason,
    | 'provider_unconfigured'
    | 'dependency_unavailable'
    | 'metadata_unavailable'
    | 'not_found_or_unavailable'
    | 'unsupported_transaction_version'
    | 'wrong_genesis'
  >
  provider: SolanaEvidenceProvider
  rpcCode: number | null
  httpStatus: number | null
}

export type SolanaRpcResult = SolanaRpcSuccess | SolanaRpcFailure

export const SOLANA_RAW_RPC_EVIDENCE_LANES = [
  'genesis_hash',
  'finalized_anchor_slot',
  'finalized_anchor_produced_slots',
  'finalized_anchor_block',
  'transaction',
  'signature_status',
  'membership_block',
  'program_accounts',
] as const

export type SolanaRawRpcEvidenceLane = (typeof SOLANA_RAW_RPC_EVIDENCE_LANES)[number]

const SOLANA_RAW_RPC_LANE_METHODS: Record<SolanaRawRpcEvidenceLane, string> = {
  genesis_hash: 'getGenesisHash',
  finalized_anchor_slot: 'getSlot',
  finalized_anchor_produced_slots: 'getBlocks',
  finalized_anchor_block: 'getBlock',
  transaction: 'getTransaction',
  signature_status: 'getSignatureStatuses',
  membership_block: 'getBlock',
  program_accounts: 'getMultipleAccounts',
}

export function disposeSolanaRawRpcEvidenceExchanges(
  exchanges: readonly SolanaRawRpcEvidenceExchange[]
): void {
  let failed = false
  for (const exchange of exchanges) {
    for (const bytes of [exchange.request.bytes, exchange.response.bytes]) {
      try {
        disposeRawRpcBytes(bytes)
      } catch {
        failed = true
      }
    }
  }
  if (failed) throw new TypeError('Solana raw RPC evidence bytes could not all be cleared')
}

export interface SolanaRawRpcEvidenceExchange {
  chain: 'solana'
  trustBoundary: 'json_rpc_result_transport_only_semantic_lane_not_yet_verified'
  lane: SolanaRawRpcEvidenceLane
  method: string
  endpoint: SolanaEvidenceEndpointIdentity
  httpStatus: number
  completedAt: string
  request: RawRpcBodyEvidence & {
    hashBasis: typeof RAW_RPC_REQUEST_HASH_BASIS
  }
  response: RawRpcBodyEvidence & {
    hashBasis: typeof RAW_RPC_RESPONSE_HASH_BASIS
  }
}

export interface SolanaRawRpcCapture {
  lane: SolanaRawRpcEvidenceLane
}

type SolanaProgramAccountsRpcParams = [
  [programId: string, programDataAddress: string],
  {
    commitment: 'finalized'
    encoding: 'base64'
    minContextSlot: number
  },
]

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function endpointConnectionHash(providerId: string, endpointId: string, rpcOrigin: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['solana_evidence_connection_v1', providerId, endpointId, rpcOrigin]))
    .digest('hex')
}

export function endpointCopy(
  endpoint: SolanaEvidenceEndpointIdentity
): SolanaEvidenceEndpointIdentity {
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

export function parseOptsOrThrow(input: SolanaEvidenceRpcOpts): ParsedSolanaEvidenceRpcOpts {
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

export function resolveEndpoint(opts: ParsedSolanaEvidenceRpcOpts): SolanaEvidenceEndpoint | null {
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

function endpointSecretFragments(
  url: string,
  endpointId: SolanaEvidenceEndpointId
): string[] | null {
  try {
    const parsed = new URL(url)
    let encoded = ''
    let decoded = ''
    if (endpointId === 'helius_solana_mainnet') {
      decoded = parsed.searchParams.get('api-key') ?? ''
      const rawPair = parsed.search
        .slice(1)
        .split('&')
        .find((pair) => pair.startsWith('api-key='))
      encoded = rawPair?.slice('api-key='.length) ?? ''
    } else if (endpointId === 'alchemy_solana_mainnet') {
      encoded = parsed.pathname.split('/').filter(Boolean).at(-1) ?? ''
      try {
        decoded = decodeURIComponent(encoded)
      } catch {
        decoded = ''
      }
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

function parseRawCapture(value: unknown): SolanaRawRpcCapture | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new TypeError('invalid Solana raw RPC evidence capture')
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
    !SOLANA_RAW_RPC_EVIDENCE_LANES.includes(laneDescriptor.value as SolanaRawRpcEvidenceLane)
  ) {
    throw new TypeError('invalid Solana raw RPC evidence capture')
  }
  return { lane: laneDescriptor.value as SolanaRawRpcEvidenceLane }
}

function parseProgramAccountsRpcParams(value: unknown): SolanaProgramAccountsRpcParams | null {
  try {
    const params = exactDenseArray(value)
    if (!params || params.length !== 2) return null
    const addresses = exactDenseArray(params[0])
    const config = exactDataRecord(params[1], ['commitment', 'encoding', 'minContextSlot'])
    if (
      !addresses ||
      addresses.length !== 2 ||
      !hasBase58DecodedByteLength(addresses[0], 32) ||
      !hasBase58DecodedByteLength(addresses[1], 32) ||
      addresses[0] === addresses[1] ||
      !config ||
      config.commitment !== 'finalized' ||
      config.encoding !== 'base64' ||
      typeof config.minContextSlot !== 'number' ||
      !Number.isSafeInteger(config.minContextSlot) ||
      config.minContextSlot <= 0 ||
      Object.is(config.minContextSlot, -0)
    ) {
      return null
    }
    return [
      [addresses[0], addresses[1]],
      {
        commitment: 'finalized',
        encoding: 'base64',
        minContextSlot: config.minContextSlot,
      },
    ]
  } catch {
    return null
  }
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

export async function solanaEvidenceRpc(
  endpoint: SolanaEvidenceEndpoint,
  method: string,
  params: unknown[],
  timeoutMs: number,
  rawCapture?: SolanaRawRpcCapture
): Promise<SolanaRpcResult> {
  let parsedRawCapture: SolanaRawRpcCapture | undefined
  let requestParams = params
  try {
    parsedRawCapture = parseRawCapture(rawCapture)
  } catch {
    throw new TypeError('invalid Solana raw RPC evidence capture')
  }
  if (parsedRawCapture && SOLANA_RAW_RPC_LANE_METHODS[parsedRawCapture.lane] !== method) {
    throw new TypeError('invalid Solana raw RPC evidence capture')
  }
  if (parsedRawCapture?.lane === 'program_accounts') {
    const parsedParams = parseProgramAccountsRpcParams(params)
    if (!parsedParams) throw new TypeError('invalid Solana raw RPC evidence capture')
    requestParams = parsedParams
  }
  if (endpoint.identity.endpointId === 'publicnode_solana_mainnet' && method === 'getBlocks') {
    // PublicNode can expose a finalized getSlot context before its getBlocks
    // history surface catches up. This fixed one-shot transport accommodation
    // neither refreshes the pinned root nor proves any chain slot semantics.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, PUBLICNODE_SOLANA_HISTORY_SETTLE_MS)
    })
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let requestBytes: Uint8Array | null = null
  let responseBytes: Uint8Array | null = null
  let rawExchangeOwnershipTransferred = false
  try {
    const requestBody = encodeJsonRpcRequestBody(RPC_REQUEST_ID, method, requestParams)
    requestBytes = requestBody.evidence.bytes
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
      parsedRawCapture?.lane === 'program_accounts'
        ? PROGRAM_ACCOUNTS_MAX_RESPONSE_BYTES
        : MAX_RESPONSE_BYTES,
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
    responseBytes = responseText.bytes
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
    let rawExchange: SolanaRawRpcEvidenceExchange | undefined
    if (parsedRawCapture) {
      if (httpStatus === null || responseText.bytes === null) {
        return rpcFailure(endpoint.identity, 'evidence_capture_error', null, httpStatus)
      }
      const secretFragments = endpointSecretFragments(endpoint.url, endpoint.identity.endpointId)
      if (
        secretFragments === null ||
        secretFragments.some(
          (secret) => requestBody.text.includes(secret) || responseText.text.includes(secret)
        )
      ) {
        return rpcFailure(endpoint.identity, 'evidence_capture_error', null, httpStatus)
      }
      rawExchange = {
        chain: 'solana',
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
          ...takeRawRpcBodyEvidence(responseText.bytes),
          hashBasis: RAW_RPC_RESPONSE_HASH_BASIS,
        },
      }
    }
    const result: SolanaRpcSuccess = {
      ok: true,
      result: payload.result,
      provider: providerEvidence(endpoint.identity, [endpoint.identity]),
      httpStatus,
      ...(rawExchange ? { rawExchange } : {}),
    }
    rawExchangeOwnershipTransferred = rawExchange !== undefined
    return result
  } catch (error) {
    return rpcFailure(endpoint.identity, timeoutError(error) ? 'timeout' : 'transport_error')
  } finally {
    clearTimeout(timer)
    if (!rawExchangeOwnershipTransferred) {
      disposeRawRpcBytes(requestBytes)
      disposeRawRpcBytes(responseBytes)
    }
  }
}

export function unavailableFromRpc(result: SolanaRpcFailure): SolanaEvidenceUnavailable {
  return {
    status: 'unavailable',
    reason: result.reason,
    provider: result.provider,
    rpcCode: result.rpcCode,
    httpStatus: result.httpStatus,
  }
}

export function unavailableFromSuccess(
  result: SolanaRpcSuccess,
  reason:
    | 'metadata_unavailable'
    | 'not_found_or_unavailable'
    | 'malformed_response'
    | 'unsupported_transaction_version'
    | 'wrong_genesis'
): SolanaEvidenceUnavailable {
  return {
    status: 'unavailable',
    reason,
    provider: result.provider,
    rpcCode: null,
    httpStatus: result.httpStatus,
  }
}

export function unconfiguredLane(): SolanaEvidenceUnavailable {
  return {
    status: 'unavailable',
    reason: 'provider_unconfigured',
    provider: providerEvidence(null, []),
    rpcCode: null,
    httpStatus: null,
  }
}

export function dependencyUnavailableLane(): SolanaEvidenceUnavailable {
  return {
    status: 'unavailable',
    reason: 'dependency_unavailable',
    provider: providerEvidence(null, []),
    rpcCode: null,
    httpStatus: null,
  }
}

export function safeNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    !Object.is(value, -0)
    ? value
    : null
}

export function exactDataRecord(
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

export function exactDenseArray(value: unknown): unknown[] | null {
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

export function parseApprovedEndpoint(value: unknown): SolanaEvidenceEndpointIdentity | null {
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

export function sameEndpoint(
  left: SolanaEvidenceEndpointIdentity,
  right: SolanaEvidenceEndpointIdentity
): boolean {
  return (
    left.providerId === right.providerId &&
    left.endpointId === right.endpointId &&
    left.connectionHash === right.connectionHash
  )
}

export function parseSoleProvider(value: unknown): SolanaEvidenceEndpointIdentity | null {
  const provider = exactDataRecord(value, ['servedBy', 'attempted'])
  const attempted = provider ? exactDenseArray(provider.attempted) : null
  if (!provider || !attempted || attempted.length !== 1) return null
  const servedBy = parseApprovedEndpoint(provider.servedBy)
  const attemptedEndpoint = parseApprovedEndpoint(attempted[0])
  if (!servedBy || !attemptedEndpoint || !sameEndpoint(servedBy, attemptedEndpoint)) return null
  return servedBy
}

export function parseAvailableLane(
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

export function canonicalTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return null
  return parsed
}
