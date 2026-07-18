/**
 * Solana on-chain fetcher (Phase A network half; decoder is solana-swaps.ts).
 *
 * getSignaturesForAddress (paginated, time-bounded) → getTransaction per sig
 * (jsonParsed) → extract the balance-delta {@link SolTxMeta} → decode → PnL.
 * Uses the shared ALCHEMY_API_KEY (Solana network enabled 2026-07-01); $0 on
 * the free tier for the top-N deep-profile scope.
 */

import { Buffer } from 'node:buffer'
import { isProxy } from 'node:util/types'

import { decodeBase58BytesBounded, hasBase58DecodedByteLength } from '@/lib/utils/base58'

import { decodeSolanaSwaps, type SolTxMeta, type SolTokenBalance } from './solana-swaps'
import { computeWalletPnl, type WalletPnl } from './pnl-accounting'

function alchemySolUrl(): string {
  const key = process.env.ALCHEMY_API_KEY
  if (!key) throw new Error('[onchain] ALCHEMY_API_KEY missing')
  return `https://solana-mainnet.g.alchemy.com/v2/${key}`
}

/** Quota-exhausted = provider is dead for the rest of this process — retrying
 *  the SAME provider is pointless (2026-07-11 事故:Helius 日配额耗尽,夜扫
 *  877/900 原地失败,Alchemy 备胎全程没被用上)。 */
export function isQuotaExhausted(msg: string): boolean {
  const m = msg.toLowerCase()
  return (
    m.includes('max usage') ||
    m.includes('usage limit') ||
    m.includes('capacity limit') ||
    m.includes('quota') ||
    m.includes('credits exhausted') ||
    m.includes('payment required') ||
    m.includes('402')
  )
}

/** Sticky per-process failover: once Helius reports quota exhausted, all
 *  subsequent calls go to Alchemy (identical JSON-RPC). */
let heliusExhausted = false

export type SolanaProviderId = 'helius' | 'alchemy' | 'caller_supplied'
// Runtime constants: an outer instruction is carried inside the 1,232-byte
// transaction packet, while a CPI instruction may carry up to 10 KiB.
export const SOLANA_PACKET_DATA_SIZE_BYTES = 1_232
export const SOLANA_MAX_CPI_INSTRUCTION_DATA_BYTES = 10_240
export const SOLANA_MAX_INSTRUCTION_TRACE_LENGTH = 64
const SOLANA_MAX_CPI_INSTRUCTION_ACCOUNTS = 255
const SOLANA_MAX_TRANSACTION_SIGNATURES = 19
const SOLANA_MAX_RESOLVED_ACCOUNT_KEYS = 256
const SOLANA_MAX_ADDRESS_TABLE_LOOKUPS = 255
const SOLANA_MAX_TOKEN_BALANCES = 256
const SOLANA_MAX_LOG_MESSAGES = 10_000
const SOLANA_MAX_LOG_MESSAGE_UTF8_BYTES = 10_000
const SOLANA_MAX_LOG_TOTAL_UTF8_BYTES = 10_240
const SOLANA_MAX_ERROR_JSON_NODES = 1_024
const SOLANA_MAX_ERROR_JSON_DEPTH = 16
const SOLANA_MAX_ERROR_ARRAY_LENGTH = 256
const SOLANA_MAX_ERROR_OBJECT_KEYS = 64
const SOLANA_MAX_ERROR_STRING_UTF8_BYTES = 20_480
const TYPED_ARRAY_FILL = Uint8Array.prototype.fill
const TYPED_ARRAY_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  'length'
)?.get
// A compiled instruction needs at least three bytes on the wire (program id
// index plus empty account/data shortvecs), so this is a conservative absolute
// count ceiling that cannot reject a packet which actually fits.
export const SOLANA_MAX_DECLARED_OUTER_INSTRUCTIONS = Math.floor(SOLANA_PACKET_DATA_SIZE_BYTES / 3)

interface SolanaEndpoint {
  url: string
  providerId: SolanaProviderId
}

interface RpcOpts {
  rpcUrl?: string
  timeoutMs?: number
}

/**
 * Prefer Helius when configured (owner-provided 2026-07-09, Phase B full-scale
 * quota), fall back to Alchemy. Both speak identical Solana JSON-RPC — only
 * the URL differs, so provider choice stays a pure env concern.
 */
function solDefaultEndpoint(): SolanaEndpoint {
  const helius = process.env.HELIUS_API_KEY
  if (helius && !heliusExhausted) {
    return {
      url: `https://mainnet.helius-rpc.com/?api-key=${helius}`,
      providerId: 'helius',
    }
  }
  return { url: alchemySolUrl(), providerId: 'alchemy' }
}

function resolveSolEndpoint(opts: RpcOpts): SolanaEndpoint {
  if (typeof opts.rpcUrl === 'string') {
    return { url: opts.rpcUrl, providerId: 'caller_supplied' }
  }
  return solDefaultEndpoint()
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Retryable = throughput/rate-limit/transient (429, CU cap, empty body). */
function isTransient(msg: string): boolean {
  const m = msg.toLowerCase()
  return (
    m.includes('compute unit') ||
    m.includes('throughput') ||
    m.includes('rate') ||
    m.includes('429') ||
    m.includes('unexpected end of json') ||
    m.includes('timeout') ||
    m.includes('aborted') ||
    m.includes('fetch failed') ||
    m.includes('econnreset')
  )
}

interface SolanaRpcCall<T> {
  result: T
  providerId: SolanaProviderId
  attemptedProviderIds: SolanaProviderId[]
}

/** Same transport semantics as solRpc, with stable provider provenance only.
 * URLs are deliberately excluded because provider URLs may contain API keys. */
async function solRpcWithProvenance<T>(
  method: string,
  params: unknown[],
  opts: RpcOpts = {}
): Promise<SolanaRpcCall<T>> {
  const attempts = 5
  const attemptedProviderIds: SolanaProviderId[] = []
  for (let i = 0; i < attempts; i++) {
    // Re-resolve per attempt — a quota failover mid-loop must take effect.
    const endpoint = resolveSolEndpoint(opts)
    if (!attemptedProviderIds.includes(endpoint.providerId)) {
      attemptedProviderIds.push(endpoint.providerId)
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000)
    try {
      const res = await fetch(endpoint.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: ctrl.signal,
      })
      const text = await res.text()
      const json = (text ? JSON.parse(text) : {}) as { result?: T; error?: { message?: string } }
      if (json.error) throw new Error(`sol ${method}: ${json.error.message ?? 'error'}`)
      return {
        result: json.result as T,
        providerId: endpoint.providerId,
        attemptedProviderIds: [...attemptedProviderIds],
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Provider quota dead → sticky-switch to Alchemy and retry immediately
      // (only when the caller didn't pin rpcUrl and a fallback key exists).
      if (
        !opts.rpcUrl &&
        !heliusExhausted &&
        isQuotaExhausted(msg) &&
        process.env.HELIUS_API_KEY &&
        process.env.ALCHEMY_API_KEY
      ) {
        heliusExhausted = true
        console.warn('[onchain] Helius quota exhausted — sticky failover to Alchemy')
        if (i < attempts - 1) continue
      }
      if (i < attempts - 1 && isTransient(msg)) {
        await sleep(400 * 2 ** i) // 400,800,1600,3200ms backoff
        continue
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(`sol ${method}: exhausted retries`)
}

async function solRpc<T>(method: string, params: unknown[], opts: RpcOpts = {}): Promise<T> {
  return (await solRpcWithProvenance<T>(method, params, opts)).result
}

interface SigInfo {
  signature: string
  blockTime: number | null
  err: unknown
}

export interface SolanaSignatureCoverage {
  scanComplete: boolean
  truncated: boolean
  stopReason: 'lookback_boundary' | 'history_exhausted' | 'record_cap' | 'page_cap'
  pagesFetched: number
  recordsSeen: number
  recordsReturned: number
  recordsMissingTimestamp: number
}

export interface SolanaSignatureScan {
  signatures: string[]
  coverage: SolanaSignatureCoverage
}

export type SolanaRpcJson =
  | null
  | boolean
  | number
  | string
  | SolanaRpcJson[]
  | { [key: string]: SolanaRpcJson }

export type SolanaTransactionError = string | { [key: string]: SolanaRpcJson }

export interface SolanaSignatureRecord {
  signature: string
  slot: number
  blockTime: number | null
  memo: string | null
  confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null
  executionError: SolanaTransactionError | null
  providerId: SolanaProviderId
}

export interface SolanaSignatureRecordCoverage {
  scanComplete: boolean
  truncated: boolean
  stopReason: 'lookback_boundary' | 'history_exhausted' | 'record_cap' | 'page_cap'
  commitmentRequested: 'finalized'
  pagesFetched: number
  recordsSeen: number
  recordsReturned: number
  failedRecords: number
  recordsMissingTimestamp: number
  recordsNotFinalized: number
  duplicateRecords: number
  orderingViolations: number
  windowBoundaryViolations: number
  recordsAboveWindow: number
  sinceMs: number
  endExclusiveMs: number | null
  initialBefore: string | null
  nextBefore: string | null
  boundaryRecord: SolanaSignatureRecord | null
  providersAttempted: SolanaProviderId[]
}

export interface SolanaSignatureRecordScan {
  records: SolanaSignatureRecord[]
  coverage: SolanaSignatureRecordCoverage
}

function isSolanaSignature(value: string): boolean {
  return value.length >= 64 && value.length <= 100 && hasBase58DecodedByteLength(value, 64)
}

function normalizeSignatureRecord(
  value: unknown,
  providerId: SolanaProviderId
): SolanaSignatureRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('sol getSignaturesForAddress: invalid record')
  }
  const row = value as Record<string, unknown>
  if (typeof row.signature !== 'string' || !isSolanaSignature(row.signature)) {
    throw new Error('sol getSignaturesForAddress: invalid signature')
  }
  if (!Number.isSafeInteger(row.slot) || Number(row.slot) < 0) {
    throw new Error('sol getSignaturesForAddress: invalid slot')
  }

  const blockTime = row.blockTime ?? null
  if (blockTime !== null && (!Number.isSafeInteger(blockTime) || Number(blockTime) < 0)) {
    throw new Error('sol getSignaturesForAddress: invalid blockTime')
  }
  const memo = row.memo ?? null
  if (memo !== null && typeof memo !== 'string') {
    throw new Error('sol getSignaturesForAddress: invalid memo')
  }
  const confirmationStatus = row.confirmationStatus ?? null
  if (
    confirmationStatus !== null &&
    confirmationStatus !== 'processed' &&
    confirmationStatus !== 'confirmed' &&
    confirmationStatus !== 'finalized'
  ) {
    throw new Error('sol getSignaturesForAddress: invalid confirmationStatus')
  }
  if (!Object.hasOwn(row, 'err')) {
    throw new Error('sol getSignaturesForAddress: missing err')
  }
  const executionError = row.err
  if (
    executionError !== null &&
    typeof executionError !== 'string' &&
    (!executionError || typeof executionError !== 'object' || Array.isArray(executionError))
  ) {
    throw new Error('sol getSignaturesForAddress: invalid err')
  }

  return {
    signature: row.signature,
    slot: Number(row.slot),
    blockTime: blockTime as number | null,
    memo: memo as string | null,
    confirmationStatus: confirmationStatus as SolanaSignatureRecord['confirmationStatus'],
    executionError: executionError as SolanaTransactionError | null,
    providerId,
  }
}

/**
 * Evidence-only signature scan. Unlike the production PnL scan, this retains
 * failed transactions and every provider field needed to classify a fixed
 * finalized window. maxRecords is a raw-record budget, not a success budget.
 */
export async function scanSignatureRecords(
  wallet: string,
  opts: RpcOpts & {
    sinceMs?: number
    endExclusiveMs?: number
    initialBefore?: string
    maxRecords?: number
    maxPages?: number
  } = {}
): Promise<SolanaSignatureRecordScan> {
  const sinceMs = opts.sinceMs ?? 0
  if (!Number.isSafeInteger(sinceMs) || sinceMs < 0) {
    throw new RangeError('sinceMs must be a non-negative safe integer')
  }
  const sinceSec = sinceMs / 1000
  const endExclusiveMs = opts.endExclusiveMs ?? 0
  if (!Number.isSafeInteger(endExclusiveMs) || endExclusiveMs < 0) {
    throw new RangeError('endExclusiveMs must be a non-negative safe integer')
  }
  if (endExclusiveMs > 0 && endExclusiveMs <= sinceMs) {
    throw new RangeError('endExclusiveMs must be greater than sinceMs')
  }
  const endExclusiveSec = endExclusiveMs / 1000
  if (opts.initialBefore !== undefined && !isSolanaSignature(opts.initialBefore)) {
    throw new TypeError('initialBefore must be a base58-encoded 64-byte signature')
  }
  const maxRecords = opts.maxRecords ?? 1000
  if (!Number.isSafeInteger(maxRecords) || maxRecords <= 0) {
    throw new RangeError('maxRecords must be a positive safe integer')
  }
  const maxPages = opts.maxPages ?? Math.max(1, Math.ceil(maxRecords / 1000))
  if (!Number.isSafeInteger(maxPages) || maxPages <= 0) {
    throw new RangeError('maxPages must be a positive safe integer')
  }

  const records: SolanaSignatureRecord[] = []
  const providersAttempted: SolanaProviderId[] = []
  let before = opts.initialBefore
  let pagesFetched = 0
  let recordsSeen = 0
  let failedRecords = 0
  let recordsMissingTimestamp = 0
  let recordsNotFinalized = 0
  let duplicateRecords = 0
  let orderingViolations = 0
  let windowBoundaryViolations = 0
  let recordsAboveWindow = 0
  let previousSlot: number | null = null
  let lastRawRecord: SolanaSignatureRecord | null = null
  let boundaryRecord: SolanaSignatureRecord | null = null
  const seenSignatures = new Set<string>()

  const finish = (
    stopReason: SolanaSignatureRecordCoverage['stopReason']
  ): SolanaSignatureRecordScan => ({
    records,
    coverage: {
      scanComplete:
        stopReason !== 'record_cap' &&
        stopReason !== 'page_cap' &&
        recordsMissingTimestamp === 0 &&
        recordsNotFinalized === 0 &&
        duplicateRecords === 0 &&
        orderingViolations === 0 &&
        windowBoundaryViolations === 0,
      truncated: stopReason === 'record_cap' || stopReason === 'page_cap',
      stopReason,
      commitmentRequested: 'finalized',
      pagesFetched,
      recordsSeen,
      recordsReturned: records.length,
      failedRecords,
      recordsMissingTimestamp,
      recordsNotFinalized,
      duplicateRecords,
      orderingViolations,
      windowBoundaryViolations,
      recordsAboveWindow,
      sinceMs,
      endExclusiveMs: endExclusiveMs || null,
      initialBefore: opts.initialBefore ?? null,
      nextBefore:
        stopReason === 'record_cap' || stopReason === 'page_cap'
          ? (lastRawRecord?.signature ?? null)
          : null,
      boundaryRecord,
      providersAttempted,
    },
  })

  while (recordsSeen < maxRecords) {
    if (pagesFetched >= maxPages) return finish('page_cap')
    const remaining = maxRecords - recordsSeen
    const requestLimit = Math.min(1000, remaining)
    let call: SolanaRpcCall<unknown>
    try {
      call = await solRpcWithProvenance<unknown>(
        'getSignaturesForAddress',
        [
          wallet,
          {
            commitment: 'finalized',
            limit: requestLimit,
            ...(before ? { before } : {}),
          },
        ],
        opts
      )
    } catch {
      throw new Error('sol getSignaturesForAddress: RPC request failed')
    }
    pagesFetched += 1
    for (const providerId of call.attemptedProviderIds) {
      if (!providersAttempted.includes(providerId)) providersAttempted.push(providerId)
    }
    if (!Array.isArray(call.result)) {
      throw new Error('sol getSignaturesForAddress: invalid result')
    }
    if (call.result.length > requestLimit) {
      throw new Error('sol getSignaturesForAddress: result exceeds requested limit')
    }
    if (call.result.length === 0) return finish('history_exhausted')
    recordsSeen += call.result.length

    for (const raw of call.result) {
      const record = normalizeSignatureRecord(raw, call.providerId)
      lastRawRecord = record
      if (seenSignatures.has(record.signature)) duplicateRecords += 1
      seenSignatures.add(record.signature)
      if (previousSlot !== null && record.slot > previousSlot) orderingViolations += 1
      previousSlot = record.slot
      if (record.confirmationStatus !== 'finalized') {
        recordsNotFinalized += 1
      }
      if (sinceSec && record.blockTime !== null && record.blockTime < sinceSec) {
        boundaryRecord ??= record
        continue
      }
      if (boundaryRecord !== null && record.blockTime !== null && record.blockTime >= sinceSec) {
        windowBoundaryViolations += 1
      }
      if (endExclusiveSec && record.blockTime !== null && record.blockTime >= endExclusiveSec) {
        recordsAboveWindow += 1
        continue
      }
      records.push(record)
      if (record.executionError !== null) failedRecords += 1
      if (record.blockTime === null) recordsMissingTimestamp += 1
    }
    if (boundaryRecord !== null) return finish('lookback_boundary')
    if (call.result.length < requestLimit) return finish('history_exhausted')
    if (recordsSeen >= maxRecords) return finish('record_cap')
    before = lastRawRecord?.signature
  }
  return finish('record_cap')
}

/**
 * Paginated signatures for an address, newest first, with explicit proof of
 * why the scan stopped. A record cap is always conservative truncation: a page
 * containing exactly the requested remainder cannot prove history exhaustion.
 */
export async function scanSignatures(
  wallet: string,
  opts: RpcOpts & { sinceMs?: number; maxSigs?: number; maxPages?: number } = {}
): Promise<SolanaSignatureScan> {
  const sinceSec = opts.sinceMs ? opts.sinceMs / 1000 : 0
  const maxSigs = opts.maxSigs ?? 1000
  if (!Number.isSafeInteger(maxSigs) || maxSigs <= 0) {
    throw new RangeError('maxSigs must be a positive safe integer')
  }
  // A successful-signature cap alone is not a network budget: an address with
  // many failed transactions could otherwise paginate indefinitely. Default to
  // the minimum pages needed for maxSigs when every returned record succeeds.
  const maxPages = opts.maxPages ?? Math.max(1, Math.ceil(maxSigs / 1000))
  if (!Number.isSafeInteger(maxPages) || maxPages <= 0) {
    throw new RangeError('maxPages must be a positive safe integer')
  }
  const sigs: string[] = []
  let before: string | undefined
  let pagesFetched = 0
  let recordsSeen = 0
  let recordsMissingTimestamp = 0

  const finish = (stopReason: SolanaSignatureCoverage['stopReason']): SolanaSignatureScan => ({
    signatures: sigs,
    coverage: {
      scanComplete:
        stopReason !== 'record_cap' && stopReason !== 'page_cap' && recordsMissingTimestamp === 0,
      truncated: stopReason === 'record_cap' || stopReason === 'page_cap',
      stopReason,
      pagesFetched,
      recordsSeen,
      recordsReturned: sigs.length,
      recordsMissingTimestamp,
    },
  })

  while (sigs.length < maxSigs) {
    if (pagesFetched >= maxPages) return finish('page_cap')
    const remaining = maxSigs - sigs.length
    const requestLimit = Math.min(1000, remaining)
    const batch = await solRpc<SigInfo[]>(
      'getSignaturesForAddress',
      [wallet, { limit: requestLimit, ...(before ? { before } : {}) }],
      opts
    )
    pagesFetched += 1
    if (!Array.isArray(batch)) {
      throw new Error('sol getSignaturesForAddress: invalid result')
    }
    if (batch.length === 0) return finish('history_exhausted')
    recordsSeen += batch.length

    for (const s of batch) {
      // Test the boundary before skipping failed transactions: a failed old
      // transaction is still valid chronological evidence that the requested
      // window has been fully crossed.
      if (sinceSec && s.blockTime !== null && s.blockTime < sinceSec) {
        return finish('lookback_boundary')
      }
      if (s.err) continue // failed tx — no balance change of interest
      if (s.blockTime === null) recordsMissingTimestamp += 1
      if (sigs.length >= maxSigs) return finish('record_cap')
      sigs.push(s.signature)
      if (sigs.length >= maxSigs) return finish('record_cap')
    }
    if (batch.length < requestLimit) return finish('history_exhausted')
    before = batch[batch.length - 1].signature
  }
  return finish('record_cap')
}

/** Compatibility wrapper for callers that only need the bounded signatures. */
export async function fetchSignatures(
  wallet: string,
  opts: RpcOpts & { sinceMs?: number; maxSigs?: number; maxPages?: number } = {}
): Promise<string[]> {
  return (await scanSignatures(wallet, opts)).signatures
}

export interface SolanaProviderEvidence {
  servedBy: SolanaProviderId | null
  attempted: SolanaProviderId[]
}

export type SolanaTxUnavailableReason =
  | 'provider_unconfigured'
  | 'not_found'
  | 'metadata_unavailable'
  | 'unsupported_transaction_version'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'timeout'
  | 'transport_error'
  | 'rpc_error'
  | 'malformed_response'

export interface SolanaAddressTableLookupEvidence {
  tableAccount: string
  writableIndexes: number[]
  readonlyIndexes: number[]
}

export interface SolanaResolvedAccountKey {
  index: number
  pubkey: string
  source: 'transaction' | 'lookupTable'
  signer: boolean
  writable: boolean
  lookup: { tableAccount: string; tableIndex: number } | null
}

export type SolanaInstructionPath =
  | { kind: 'outer'; outerIndex: number }
  | { kind: 'inner'; outerIndex: number; innerIndex: number }

export interface SolanaInstructionEvidence {
  path: SolanaInstructionPath
  programIdIndex: number
  programId: string
  accountIndexes: number[]
  accounts: string[]
  dataBase58: string
  stackHeight: number | null
}

export interface SolanaTokenBalanceEvidence {
  accountIndex: number
  account: string
  mint: string
  owner: string | null
  tokenProgram: string | null
  rawAmount: string
  decimals: number
}

export interface SolanaTxEvidenceAvailable {
  status: 'available'
  signature: string
  provider: SolanaProviderEvidence
  commitmentRequested: 'finalized'
  encoding: 'json'
  maxSupportedTransactionVersion: 0
  slot: number
  blockTime: number | null
  version: 'legacy' | 0
  executionStatus: 'succeeded' | 'failed'
  executionError: SolanaTransactionError | null
  feeLamports: number
  computeUnitsConsumed: number | null
  staticAccountKeys: string[]
  addressTableLookups: SolanaAddressTableLookupEvidence[]
  loadedAddresses: { writable: string[]; readonly: string[] }
  accountKeys: SolanaResolvedAccountKey[]
  preBalancesLamports: number[]
  postBalancesLamports: number[]
  preTokenBalances: SolanaTokenBalanceEvidence[] | null
  postTokenBalances: SolanaTokenBalanceEvidence[] | null
  innerInstructionsStatus: 'present' | 'verified_empty' | 'unavailable'
  instructions: SolanaInstructionEvidence[]
  logMessages: string[] | null
}

export interface SolanaTxEvidenceUnavailable {
  status: 'unavailable'
  signature: string
  provider: SolanaProviderEvidence
  reason: SolanaTxUnavailableReason
  rpcCode: number | null
  httpStatus: number | null
}

export type SolanaTxEvidence = SolanaTxEvidenceAvailable | SolanaTxEvidenceUnavailable
export type SolanaNormalizedTxResult = Omit<
  SolanaTxEvidenceAvailable,
  'provider' | 'commitmentRequested' | 'encoding' | 'maxSupportedTransactionVersion'
>

interface SolanaEvidenceRpcSuccess {
  ok: true
  result: unknown
  provider: SolanaProviderEvidence
  httpStatus: number | null
}

interface SolanaEvidenceRpcFailure {
  ok: false
  provider: SolanaProviderEvidence
  reason: Exclude<SolanaTxUnavailableReason, 'not_found' | 'metadata_unavailable'>
  rpcCode: number | null
  httpStatus: number | null
}

type SolanaEvidenceRpcResult = SolanaEvidenceRpcSuccess | SolanaEvidenceRpcFailure

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function evidenceProvider(
  servedBy: SolanaProviderId | null,
  attempted: SolanaProviderId[]
): SolanaProviderEvidence {
  return { servedBy, attempted: [...attempted] }
}

function evidenceRpcFailure(
  attempted: SolanaProviderId[],
  reason: SolanaEvidenceRpcFailure['reason'],
  rpcCode: number | null = null,
  httpStatus: number | null = null
): SolanaEvidenceRpcFailure {
  return {
    ok: false,
    provider: evidenceProvider(null, attempted),
    reason,
    rpcCode,
    httpStatus,
  }
}

function normalizedHttpStatus(response: Response): number | null {
  return Number.isSafeInteger(response.status) && response.status >= 0 ? response.status : null
}

function rateLimitedMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('429') ||
    normalized.includes('rate limit') ||
    normalized.includes('throughput') ||
    normalized.includes('compute unit')
  )
}

function timeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const normalized = error.message.toLowerCase()
  return (
    error.name === 'AbortError' || normalized.includes('aborted') || normalized.includes('timeout')
  )
}

/**
 * Evidence-only RPC transport. Unlike the production helper, failures become
 * fixed enums and numeric codes; URLs and raw provider text never leave here.
 * The sole automatic retry is sticky Helius quota failover to Alchemy.
 */
async function solEvidenceRpc(
  method: string,
  params: unknown[],
  opts: RpcOpts
): Promise<SolanaEvidenceRpcResult> {
  const attempted: SolanaProviderId[] = []

  while (true) {
    let endpoint: SolanaEndpoint
    try {
      endpoint = resolveSolEndpoint(opts)
    } catch {
      return evidenceRpcFailure(attempted, 'provider_unconfigured')
    }
    if (!attempted.includes(endpoint.providerId)) attempted.push(endpoint.providerId)

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000)
    try {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: ctrl.signal,
      })
      const httpStatus = normalizedHttpStatus(response)
      if (httpStatus === 429) {
        return evidenceRpcFailure(attempted, 'rate_limited', null, httpStatus)
      }
      if (httpStatus === 402) {
        if (
          typeof opts.rpcUrl !== 'string' &&
          endpoint.providerId === 'helius' &&
          Boolean(process.env.ALCHEMY_API_KEY)
        ) {
          heliusExhausted = true
          continue
        }
        return evidenceRpcFailure(attempted, 'quota_exhausted', null, httpStatus)
      }
      if (httpStatus !== null && (httpStatus < 200 || httpStatus >= 300)) {
        return evidenceRpcFailure(attempted, 'rpc_error', null, httpStatus)
      }

      const text = await response.text()

      let payload: unknown
      try {
        payload = text ? JSON.parse(text) : null
      } catch {
        return evidenceRpcFailure(attempted, 'malformed_response', null, httpStatus)
      }
      if (!isJsonObject(payload)) {
        return evidenceRpcFailure(attempted, 'malformed_response', null, httpStatus)
      }

      const hasError = Object.hasOwn(payload, 'error')
      const hasResult = Object.hasOwn(payload, 'result')
      if (payload.jsonrpc !== '2.0' || payload.id !== 1 || hasError === hasResult) {
        return evidenceRpcFailure(attempted, 'malformed_response', null, httpStatus)
      }

      if (hasError) {
        if (!isJsonObject(payload.error) || !Number.isSafeInteger(payload.error.code)) {
          return evidenceRpcFailure(attempted, 'malformed_response', null, httpStatus)
        }
        const rpcCode = Number(payload.error.code)
        const message = typeof payload.error.message === 'string' ? payload.error.message : ''
        if (rpcCode === -32015) {
          return evidenceRpcFailure(
            attempted,
            'unsupported_transaction_version',
            rpcCode,
            httpStatus
          )
        }
        if (isQuotaExhausted(message)) {
          if (
            typeof opts.rpcUrl !== 'string' &&
            endpoint.providerId === 'helius' &&
            Boolean(process.env.ALCHEMY_API_KEY)
          ) {
            heliusExhausted = true
            continue
          }
          return evidenceRpcFailure(attempted, 'quota_exhausted', rpcCode, httpStatus)
        }
        if (rateLimitedMessage(message)) {
          return evidenceRpcFailure(attempted, 'rate_limited', rpcCode, httpStatus)
        }
        return evidenceRpcFailure(attempted, 'rpc_error', rpcCode, httpStatus)
      }
      return {
        ok: true,
        result: payload.result,
        provider: evidenceProvider(endpoint.providerId, attempted),
        httpStatus,
      }
    } catch (error) {
      return evidenceRpcFailure(attempted, timeoutError(error) ? 'timeout' : 'transport_error')
    } finally {
      clearTimeout(timer)
    }
  }
}

class MalformedSolanaTxEvidenceError extends Error {}
class UnsupportedSolanaTxVersionError extends Error {}

function malformedTxEvidence(): never {
  throw new MalformedSolanaTxEvidenceError('malformed Solana transaction evidence')
}

interface SolanaErrorCloneBudget {
  nodes: number
  stringBytes: number
  seen: Set<object>
}

function plainDataRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
    return malformedTxEvidence()
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return malformedTxEvidence()
  return value as Record<string, unknown>
}

function ownDataValue(record: Record<string, unknown>, key: string, required = true): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (!descriptor) {
    if (required) return malformedTxEvidence()
    return undefined
  }
  if (!descriptor.enumerable || !('value' in descriptor) || descriptor.value === undefined) {
    return malformedTxEvidence()
  }
  return descriptor.value
}

function denseArrayValues(value: unknown, maximumLength: number): unknown[] {
  if (
    typeof value !== 'object' ||
    value === null ||
    isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximumLength
  ) {
    return malformedTxEvidence()
  }
  const values: unknown[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      return malformedTxEvidence()
    }
    values.push(descriptor.value)
  }
  return values
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function jsonScalar(value: unknown): SolanaRpcJson {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value
  return malformedTxEvidence()
}

function selectedString(value: unknown, maximumUtf8Bytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length > maximumUtf8Bytes ||
    utf8ByteLength(value) > maximumUtf8Bytes
  ) {
    return malformedTxEvidence()
  }
  return value
}

function selectedStringArray(
  value: unknown,
  maximumLength: number,
  maximumItemBytes: number,
  maximumTotalBytes: number
): string[] {
  let totalBytes = 0
  return denseArrayValues(value, maximumLength).map((item) => {
    if (typeof item !== 'string' || item.length > maximumItemBytes) {
      return malformedTxEvidence()
    }
    const itemBytes = utf8ByteLength(item)
    totalBytes += itemBytes
    if (itemBytes > maximumItemBytes || totalBytes > maximumTotalBytes) {
      return malformedTxEvidence()
    }
    return item
  })
}

function selectedNumberArray(value: unknown, maximumLength: number): number[] {
  return denseArrayValues(value, maximumLength).map((item) => {
    if (typeof item !== 'number' || !Number.isFinite(item) || Object.is(item, -0)) {
      return malformedTxEvidence()
    }
    return item
  })
}

function cloneBoundedSolanaErrorJson(
  value: unknown,
  budget: SolanaErrorCloneBudget = {
    nodes: 0,
    stringBytes: 0,
    seen: new Set<object>(),
  },
  depth = 0
): SolanaRpcJson {
  budget.nodes += 1
  if (budget.nodes > SOLANA_MAX_ERROR_JSON_NODES || depth > SOLANA_MAX_ERROR_JSON_DEPTH) {
    return malformedTxEvidence()
  }

  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) return malformedTxEvidence()
    return value
  }
  if (typeof value === 'string') {
    if (value.length > SOLANA_MAX_ERROR_STRING_UTF8_BYTES) {
      return malformedTxEvidence()
    }
    budget.stringBytes += utf8ByteLength(value)
    if (budget.stringBytes > SOLANA_MAX_ERROR_STRING_UTF8_BYTES) {
      return malformedTxEvidence()
    }
    return value
  }
  if (typeof value !== 'object' || isProxy(value)) return malformedTxEvidence()
  if (budget.seen.has(value)) return malformedTxEvidence()
  budget.seen.add(value)

  if (Array.isArray(value)) {
    return denseArrayValues(value, SOLANA_MAX_ERROR_ARRAY_LENGTH).map((item) =>
      cloneBoundedSolanaErrorJson(item, budget, depth + 1)
    )
  }

  const record = plainDataRecord(value)
  const cloned: { [key: string]: SolanaRpcJson } = {}
  let keyCount = 0
  for (const key in record) {
    if (!Object.hasOwn(record, key)) continue
    keyCount += 1
    if (keyCount > SOLANA_MAX_ERROR_OBJECT_KEYS) return malformedTxEvidence()
    if (key.length > SOLANA_MAX_ERROR_STRING_UTF8_BYTES) return malformedTxEvidence()
    budget.stringBytes += utf8ByteLength(key)
    if (budget.stringBytes > SOLANA_MAX_ERROR_STRING_UTF8_BYTES) {
      return malformedTxEvidence()
    }
    const child = ownDataValue(record, key)
    Object.defineProperty(cloned, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: cloneBoundedSolanaErrorJson(child, budget, depth + 1),
    })
  }
  return cloned
}

function selectedInstruction(
  value: unknown,
  maximumAccountIndexes: number
): { [key: string]: SolanaRpcJson } {
  const instruction = plainDataRecord(value)
  const selected: { [key: string]: SolanaRpcJson } = {
    programIdIndex: jsonScalar(ownDataValue(instruction, 'programIdIndex')),
    accounts: selectedNumberArray(ownDataValue(instruction, 'accounts'), maximumAccountIndexes),
    data: selectedString(
      ownDataValue(instruction, 'data'),
      SOLANA_MAX_CPI_INSTRUCTION_DATA_BYTES * 2
    ),
  }
  const stackHeight = ownDataValue(instruction, 'stackHeight', false)
  if (stackHeight !== undefined) selected.stackHeight = jsonScalar(stackHeight)
  return selected
}

function selectedTokenBalance(value: unknown): { [key: string]: SolanaRpcJson } {
  const balance = plainDataRecord(value)
  const uiTokenAmount = plainDataRecord(ownDataValue(balance, 'uiTokenAmount'))
  const selected: { [key: string]: SolanaRpcJson } = {
    accountIndex: jsonScalar(ownDataValue(balance, 'accountIndex')),
    mint: selectedString(ownDataValue(balance, 'mint'), 64),
    uiTokenAmount: {
      amount: selectedString(ownDataValue(uiTokenAmount, 'amount'), 20),
      decimals: jsonScalar(ownDataValue(uiTokenAmount, 'decimals')),
    },
  }
  for (const key of ['owner', 'programId'] as const) {
    const child = ownDataValue(balance, key, false)
    if (child !== undefined) {
      selected[key] = child === null ? null : selectedString(child, 64)
    }
  }
  return selected
}

function selectedSolanaTransactionResult(value: unknown): SolanaRpcJson {
  const result = plainDataRecord(value)
  const transaction = plainDataRecord(ownDataValue(result, 'transaction'))
  const message = plainDataRecord(ownDataValue(transaction, 'message'))
  const header = plainDataRecord(ownDataValue(message, 'header'))
  const meta = plainDataRecord(ownDataValue(result, 'meta'))

  const selectedMessage: { [key: string]: SolanaRpcJson } = {
    header: {
      numRequiredSignatures: jsonScalar(ownDataValue(header, 'numRequiredSignatures')),
      numReadonlySignedAccounts: jsonScalar(ownDataValue(header, 'numReadonlySignedAccounts')),
      numReadonlyUnsignedAccounts: jsonScalar(ownDataValue(header, 'numReadonlyUnsignedAccounts')),
    },
    accountKeys: selectedStringArray(
      ownDataValue(message, 'accountKeys'),
      SOLANA_MAX_RESOLVED_ACCOUNT_KEYS,
      64,
      SOLANA_MAX_RESOLVED_ACCOUNT_KEYS * 64
    ),
    instructions: denseArrayValues(
      ownDataValue(message, 'instructions'),
      SOLANA_MAX_DECLARED_OUTER_INSTRUCTIONS
    ).map((instruction) => selectedInstruction(instruction, SOLANA_PACKET_DATA_SIZE_BYTES)),
  }

  const addressTableLookups = ownDataValue(message, 'addressTableLookups', false)
  if (addressTableLookups !== undefined && addressTableLookups !== null) {
    selectedMessage.addressTableLookups = denseArrayValues(
      addressTableLookups,
      SOLANA_MAX_ADDRESS_TABLE_LOOKUPS
    ).map((lookupValue) => {
      const lookup = plainDataRecord(lookupValue)
      return {
        accountKey: selectedString(ownDataValue(lookup, 'accountKey'), 64),
        writableIndexes: selectedNumberArray(
          ownDataValue(lookup, 'writableIndexes'),
          SOLANA_MAX_RESOLVED_ACCOUNT_KEYS
        ),
        readonlyIndexes: selectedNumberArray(
          ownDataValue(lookup, 'readonlyIndexes'),
          SOLANA_MAX_RESOLVED_ACCOUNT_KEYS
        ),
      }
    })
  } else if (addressTableLookups === null) {
    selectedMessage.addressTableLookups = null
  }

  const selectedMeta: { [key: string]: SolanaRpcJson } = {
    err: cloneBoundedSolanaErrorJson(ownDataValue(meta, 'err')),
    fee: jsonScalar(ownDataValue(meta, 'fee')),
    preBalances: selectedNumberArray(
      ownDataValue(meta, 'preBalances'),
      SOLANA_MAX_RESOLVED_ACCOUNT_KEYS
    ),
    postBalances: selectedNumberArray(
      ownDataValue(meta, 'postBalances'),
      SOLANA_MAX_RESOLVED_ACCOUNT_KEYS
    ),
  }
  const computeUnitsConsumed = ownDataValue(meta, 'computeUnitsConsumed', false)
  if (computeUnitsConsumed !== undefined) {
    selectedMeta.computeUnitsConsumed = jsonScalar(computeUnitsConsumed)
  }

  const loadedAddresses = ownDataValue(meta, 'loadedAddresses', false)
  if (loadedAddresses !== undefined && loadedAddresses !== null) {
    const loaded = plainDataRecord(loadedAddresses)
    selectedMeta.loadedAddresses = {
      writable: selectedStringArray(
        ownDataValue(loaded, 'writable'),
        SOLANA_MAX_RESOLVED_ACCOUNT_KEYS,
        64,
        SOLANA_MAX_RESOLVED_ACCOUNT_KEYS * 64
      ),
      readonly: selectedStringArray(
        ownDataValue(loaded, 'readonly'),
        SOLANA_MAX_RESOLVED_ACCOUNT_KEYS,
        64,
        SOLANA_MAX_RESOLVED_ACCOUNT_KEYS * 64
      ),
    }
  } else if (loadedAddresses === null) {
    selectedMeta.loadedAddresses = null
  }

  for (const key of ['preTokenBalances', 'postTokenBalances'] as const) {
    const balances = ownDataValue(meta, key, false)
    if (balances === null) {
      selectedMeta[key] = null
    } else if (balances !== undefined) {
      selectedMeta[key] = denseArrayValues(balances, SOLANA_MAX_TOKEN_BALANCES).map(
        selectedTokenBalance
      )
    }
  }

  const innerInstructions = ownDataValue(meta, 'innerInstructions', false)
  if (innerInstructions === null) {
    selectedMeta.innerInstructions = null
  } else if (innerInstructions !== undefined) {
    selectedMeta.innerInstructions = denseArrayValues(
      innerInstructions,
      SOLANA_MAX_INSTRUCTION_TRACE_LENGTH
    ).map((groupValue) => {
      const group = plainDataRecord(groupValue)
      return {
        index: jsonScalar(ownDataValue(group, 'index')),
        instructions: denseArrayValues(
          ownDataValue(group, 'instructions'),
          SOLANA_MAX_INSTRUCTION_TRACE_LENGTH
        ).map((instruction) =>
          selectedInstruction(instruction, SOLANA_MAX_CPI_INSTRUCTION_ACCOUNTS)
        ),
      }
    })
  }

  const logMessages = ownDataValue(meta, 'logMessages', false)
  if (logMessages === null) {
    selectedMeta.logMessages = null
  } else if (logMessages !== undefined) {
    selectedMeta.logMessages = selectedStringArray(
      logMessages,
      SOLANA_MAX_LOG_MESSAGES,
      SOLANA_MAX_LOG_MESSAGE_UTF8_BYTES,
      SOLANA_MAX_LOG_TOTAL_UTF8_BYTES
    )
  }

  const selected: { [key: string]: SolanaRpcJson } = {
    slot: jsonScalar(ownDataValue(result, 'slot')),
    version: jsonScalar(ownDataValue(result, 'version')),
    transaction: {
      signatures: selectedStringArray(
        ownDataValue(transaction, 'signatures'),
        SOLANA_MAX_TRANSACTION_SIGNATURES,
        128,
        SOLANA_MAX_TRANSACTION_SIGNATURES * 128
      ),
      message: selectedMessage,
    },
    meta: selectedMeta,
  }
  const blockTime = ownDataValue(result, 'blockTime', false)
  if (blockTime !== undefined) selected.blockTime = jsonScalar(blockTime)
  return selected
}

function clearDecodedInstructionData(bytes: Uint8Array): void {
  try {
    Reflect.apply(TYPED_ARRAY_FILL, bytes, [0])
    if (!TYPED_ARRAY_LENGTH_GETTER) return malformedTxEvidence()
    const length: unknown = Reflect.apply(TYPED_ARRAY_LENGTH_GETTER, bytes, [])
    if (!Number.isSafeInteger(length) || Number(length) < 0) return malformedTxEvidence()
    for (let index = 0; index < Number(length); index += 1) {
      if (bytes[index] !== 0) return malformedTxEvidence()
    }
  } catch {
    return malformedTxEvidence()
  }
}

function nonNegativeSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    Object.is(value, -0)
  ) {
    return malformedTxEvidence()
  }
  return value
}

function byteInteger(value: unknown): number {
  const parsed = nonNegativeSafeInteger(value)
  if (parsed > 255) return malformedTxEvidence()
  return parsed
}

function solanaPublicKey(value: unknown): string {
  if (!hasBase58DecodedByteLength(value, 32)) {
    return malformedTxEvidence()
  }
  return value
}

function rawStringArray(
  value: unknown,
  maximumLength: number,
  maximumItemCodeUnits: number,
  maximumTotalCodeUnits: number
): string[] {
  if (!Array.isArray(value) || value.length > maximumLength) {
    return malformedTxEvidence()
  }
  let totalCodeUnits = 0
  const values = value.map((item) => {
    if (typeof item !== 'string' || item.length > maximumItemCodeUnits) {
      return malformedTxEvidence()
    }
    totalCodeUnits += item.length
    if (totalCodeUnits > maximumTotalCodeUnits) return malformedTxEvidence()
    return item
  })
  return values
}

function publicKeyArray(
  value: unknown,
  maximumLength = SOLANA_MAX_RESOLVED_ACCOUNT_KEYS
): string[] {
  if (!Array.isArray(value) || value.length > maximumLength) return malformedTxEvidence()
  return value.map(solanaPublicKey)
}

function byteArray(value: unknown, maximumLength = SOLANA_MAX_RESOLVED_ACCOUNT_KEYS): number[] {
  if (!Array.isArray(value) || value.length > maximumLength) return malformedTxEvidence()
  return value.map(byteInteger)
}

function transactionVersion(value: unknown): 'legacy' | 0 {
  if (value === 'legacy' || (value === 0 && !Object.is(value, -0))) return value
  if (Object.is(value, -0)) return malformedTxEvidence()
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    throw new UnsupportedSolanaTxVersionError('unsupported Solana transaction version')
  }
  return malformedTxEvidence()
}

function isSolanaRpcJson(
  value: unknown,
  budget = { nodes: 0, stringBytes: 0 },
  depth = 0
): value is SolanaRpcJson {
  budget.nodes += 1
  if (budget.nodes > SOLANA_MAX_ERROR_JSON_NODES || depth > SOLANA_MAX_ERROR_JSON_DEPTH) {
    return false
  }
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'string') {
    budget.stringBytes += utf8ByteLength(value)
    return budget.stringBytes <= SOLANA_MAX_ERROR_STRING_UTF8_BYTES
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && !Object.is(value, -0)
  }
  if (Array.isArray(value)) {
    return (
      value.length <= SOLANA_MAX_ERROR_ARRAY_LENGTH &&
      value.every((item) => isSolanaRpcJson(item, budget, depth + 1))
    )
  }
  if (
    !isJsonObject(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length > SOLANA_MAX_ERROR_OBJECT_KEYS
  ) {
    return false
  }
  return Object.values(value).every((item) => isSolanaRpcJson(item, budget, depth + 1))
}

function transactionError(value: unknown): SolanaTransactionError | null {
  if (value === null) return null
  if (typeof value === 'string') {
    if (utf8ByteLength(value) > SOLANA_MAX_ERROR_STRING_UTF8_BYTES) {
      return malformedTxEvidence()
    }
    return value
  }
  if (!isJsonObject(value) || Object.keys(value).length !== 1 || !isSolanaRpcJson(value)) {
    return malformedTxEvidence()
  }
  return value as { [key: string]: SolanaRpcJson }
}

function parseAddressTableLookups(
  value: unknown,
  maximumLoadedAccountCount: number
): SolanaAddressTableLookupEvidence[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > SOLANA_MAX_ADDRESS_TABLE_LOOKUPS) {
    return malformedTxEvidence()
  }
  let loadedAccountCount = 0
  return value.map((raw) => {
    if (!isJsonObject(raw)) return malformedTxEvidence()
    const writableIndexes = byteArray(raw.writableIndexes)
    const readonlyIndexes = byteArray(raw.readonlyIndexes)
    if (writableIndexes.length + readonlyIndexes.length === 0) {
      return malformedTxEvidence()
    }
    loadedAccountCount += writableIndexes.length + readonlyIndexes.length
    if (loadedAccountCount > maximumLoadedAccountCount) {
      return malformedTxEvidence()
    }
    return {
      tableAccount: solanaPublicKey(raw.accountKey),
      writableIndexes,
      readonlyIndexes,
    }
  })
}

function parseResolvedAccountKeys(
  version: 'legacy' | 0,
  staticAccountKeys: string[],
  headerValue: unknown,
  lookups: SolanaAddressTableLookupEvidence[],
  loadedValue: unknown
): {
  loadedAddresses: { writable: string[]; readonly: string[] }
  accountKeys: SolanaResolvedAccountKey[]
} {
  if (!isJsonObject(headerValue)) return malformedTxEvidence()
  const requiredSignatures = byteInteger(headerValue.numRequiredSignatures)
  const readonlySigned = byteInteger(headerValue.numReadonlySignedAccounts)
  const readonlyUnsigned = byteInteger(headerValue.numReadonlyUnsignedAccounts)
  if (
    requiredSignatures === 0 ||
    requiredSignatures > staticAccountKeys.length ||
    readonlySigned >= requiredSignatures ||
    readonlyUnsigned > staticAccountKeys.length - requiredSignatures
  ) {
    return malformedTxEvidence()
  }
  if (version === 'legacy' && lookups.length > 0) return malformedTxEvidence()

  let loadedAddresses: { writable: string[]; readonly: string[] }
  if (loadedValue === undefined || loadedValue === null) {
    if (version === 0) return malformedTxEvidence()
    loadedAddresses = { writable: [], readonly: [] }
  } else {
    if (!isJsonObject(loadedValue)) return malformedTxEvidence()
    loadedAddresses = {
      writable: publicKeyArray(loadedValue.writable),
      readonly: publicKeyArray(loadedValue.readonly),
    }
  }

  const writableOrigins = lookups.flatMap((lookup) =>
    lookup.writableIndexes.map((tableIndex) => ({
      tableAccount: lookup.tableAccount,
      tableIndex,
    }))
  )
  const readonlyOrigins = lookups.flatMap((lookup) =>
    lookup.readonlyIndexes.map((tableIndex) => ({
      tableAccount: lookup.tableAccount,
      tableIndex,
    }))
  )
  if (
    loadedAddresses.writable.length !== writableOrigins.length ||
    loadedAddresses.readonly.length !== readonlyOrigins.length
  ) {
    return malformedTxEvidence()
  }
  if (
    version === 'legacy' &&
    (loadedAddresses.writable.length > 0 || loadedAddresses.readonly.length > 0)
  ) {
    return malformedTxEvidence()
  }

  const writableSigned = requiredSignatures - readonlySigned
  const writableUnsignedEnd = staticAccountKeys.length - readonlyUnsigned
  const accountKeys: SolanaResolvedAccountKey[] = staticAccountKeys.map((pubkey, index) => ({
    index,
    pubkey,
    source: 'transaction',
    signer: index < requiredSignatures,
    writable: index < requiredSignatures ? index < writableSigned : index < writableUnsignedEnd,
    lookup: null,
  }))
  for (const [loadedIndex, pubkey] of loadedAddresses.writable.entries()) {
    accountKeys.push({
      index: accountKeys.length,
      pubkey,
      source: 'lookupTable',
      signer: false,
      writable: true,
      lookup: writableOrigins[loadedIndex],
    })
  }
  for (const [loadedIndex, pubkey] of loadedAddresses.readonly.entries()) {
    accountKeys.push({
      index: accountKeys.length,
      pubkey,
      source: 'lookupTable',
      signer: false,
      writable: false,
      lookup: readonlyOrigins[loadedIndex],
    })
  }
  if (accountKeys.length > SOLANA_MAX_RESOLVED_ACCOUNT_KEYS) return malformedTxEvidence()
  return { loadedAddresses, accountKeys }
}

function parseCompiledInstruction(
  value: unknown,
  path: SolanaInstructionPath,
  accountKeys: SolanaResolvedAccountKey[],
  staticAccountKeyCount: number
): SolanaInstructionEvidence {
  if (!isJsonObject(value)) return malformedTxEvidence()
  const programIdIndex = byteInteger(value.programIdIndex)
  if (
    programIdIndex >= accountKeys.length ||
    (path.kind === 'outer' && (programIdIndex === 0 || programIdIndex >= staticAccountKeyCount))
  ) {
    return malformedTxEvidence()
  }
  const accountIndexes = byteArray(
    value.accounts,
    path.kind === 'outer' ? SOLANA_PACKET_DATA_SIZE_BYTES : SOLANA_MAX_CPI_INSTRUCTION_ACCOUNTS
  )
  if (accountIndexes.some((index) => index >= accountKeys.length)) return malformedTxEvidence()
  if (typeof value.data !== 'string') return malformedTxEvidence()
  const decodedData = decodeBase58BytesBounded(
    value.data,
    path.kind === 'outer' ? SOLANA_PACKET_DATA_SIZE_BYTES : SOLANA_MAX_CPI_INSTRUCTION_DATA_BYTES
  )
  if (decodedData === null) {
    return malformedTxEvidence()
  }
  clearDecodedInstructionData(decodedData)
  const stackHeight =
    value.stackHeight === undefined || value.stackHeight === null
      ? null
      : byteInteger(value.stackHeight)
  return {
    path,
    programIdIndex,
    programId: accountKeys[programIdIndex].pubkey,
    accountIndexes,
    accounts: accountIndexes.map((index) => accountKeys[index].pubkey),
    dataBase58: value.data,
    stackHeight,
  }
}

function parseInstructions(
  outerValue: unknown,
  innerValue: unknown,
  accountKeys: SolanaResolvedAccountKey[],
  staticAccountKeyCount: number,
  executionSucceeded: boolean
): {
  innerInstructionsStatus: SolanaTxEvidenceAvailable['innerInstructionsStatus']
  instructions: SolanaInstructionEvidence[]
} {
  if (!Array.isArray(outerValue) || outerValue.length > SOLANA_MAX_DECLARED_OUTER_INSTRUCTIONS) {
    return malformedTxEvidence()
  }
  const innerByOuter = new Map<number, unknown[]>()
  const innerInstructionsStatus =
    innerValue === undefined || innerValue === null
      ? 'unavailable'
      : Array.isArray(innerValue) && innerValue.length === 0
        ? 'verified_empty'
        : 'present'
  if (innerValue !== undefined && innerValue !== null) {
    if (!Array.isArray(innerValue) || innerValue.length > SOLANA_MAX_INSTRUCTION_TRACE_LENGTH) {
      return malformedTxEvidence()
    }
    let reportedInnerInstructionCount = 0
    let highestReportedOuterIndex = -1
    for (const group of innerValue) {
      if (!isJsonObject(group)) return malformedTxEvidence()
      const outerIndex = byteInteger(group.index)
      if (outerIndex >= outerValue.length || innerByOuter.has(outerIndex)) {
        return malformedTxEvidence()
      }
      if (
        !Array.isArray(group.instructions) ||
        group.instructions.length > SOLANA_MAX_INSTRUCTION_TRACE_LENGTH
      ) {
        return malformedTxEvidence()
      }
      reportedInnerInstructionCount += group.instructions.length
      highestReportedOuterIndex = Math.max(highestReportedOuterIndex, outerIndex)
      if (
        reportedInnerInstructionCount + highestReportedOuterIndex + 1 >
        SOLANA_MAX_INSTRUCTION_TRACE_LENGTH
      ) {
        return malformedTxEvidence()
      }
      innerByOuter.set(outerIndex, group.instructions)
    }
    if (
      executionSucceeded &&
      outerValue.length + reportedInnerInstructionCount > SOLANA_MAX_INSTRUCTION_TRACE_LENGTH
    ) {
      return malformedTxEvidence()
    }
  } else if (executionSucceeded && outerValue.length > SOLANA_MAX_INSTRUCTION_TRACE_LENGTH) {
    return malformedTxEvidence()
  }

  const instructions: SolanaInstructionEvidence[] = []
  for (const [outerIndex, rawOuter] of outerValue.entries()) {
    instructions.push(
      parseCompiledInstruction(
        rawOuter,
        { kind: 'outer', outerIndex },
        accountKeys,
        staticAccountKeyCount
      )
    )
    const inner = innerByOuter.get(outerIndex) ?? []
    for (const [innerIndex, rawInner] of inner.entries()) {
      instructions.push(
        parseCompiledInstruction(
          rawInner,
          { kind: 'inner', outerIndex, innerIndex },
          accountKeys,
          staticAccountKeyCount
        )
      )
    }
  }
  return { innerInstructionsStatus, instructions }
}

function parseLamportBalances(value: unknown, accountCount: number): number[] {
  if (!Array.isArray(value) || value.length !== accountCount) return malformedTxEvidence()
  return value.map(nonNegativeSafeInteger)
}

function optionalPublicKey(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return solanaPublicKey(value)
}

function parseTokenBalances(
  value: unknown,
  accountKeys: SolanaResolvedAccountKey[]
): SolanaTokenBalanceEvidence[] | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || value.length > accountKeys.length) {
    return malformedTxEvidence()
  }
  const balances = value.map((raw) => {
    if (!isJsonObject(raw) || !isJsonObject(raw.uiTokenAmount)) {
      return malformedTxEvidence()
    }
    const accountIndex = byteInteger(raw.accountIndex)
    if (accountIndex >= accountKeys.length) return malformedTxEvidence()
    const rawAmount = raw.uiTokenAmount.amount
    if (
      typeof rawAmount !== 'string' ||
      !/^(0|[1-9]\d*)$/.test(rawAmount) ||
      rawAmount.length > 20 ||
      BigInt(rawAmount) > 18_446_744_073_709_551_615n
    ) {
      return malformedTxEvidence()
    }
    return {
      accountIndex,
      account: accountKeys[accountIndex].pubkey,
      mint: solanaPublicKey(raw.mint),
      owner: optionalPublicKey(raw.owner),
      tokenProgram: optionalPublicKey(raw.programId),
      rawAmount,
      decimals: byteInteger(raw.uiTokenAmount.decimals),
    }
  })
  if (new Set(balances.map((balance) => balance.accountIndex)).size !== balances.length) {
    return malformedTxEvidence()
  }
  return balances
}

function parseLogMessages(value: unknown): string[] | null {
  if (value === undefined || value === null) return null
  return rawStringArray(
    value,
    SOLANA_MAX_LOG_MESSAGES,
    SOLANA_MAX_LOG_MESSAGE_UTF8_BYTES,
    SOLANA_MAX_LOG_TOTAL_UTF8_BYTES
  )
}

function normalizeSolanaTxEvidence(
  signature: string,
  value: unknown,
  provider: SolanaProviderEvidence
): SolanaTxEvidenceAvailable {
  const boundedValue = selectedSolanaTransactionResult(value)
  if (!isJsonObject(boundedValue)) return malformedTxEvidence()
  const version = transactionVersion(boundedValue.version)
  const slot = nonNegativeSafeInteger(boundedValue.slot)
  const blockTime =
    boundedValue.blockTime === undefined || boundedValue.blockTime === null
      ? null
      : nonNegativeSafeInteger(boundedValue.blockTime)
  if (!isJsonObject(boundedValue.transaction) || !isJsonObject(boundedValue.transaction.message)) {
    return malformedTxEvidence()
  }
  const transactionSignatures = rawStringArray(
    boundedValue.transaction.signatures,
    SOLANA_MAX_TRANSACTION_SIGNATURES,
    128,
    SOLANA_MAX_TRANSACTION_SIGNATURES * 128
  )
  if (
    transactionSignatures.length === 0 ||
    transactionSignatures.some((candidate) => !isSolanaSignature(candidate)) ||
    transactionSignatures[0] !== signature
  ) {
    return malformedTxEvidence()
  }
  const message = boundedValue.transaction.message
  const staticAccountKeys = publicKeyArray(message.accountKeys, SOLANA_MAX_RESOLVED_ACCOUNT_KEYS)
  const addressTableLookups = parseAddressTableLookups(
    message.addressTableLookups,
    SOLANA_MAX_RESOLVED_ACCOUNT_KEYS - staticAccountKeys.length
  )
  if (!isJsonObject(boundedValue.meta) || !Object.hasOwn(boundedValue.meta, 'err')) {
    return malformedTxEvidence()
  }
  const meta = boundedValue.meta
  const { loadedAddresses, accountKeys } = parseResolvedAccountKeys(
    version,
    staticAccountKeys,
    message.header,
    addressTableLookups,
    meta.loadedAddresses
  )
  if (accountKeys.filter((account) => account.signer).length !== transactionSignatures.length) {
    return malformedTxEvidence()
  }
  const executionError = transactionError(meta.err)
  const feeLamports = nonNegativeSafeInteger(meta.fee)
  const computeUnitsConsumed =
    meta.computeUnitsConsumed === undefined || meta.computeUnitsConsumed === null
      ? null
      : nonNegativeSafeInteger(meta.computeUnitsConsumed)
  const { innerInstructionsStatus, instructions } = parseInstructions(
    message.instructions,
    meta.innerInstructions,
    accountKeys,
    staticAccountKeys.length,
    executionError === null
  )

  return {
    status: 'available',
    signature,
    provider,
    commitmentRequested: 'finalized',
    encoding: 'json',
    maxSupportedTransactionVersion: 0,
    slot,
    blockTime,
    version,
    executionStatus: executionError === null ? 'succeeded' : 'failed',
    executionError,
    feeLamports,
    computeUnitsConsumed,
    staticAccountKeys,
    addressTableLookups,
    loadedAddresses,
    accountKeys,
    preBalancesLamports: parseLamportBalances(meta.preBalances, accountKeys.length),
    postBalancesLamports: parseLamportBalances(meta.postBalances, accountKeys.length),
    preTokenBalances: parseTokenBalances(meta.preTokenBalances, accountKeys),
    postTokenBalances: parseTokenBalances(meta.postTokenBalances, accountKeys),
    innerInstructionsStatus,
    instructions,
    logMessages: parseLogMessages(meta.logMessages),
  }
}

/**
 * Strictly normalize one already-decoded getTransaction result without
 * performing network I/O or attaching provider/request provenance. Callers
 * must bind the capture separately; this function only composes the complete
 * transaction parser and never exposes its partial parsing helpers.
 */
export function normalizeSolanaTxEvidenceResult(
  signature: string,
  result: unknown
): SolanaNormalizedTxResult {
  if (!isSolanaSignature(signature)) {
    throw new TypeError('signature must be a base58-encoded 64-byte signature')
  }
  try {
    const {
      provider: _provider,
      commitmentRequested: _commitmentRequested,
      encoding: _encoding,
      maxSupportedTransactionVersion: _maxSupportedTransactionVersion,
      ...normalized
    } = normalizeSolanaTxEvidence(signature, result, evidenceProvider(null, []))
    return normalized
  } catch (error) {
    throw new TypeError(
      error instanceof UnsupportedSolanaTxVersionError
        ? 'unsupported Solana transaction version'
        : 'malformed Solana transaction evidence'
    )
  }
}

function unavailableTxEvidence(
  signature: string,
  provider: SolanaProviderEvidence,
  reason: SolanaTxUnavailableReason,
  rpcCode: number | null = null,
  httpStatus: number | null = null
): SolanaTxEvidenceUnavailable {
  return { status: 'unavailable', signature, provider, reason, rpcCode, httpStatus }
}

/**
 * Fetch one finalized transaction as immutable decoder evidence. This is a
 * shadow-only path and intentionally does not feed the existing PnL decoder.
 */
export async function fetchTxEvidence(
  signature: string,
  opts: RpcOpts = {}
): Promise<SolanaTxEvidence> {
  if (!isSolanaSignature(signature)) {
    throw new TypeError('signature must be a base58-encoded 64-byte signature')
  }
  const call = await solEvidenceRpc(
    'getTransaction',
    [
      signature,
      {
        commitment: 'finalized',
        encoding: 'json',
        maxSupportedTransactionVersion: 0,
      },
    ],
    opts
  )
  if (!call.ok) {
    return unavailableTxEvidence(
      signature,
      call.provider,
      call.reason,
      call.rpcCode,
      call.httpStatus
    )
  }
  if (call.result === null) {
    return unavailableTxEvidence(signature, call.provider, 'not_found', null, call.httpStatus)
  }
  if (!isJsonObject(call.result)) {
    return unavailableTxEvidence(
      signature,
      call.provider,
      'malformed_response',
      null,
      call.httpStatus
    )
  }
  if (
    typeof call.result.version === 'number' &&
    Number.isSafeInteger(call.result.version) &&
    call.result.version !== 0
  ) {
    return unavailableTxEvidence(
      signature,
      call.provider,
      'unsupported_transaction_version',
      null,
      call.httpStatus
    )
  }
  if (call.result.meta === null) {
    return unavailableTxEvidence(
      signature,
      call.provider,
      'metadata_unavailable',
      null,
      call.httpStatus
    )
  }
  try {
    return normalizeSolanaTxEvidence(signature, call.result, call.provider)
  } catch (error) {
    return unavailableTxEvidence(
      signature,
      call.provider,
      error instanceof UnsupportedSolanaTxVersionError
        ? 'unsupported_transaction_version'
        : 'malformed_response',
      null,
      call.httpStatus
    )
  }
}

interface RawTx {
  blockTime: number | null
  transaction: { message: { accountKeys: Array<string | { pubkey: string }> } }
  meta: {
    fee: number
    preBalances: number[]
    postBalances: number[]
    preTokenBalances?: SolTokenBalance[]
    postTokenBalances?: SolTokenBalance[]
  } | null
}

function accountKeyStr(k: string | { pubkey: string }): string {
  return typeof k === 'string' ? k : k.pubkey
}

/** getTransaction → the balance-delta SolTxMeta the decoder needs (or null). */
export async function fetchTxMeta(
  signature: string,
  wallet: string,
  opts: RpcOpts = {}
): Promise<SolTxMeta | null> {
  const tx = await solRpc<RawTx | null>(
    'getTransaction',
    [signature, { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }],
    opts
  )
  if (!tx || !tx.meta) return null
  const keys = tx.transaction.message.accountKeys.map(accountKeyStr)
  const walletIndex = keys.indexOf(wallet)
  if (walletIndex < 0) return null
  return {
    signature,
    blockTime: tx.blockTime,
    fee: tx.meta.fee,
    walletIndex,
    preSol: tx.meta.preBalances[walletIndex] ?? 0,
    postSol: tx.meta.postBalances[walletIndex] ?? 0,
    preTokenBalances: tx.meta.preTokenBalances ?? [],
    postTokenBalances: tx.meta.postTokenBalances ?? [],
  }
}

/** Public SOL/USD spot (keyless). */
export async function fetchSolUsd(opts: { timeoutMs?: number } = {}): Promise<number> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000)
  try {
    const res = await fetch('https://coins.llama.fi/prices/current/coingecko:solana', {
      signal: ctrl.signal,
    })
    const json = (await res.json()) as { coins?: Record<string, { price?: number }> }
    const p = json.coins?.['coingecko:solana']?.price
    if (typeof p === 'number' && p > 0) return p
  } catch {
    /* fall through */
  } finally {
    clearTimeout(timer)
  }
  return 150
}

export interface SolWalletResult {
  wallet: string
  lookbackDays: number
  signatures: number
  txsFetched: number
  swaps: number
  solUsd: number
  signatureCoverage: SolanaSignatureCoverage
  /** Requested signatures without a usable transaction/meta/wallet record. */
  txsUnresolved: number
  txsMissingTimestamp: number
  pnl: WalletPnl
}

/** End-to-end: signatures → tx metas → decode → PnL for one Solana wallet. */
export async function computeSolanaWalletOnchain(
  wallet: string,
  opts: RpcOpts & {
    lookbackDays?: number
    maxSigs?: number
    maxPages?: number
    concurrency?: number
    solUsd?: number
  } = {}
): Promise<SolWalletResult> {
  const lookbackDays = opts.lookbackDays ?? 90
  const sinceMs = Date.now() - lookbackDays * 86_400_000
  const [signatureScan, solUsd] = await Promise.all([
    scanSignatures(wallet, { ...opts, sinceMs }),
    opts.solUsd !== undefined ? Promise.resolve(opts.solUsd) : fetchSolUsd(opts),
  ])
  const sigs = signatureScan.signatures

  // Fetch tx metas with bounded concurrency (public/free RPC friendliness).
  const conc = opts.concurrency ?? 3 // free-tier CU/s friendly
  const metas: SolTxMeta[] = []
  for (let i = 0; i < sigs.length; i += conc) {
    const slice = sigs.slice(i, i + conc)
    const got = await Promise.all(slice.map((s) => fetchTxMeta(s, wallet, opts).catch(() => null)))
    for (const m of got) if (m) metas.push(m)
  }

  const swaps = decodeSolanaSwaps(metas, wallet, solUsd)
  return {
    wallet,
    lookbackDays,
    signatures: sigs.length,
    txsFetched: metas.length,
    swaps: swaps.length,
    solUsd,
    signatureCoverage: signatureScan.coverage,
    txsUnresolved: sigs.length - metas.length,
    txsMissingTimestamp: metas.filter((meta) => meta.blockTime === null).length,
    pnl: computeWalletPnl(swaps),
  }
}
