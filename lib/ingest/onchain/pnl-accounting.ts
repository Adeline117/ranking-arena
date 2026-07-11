/**
 * On-chain wallet PnL accounting (Phase A — the durable "自己算" core).
 *
 * web3 sources (binance_web3 / okx_web3_solana) are wallet trackers whose
 * profile detail sits behind exchange bot-shields (AWS WAF — see
 * docs/UNREACHABLE_FIELDS_LEDGER.md). The underlying truth is ON-CHAIN and
 * permissionless, so we reconstruct the same figures ourselves from the
 * wallet's swap history — no exchange, no WAF, permanent.
 *
 * This module is the chain-AGNOSTIC accounting core: feed it a stream of
 * normalized swaps (a BSC/Solana fetcher produces these) and it computes
 * average-cost realized PnL, per-token positions, and closed-position win
 * rate — the CEX-equivalent metrics the board's win_rate_distribution /
 * top_tokens_total_pnl expose. Pure & dependency-free (parser-grade, testable).
 *
 * Accounting method: AVERAGE COST basis per token (the convention memecoin
 * trackers use, and robust to partial fills). A "closed position" = a token
 * whose held amount returns to ~0 after having been positive; its realized
 * PnL sign decides win/loss for win-rate.
 */

export interface OnchainSwap {
  /** Token mint (Solana) or contract (BSC) of the NON-quote asset traded. */
  token: string
  /** ISO timestamp of the swap. */
  ts: string
  /** buy = wallet acquired `token` (paid quote); sell = wallet disposed `token` (received quote). */
  side: 'buy' | 'sell'
  /** Amount of `token` moved (positive). */
  tokenAmount: number
  /** USD value of the QUOTE leg (positive) — cost on a buy, proceeds on a sell. */
  usdValue: number
}

export interface PerTokenPnl {
  token: string
  realizedPnlUsd: number
  /** Token amount still held (>0 ⇒ open position). */
  holding: number
  /** Remaining cost basis (USD) of the held amount. */
  costBasisUsd: number
  buyVolumeUsd: number
  sellVolumeUsd: number
  swaps: number
  /** Fully-closed cycles for this token (holding returned to ~0). */
  closedPositions: number
  winningPositions: number
}

export interface WalletPnl {
  realizedPnlUsd: number
  /** Per-day realized PnL deltas (UTC date → USD), active days only, sorted.
   *  Chain-derived pnl_daily 序列的原料(BSC 无交易所序列,链上自算;方向
   *  已获 owner 批准 = web3 链上自算 Phase B)。 */
  dailyRealized: Array<{ ts: string; value: number }>
  buyVolumeUsd: number
  sellVolumeUsd: number
  totalVolumeUsd: number
  txsBuy: number
  txsSell: number
  tokensTraded: number
  /** Count of closed positions across all tokens (holding returned to ~0). */
  closedPositions: number
  winningPositions: number
  /** Percent 0-100 over closed positions; null when none closed. */
  winRate: number | null
  perToken: PerTokenPnl[]
}

const EPS = 1e-9

/** Dust threshold: a holding within this fraction of its peak is "closed". */
const CLOSE_FRACTION = 1e-4

interface TokenState {
  realized: number
  holding: number
  costBasis: number
  buyVol: number
  sellVol: number
  swaps: number
  peakHolding: number
  /** realized PnL accumulated within the CURRENT open cycle. */
  cycleRealized: number
  inPosition: boolean
  closed: number
  won: number
}

function newState(): TokenState {
  return {
    realized: 0,
    holding: 0,
    costBasis: 0,
    buyVol: 0,
    sellVol: 0,
    swaps: 0,
    peakHolding: 0,
    cycleRealized: 0,
    inPosition: false,
    closed: 0,
    won: 0,
  }
}

/**
 * Fold a wallet's swap history into PnL stats. Swaps are sorted by ts
 * defensively; malformed rows (non-finite / non-positive) are skipped.
 */
export function computeWalletPnl(swaps: OnchainSwap[]): WalletPnl {
  const clean = (Array.isArray(swaps) ? swaps : [])
    .filter(
      (s) =>
        s &&
        (s.side === 'buy' || s.side === 'sell') &&
        typeof s.token === 'string' &&
        s.token.length > 0 &&
        Number.isFinite(s.tokenAmount) &&
        s.tokenAmount > 0 &&
        Number.isFinite(s.usdValue) &&
        s.usdValue >= 0 &&
        typeof s.ts === 'string'
    )
    .slice()
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))

  const states = new Map<string, TokenState>()
  let txsBuy = 0
  let txsSell = 0
  const dailyRealized = new Map<string, number>()

  for (const s of clean) {
    let st = states.get(s.token)
    if (!st) {
      st = newState()
      states.set(s.token, st)
    }
    st.swaps += 1

    if (s.side === 'buy') {
      txsBuy += 1
      st.buyVol += s.usdValue
      st.holding += s.tokenAmount
      st.costBasis += s.usdValue
      st.peakHolding = Math.max(st.peakHolding, st.holding)
      st.inPosition = true
    } else {
      txsSell += 1
      st.sellVol += s.usdValue
      // Average-cost of the portion sold; can't sell more basis than held.
      const soldTokens = Math.min(s.tokenAmount, st.holding)
      const avgCost = st.holding > EPS ? st.costBasis / st.holding : 0
      const costOfSold = avgCost * soldTokens
      const realizedHere = s.usdValue - costOfSold
      st.realized += realizedHere
      st.cycleRealized += realizedHere
      const day = s.ts.slice(0, 10)
      dailyRealized.set(day, (dailyRealized.get(day) ?? 0) + realizedHere)
      st.holding = Math.max(0, st.holding - s.tokenAmount)
      st.costBasis = Math.max(0, st.costBasis - costOfSold)

      // Position closed when holding falls back to dust relative to its peak.
      if (st.inPosition && st.holding <= st.peakHolding * CLOSE_FRACTION + EPS) {
        st.closed += 1
        if (st.cycleRealized > 0) st.won += 1
        st.cycleRealized = 0
        st.inPosition = false
        st.peakHolding = 0
        st.costBasis = 0 // dust cleanup — avoid negative-basis drift
      }
    }
  }

  const perToken: PerTokenPnl[] = []
  let realizedPnlUsd = 0
  let buyVolumeUsd = 0
  let sellVolumeUsd = 0
  let closedPositions = 0
  let winningPositions = 0

  for (const [token, st] of states) {
    realizedPnlUsd += st.realized
    buyVolumeUsd += st.buyVol
    sellVolumeUsd += st.sellVol
    closedPositions += st.closed
    winningPositions += st.won
    perToken.push({
      token,
      realizedPnlUsd: round2(st.realized),
      holding: st.holding,
      costBasisUsd: round2(st.costBasis),
      buyVolumeUsd: round2(st.buyVol),
      sellVolumeUsd: round2(st.sellVol),
      swaps: st.swaps,
      closedPositions: st.closed,
      winningPositions: st.won,
    })
  }
  perToken.sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd)

  return {
    realizedPnlUsd: round2(realizedPnlUsd),
    dailyRealized: [...dailyRealized.entries()]
      .map(([ts, v]) => ({ ts, value: round2(v) }))
      .sort((a, b) => (a.ts < b.ts ? -1 : 1)),
    buyVolumeUsd: round2(buyVolumeUsd),
    sellVolumeUsd: round2(sellVolumeUsd),
    totalVolumeUsd: round2(buyVolumeUsd + sellVolumeUsd),
    txsBuy,
    txsSell,
    tokensTraded: states.size,
    closedPositions,
    winningPositions,
    winRate:
      closedPositions > 0 ? Math.round((winningPositions / closedPositions) * 10000) / 100 : null,
    perToken,
  }
}

function round2(x: number): number {
  return Math.round(x * 100) / 100
}
