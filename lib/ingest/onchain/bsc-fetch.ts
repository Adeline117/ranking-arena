/**
 * BSC on-chain fetcher (Phase A — the network half; decoder is bsc-swaps.ts).
 *
 * Pulls a wallet's ERC-20 Transfer logs via eth_getLogs (server-side topic
 * filter — no full-chain scan), decodes them into swaps, runs the PnL engine.
 *
 * PROVIDER NOTE (verified 2026-07-01): FREE PUBLIC BSC RPCs CANNOT serve
 * per-wallet history — bsc-dataseed/defibit "limit exceeded", 1rpc caps
 * getLogs to 50-block ranges, publicnode requires an archive token. Point
 * queries (getBalance/txCount) work, historical getLogs does not. Use a real
 * provider: the repo's ALCHEMY_API_KEY works once BNB Smart Chain is enabled
 * on the app (free dashboard toggle) — Alchemy allows wide getLogs and, better,
 * `alchemy_getAssetTransfers` (address-indexed, decoded values + timestamps, no
 * block scan). Point `rpcUrls` at the Alchemy BNB endpoint. See
 * memory/onchain-web3-enrichment-plan.md.
 *
 * Ordering uses block height (the decoder's fallback ts) — no per-block
 * timestamp storm; PnL accounting only needs a monotonic order.
 */

import {
  bscQuoteConfig,
  decodeTransfersToSwaps,
  NATIVE_BNB,
  type NormalizedTransfer,
} from './bsc-swaps'
import { computeWalletPnl, type WalletPnl } from './pnl-accounting'

/** Alchemy BNB endpoint from the shared key (BNB network enabled 2026-07-01). */
function alchemyBscUrl(): string {
  const key = process.env.ALCHEMY_API_KEY
  if (!key) throw new Error('[onchain] ALCHEMY_API_KEY missing')
  return `https://bnb-mainnet.g.alchemy.com/v2/${key}`
}

interface RpcOpts {
  rpcUrls?: string[]
  timeoutMs?: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

async function rpc<T>(
  method: string,
  params: unknown[],
  opts: RpcOpts = {},
  rpcIndex = 0
): Promise<T> {
  const urls = opts.rpcUrls && opts.rpcUrls.length > 0 ? opts.rpcUrls : [alchemyBscUrl()]
  const url = urls[rpcIndex % urls.length]
  const attempts = 5
  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: ctrl.signal,
      })
      const text = await res.text()
      const json = (text ? JSON.parse(text) : {}) as { result?: T; error?: { message?: string } }
      if (json.error) throw new Error(`rpc ${method}: ${json.error.message ?? 'error'}`)
      return json.result as T
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (i < attempts - 1 && isTransient(msg)) {
        await sleep(400 * 2 ** i)
        continue
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(`rpc ${method}: exhausted retries`)
}

export async function getBscHead(opts: RpcOpts = {}): Promise<number> {
  const hex = await rpc<string>('eth_blockNumber', [], opts)
  return Number(BigInt(hex))
}

interface AlchemyTransfer {
  hash: string
  from: string
  to: string | null
  value: number | null
  asset?: string | null
  category?: string
  rawContract?: { address?: string | null }
  metadata?: { blockTimestamp?: string }
}
interface AlchemyTransfersPage {
  transfers: AlchemyTransfer[]
  pageKey?: string
}

export interface BscDirectionCoverage {
  scanComplete: boolean
  truncated: boolean
  stopReason: 'lookback_boundary' | 'history_exhausted' | 'page_cap'
  pagesFetched: number
  recordsSeen: number
  recordsReturned: number
  recordsMissingTimestamp: number
}

export interface BscTransferCoverage {
  fromAddress: BscDirectionCoverage
  toAddress: BscDirectionCoverage
  scanComplete: boolean
  truncated: boolean
}

export interface BscTransferScan {
  transfers: NormalizedTransfer[]
  coverage: BscTransferCoverage
}

/**
 * Fetch a wallet's ERC-20 transfers (both directions) via
 * alchemy_getAssetTransfers — address-indexed, decoded values + timestamps, no
 * block scan. Paginates by pageKey; `sinceMs` stops once transfers predate the
 * lookback window (order desc). Two directions merged.
 */
export async function scanWalletTransfers(
  wallet: string,
  opts: RpcOpts & { sinceMs?: number; maxPages?: number } = {}
): Promise<BscTransferScan> {
  const sinceMs = opts.sinceMs ?? 0
  const maxPages = opts.maxPages ?? 20
  if (!Number.isSafeInteger(maxPages) || maxPages <= 0) {
    throw new RangeError('maxPages must be a positive safe integer')
  }

  // erc20 = token legs; external/internal = NATIVE BNB legs (most BSC memecoin
  // swaps pay in native BNB — without these every swap looks quote-less).
  const categories = ['erc20', 'external', 'internal']
  const scanDirection = async (
    dir: 'fromAddress' | 'toAddress'
  ): Promise<{ transfers: NormalizedTransfer[]; coverage: BscDirectionCoverage }> => {
    const transfers: NormalizedTransfer[] = []
    let pageKey: string | undefined
    let pagesFetched = 0
    let recordsSeen = 0
    let recordsMissingTimestamp = 0

    const finish = (
      stopReason: BscDirectionCoverage['stopReason']
    ): { transfers: NormalizedTransfer[]; coverage: BscDirectionCoverage } => ({
      transfers,
      coverage: {
        scanComplete: stopReason !== 'page_cap' && recordsMissingTimestamp === 0,
        truncated: stopReason === 'page_cap',
        stopReason,
        pagesFetched,
        recordsSeen,
        recordsReturned: transfers.length,
        recordsMissingTimestamp,
      },
    })

    for (let page = 0; page < maxPages; page++) {
      const params: Record<string, unknown> = {
        [dir]: wallet,
        category: categories,
        withMetadata: true,
        order: 'desc',
        maxCount: '0x3e8', // 1000
      }
      if (pageKey) params.pageKey = pageKey
      const res = await rpc<AlchemyTransfersPage>('alchemy_getAssetTransfers', [params], opts)
      pagesFetched += 1
      if (!res || !Array.isArray(res.transfers)) {
        throw new Error('alchemy_getAssetTransfers: invalid result')
      }
      const rows = res.transfers
      recordsSeen += rows.length
      for (const t of rows) {
        const ts = t.metadata?.blockTimestamp
        if (!ts) {
          recordsMissingTimestamp += 1
          continue
        }
        const tsMs = Date.parse(ts)
        if (!Number.isFinite(tsMs)) {
          recordsMissingTimestamp += 1
          continue
        }
        if (sinceMs && tsMs < sinceMs) {
          return finish('lookback_boundary')
        }
        if (t.value == null || !Number.isFinite(t.value) || t.value <= 0) continue
        // Native BNB leg (no contract) → sentinel token; else the ERC-20 contract.
        const contract = t.rawContract?.address?.toLowerCase()
        const token = contract ?? (t.asset === 'BNB' ? NATIVE_BNB : null)
        if (!token) continue
        transfers.push({ token, from: t.from, to: t.to ?? '', amount: t.value, tx: t.hash, ts })
      }
      pageKey = res?.pageKey
      if (!pageKey) return finish('history_exhausted')
    }

    return finish('page_cap')
  }

  const fromAddress = await scanDirection('fromAddress')
  const toAddress = await scanDirection('toAddress')
  return {
    transfers: [...fromAddress.transfers, ...toAddress.transfers],
    coverage: {
      fromAddress: fromAddress.coverage,
      toAddress: toAddress.coverage,
      scanComplete: fromAddress.coverage.scanComplete && toAddress.coverage.scanComplete,
      truncated: fromAddress.coverage.truncated || toAddress.coverage.truncated,
    },
  }
}

/** Compatibility wrapper for callers that only need normalized transfers. */
export async function fetchWalletTransfers(
  wallet: string,
  opts: RpcOpts & { sinceMs?: number; maxPages?: number } = {}
): Promise<NormalizedTransfer[]> {
  return (await scanWalletTransfers(wallet, opts)).transfers
}

export type BscTransactionUnresolvedReason = 'not_found' | 'rpc_error' | 'invalid_response'

export interface BscTransactionPoint {
  hash: string
  from: string
  to: string | null
  input: string
  blockNumber: string | null
  blockHash: string | null
}

export interface BscReceiptLog {
  address: string
  topics: string[]
  data: string
  logIndex: string | null
}

export interface BscTransactionReceiptPoint {
  transactionHash: string
  status: string | null
  blockNumber: string | null
  blockHash: string | null
  logs: BscReceiptLog[]
}

export interface BscTransactionEvidence {
  txHash: string
  transaction: BscTransactionPoint | null
  receipt: BscTransactionReceiptPoint | null
  unresolved: {
    transaction: BscTransactionUnresolvedReason | null
    receipt: BscTransactionUnresolvedReason | null
  }
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const EVM_HASH_RE = /^0x[0-9a-fA-F]{64}$/
const HEX_DATA_RE = /^0x(?:[0-9a-fA-F]{2})*$/
const RPC_QUANTITY_RE = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === 'string' || value === null
}

function isHashOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && EVM_HASH_RE.test(value))
}

function isQuantityOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && RPC_QUANTITY_RE.test(value))
}

function parseTransactionPoint(value: unknown, txHash: string): BscTransactionPoint | null {
  if (!isRecord(value)) return null
  if (
    typeof value.hash !== 'string' ||
    !EVM_HASH_RE.test(value.hash) ||
    value.hash.toLowerCase() !== txHash ||
    typeof value.from !== 'string' ||
    !EVM_ADDRESS_RE.test(value.from) ||
    !isStringOrNull(value.to) ||
    (value.to !== null && !EVM_ADDRESS_RE.test(value.to)) ||
    typeof value.input !== 'string' ||
    !HEX_DATA_RE.test(value.input) ||
    !isQuantityOrNull(value.blockNumber) ||
    !isHashOrNull(value.blockHash) ||
    (value.blockNumber === null) !== (value.blockHash === null)
  ) {
    return null
  }
  return {
    hash: value.hash,
    from: value.from,
    to: value.to,
    input: value.input,
    blockNumber: value.blockNumber,
    blockHash: value.blockHash,
  }
}

function parseReceiptPoint(value: unknown, txHash: string): BscTransactionReceiptPoint | null {
  if (!isRecord(value) || !Array.isArray(value.logs)) return null
  if (
    typeof value.transactionHash !== 'string' ||
    !EVM_HASH_RE.test(value.transactionHash) ||
    value.transactionHash.toLowerCase() !== txHash ||
    !isStringOrNull(value.status) ||
    (value.status !== null && value.status !== '0x0' && value.status !== '0x1') ||
    !isQuantityOrNull(value.blockNumber) ||
    !isHashOrNull(value.blockHash) ||
    (value.blockNumber === null) !== (value.blockHash === null)
  ) {
    return null
  }

  const logs: BscReceiptLog[] = []
  for (const rawLog of value.logs) {
    if (
      !isRecord(rawLog) ||
      typeof rawLog.address !== 'string' ||
      !EVM_ADDRESS_RE.test(rawLog.address) ||
      !Array.isArray(rawLog.topics) ||
      !rawLog.topics.every((topic) => typeof topic === 'string' && EVM_HASH_RE.test(topic)) ||
      typeof rawLog.data !== 'string' ||
      !HEX_DATA_RE.test(rawLog.data) ||
      !isQuantityOrNull(rawLog.logIndex)
    ) {
      return null
    }
    logs.push({
      address: rawLog.address,
      topics: rawLog.topics,
      data: rawLog.data,
      logIndex: rawLog.logIndex,
    })
  }

  return {
    transactionHash: value.transactionHash,
    status: value.status,
    blockNumber: value.blockNumber,
    blockHash: value.blockHash,
    logs,
  }
}

/**
 * Read-only point evidence for one BSC transaction. This intentionally does no
 * router classification or trace lookup and is not part of wallet PnL serving.
 * Provider failures are reduced to fixed reasons so RPC URLs and credentials
 * can never enter the returned evidence.
 */
export async function fetchBscTransactionEvidence(
  txHashInput: string,
  opts: RpcOpts = {}
): Promise<BscTransactionEvidence> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHashInput)) {
    throw new TypeError('txHash must be a 0x-prefixed 32-byte hex string')
  }
  const txHash = txHashInput.toLowerCase()
  const [transactionResult, receiptResult] = await Promise.allSettled([
    rpc<unknown>('eth_getTransactionByHash', [txHash], opts),
    rpc<unknown>('eth_getTransactionReceipt', [txHash], opts),
  ])

  const transaction =
    transactionResult.status === 'fulfilled' && transactionResult.value !== null
      ? parseTransactionPoint(transactionResult.value, txHash)
      : null
  const receipt =
    receiptResult.status === 'fulfilled' && receiptResult.value !== null
      ? parseReceiptPoint(receiptResult.value, txHash)
      : null

  const unresolvedReason = (
    result: PromiseSettledResult<unknown>,
    parsed: unknown
  ): BscTransactionUnresolvedReason | null => {
    if (result.status === 'rejected') return 'rpc_error'
    if (result.value === null) return 'not_found'
    return parsed === null ? 'invalid_response' : null
  }

  return {
    txHash,
    transaction,
    receipt,
    unresolved: {
      transaction: unresolvedReason(transactionResult, transaction),
      receipt: unresolvedReason(receiptResult, receipt),
    },
  }
}

/** Public BNB/USD spot (keyless). Falls back to a sane default on failure. */
export async function fetchBnbUsd(opts: { timeoutMs?: number } = {}): Promise<number> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000)
  try {
    // llama prices — keyless, no geo issues. coingecko id: binancecoin.
    const res = await fetch('https://coins.llama.fi/prices/current/coingecko:binancecoin', {
      signal: ctrl.signal,
    })
    const json = (await res.json()) as { coins?: Record<string, { price?: number }> }
    const p = json.coins?.['coingecko:binancecoin']?.price
    if (typeof p === 'number' && p > 0) return p
  } catch {
    /* fall through */
  } finally {
    clearTimeout(timer)
  }
  return 600 // conservative fallback; only scales WBNB-quoted legs
}

export interface BscWalletResult {
  wallet: string
  lookbackDays: number
  transfers: number
  swaps: number
  bnbUsd: number
  transferCoverage: BscTransferCoverage
  pnl: WalletPnl
}

/** End-to-end: fetch → decode → PnL for one BSC wallet over the last N days.
 *  `extraTransfers` injects legs Alchemy omits (Dune-sourced native-BNB SELL
 *  receipts — item C) so those sells complete. */
export async function computeBscWalletOnchain(
  wallet: string,
  opts: RpcOpts & {
    lookbackDays?: number
    maxPages?: number
    bnbUsd?: number
    extraTransfers?: NormalizedTransfer[]
  } = {}
): Promise<BscWalletResult> {
  const lookbackDays = opts.lookbackDays ?? 90
  const sinceMs = Date.now() - lookbackDays * 86_400_000
  const [transferScan, bnbUsd] = await Promise.all([
    scanWalletTransfers(wallet, { ...opts, sinceMs }),
    opts.bnbUsd !== undefined ? Promise.resolve(opts.bnbUsd) : fetchBnbUsd(opts),
  ])
  const transfers = transferScan.transfers
  const allTransfers = opts.extraTransfers ? [...transfers, ...opts.extraTransfers] : transfers
  const swaps = decodeTransfersToSwaps(allTransfers, wallet, bscQuoteConfig(bnbUsd))
  return {
    wallet,
    lookbackDays,
    transfers: allTransfers.length,
    swaps: swaps.length,
    bnbUsd,
    transferCoverage: transferScan.coverage,
    pnl: computeWalletPnl(swaps),
  }
}
