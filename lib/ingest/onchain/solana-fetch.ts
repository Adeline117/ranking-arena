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

/**
 * Prefer Helius when configured (owner-provided 2026-07-09, Phase B full-scale
 * quota), fall back to Alchemy. Both speak identical Solana JSON-RPC — only
 * the URL differs, so provider choice stays a pure env concern.
 */
function solDefaultUrl(): string {
  const helius = process.env.HELIUS_API_KEY
  if (helius && !heliusExhausted) return `https://mainnet.helius-rpc.com/?api-key=${helius}`
  return alchemySolUrl()
}

interface RpcOpts {
  rpcUrl?: string
  timeoutMs?: number
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

async function solRpc<T>(method: string, params: unknown[], opts: RpcOpts = {}): Promise<T> {
  const attempts = 5
  for (let i = 0; i < attempts; i++) {
    // Re-resolve per attempt — a quota failover mid-loop must take effect.
    const url = opts.rpcUrl ?? solDefaultUrl()
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: ctrl.signal,
      })
      const text = await res.text()
      const json = (text ? JSON.parse(text) : {}) as { result?: T; error?: { message?: string } }
      if (json.error) throw new Error(`sol ${method}: ${json.error.message ?? 'error'}`)
      return json.result as T
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
    pnl: computeWalletPnl(swaps),
  }
}
