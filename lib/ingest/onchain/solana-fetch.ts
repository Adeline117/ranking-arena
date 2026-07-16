/**
 * Solana on-chain fetcher (Phase A network half; decoder is solana-swaps.ts).
 *
 * getSignaturesForAddress (paginated, time-bounded) → getTransaction per sig
 * (jsonParsed) → extract the balance-delta {@link SolTxMeta} → decode → PnL.
 * Uses the shared ALCHEMY_API_KEY (Solana network enabled 2026-07-01); $0 on
 * the free tier for the top-N deep-profile scope.
 */

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

const SOLANA_BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/
const SOLANA_BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58DecodedByteLength(value: string): number {
  let numericValue = 0n
  for (const character of value) {
    const digit = SOLANA_BASE58_ALPHABET.indexOf(character)
    if (digit < 0) return -1
    numericValue = numericValue * 58n + BigInt(digit)
  }
  let significantBytes = 0
  for (let remaining = numericValue; remaining > 0n; remaining >>= 8n) significantBytes += 1
  let leadingZeroBytes = 0
  while (leadingZeroBytes < value.length && value[leadingZeroBytes] === '1') {
    leadingZeroBytes += 1
  }
  return leadingZeroBytes + significantBytes
}

function isSolanaSignature(value: string): boolean {
  return (
    value.length >= 64 &&
    value.length <= 100 &&
    SOLANA_BASE58_RE.test(value) &&
    base58DecodedByteLength(value) === 64
  )
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
