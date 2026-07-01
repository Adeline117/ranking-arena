/**
 * Hyperliquid fills replay (M3-3a, DEX Tier-2 链上算).
 *
 * The info endpoint's `userFillsByTime` returns raw fills; nothing hands over
 * winRate / positions / holding-time — we reconstruct ROUND-TRIPS per coin
 * from the fills' `startPosition` (position size BEFORE the fill, signed):
 *   trip opens  when startPosition == 0 and the fill moves it off zero,
 *   trip closes when the post-fill position returns to 0.
 * A direction flip (position crosses through zero in one fill) closes the old
 * trip at the fill price and opens a new one — an approximation, flagged in
 * the trip. Realized PnL sums `closedPnl` minus fees over the trip's fills
 * (HL closedPnl is per-fill realized PnL).
 *
 * Pure + dependency-free (parser-grade): consumed by parseHyperliquidProfile
 * (winRate/positions/holding/pnl_ratio) and the position_history surface.
 * Provenance: callers tag `extras.fills_derivation = 'fills-replay'`.
 */

export interface HlFill {
  coin?: unknown
  px?: unknown
  sz?: unknown
  side?: unknown // 'B' buy | 'A' sell
  time?: unknown // ms epoch
  startPosition?: unknown // signed position size BEFORE this fill
  closedPnl?: unknown
  fee?: unknown
  dir?: unknown
}

export interface RoundTrip {
  coin: string
  side: 'long' | 'short'
  openedAtMs: number
  closedAtMs: number
  /** Size-weighted average entry / exit price. */
  entryPrice: number
  exitPrice: number
  /** Max absolute position size reached during the trip. */
  size: number
  /** Σ closedPnl − Σ fee over the trip's fills. */
  realizedPnl: number
  /** True when the trip boundary came from a direction flip (approximation). */
  fromFlip: boolean
  fills: number
}

export interface FillStats {
  totalPositions: number
  winPositions: number
  /** Percent 0-100. */
  winRate: number | null
  /** Hours, mean over closed trips. */
  avgHoldingHours: number | null
  /** avg win / |avg loss| — null when no losses (disclosed, not ∞). */
  pnlRatio: number | null
  tripsPerWeek: number | null
  trips: RoundTrip[]
}

const EPS = 1e-9

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Signed size delta of a fill: side B = +sz (buy), A = −sz (sell). */
function signedSz(f: HlFill): number | null {
  const sz = num(f.sz)
  if (sz === null) return null
  if (f.side === 'B') return sz
  if (f.side === 'A') return -sz
  return null
}

interface OpenTrip {
  side: 'long' | 'short'
  openedAtMs: number
  entryNotional: number
  entrySize: number
  exitNotional: number
  exitSize: number
  maxAbs: number
  realized: number
  fills: number
  fromFlip: boolean
}

/** Reconstruct closed round-trips from fills (any order; sorted internally). */
export function reconstructRoundTrips(fills: HlFill[], windowStartMs = 0): RoundTrip[] {
  const byCoin = new Map<string, HlFill[]>()
  for (const f of fills) {
    if (typeof f.coin !== 'string' || f.coin.length === 0) continue
    const t = num(f.time)
    if (t === null || t < windowStartMs) continue
    let arr = byCoin.get(f.coin)
    if (!arr) {
      arr = []
      byCoin.set(f.coin, arr)
    }
    arr.push(f)
  }

  const trips: RoundTrip[] = []
  for (const [coin, arr] of byCoin) {
    arr.sort((a, b) => (num(a.time) ?? 0) - (num(b.time) ?? 0))
    let open: OpenTrip | null = null
    for (const f of arr) {
      const delta = signedSz(f)
      const start = num(f.startPosition)
      const t = num(f.time)
      const px = num(f.px)
      if (delta === null || start === null || t === null || px === null) continue
      const end = start + delta
      const realized = (num(f.closedPnl) ?? 0) - (num(f.fee) ?? 0)

      // If our tracked state disagrees with startPosition (missed fills before
      // the window), resync: only track trips we saw open from flat.
      if (open === null) {
        if (Math.abs(start) < EPS && Math.abs(end) > EPS) {
          open = {
            side: end > 0 ? 'long' : 'short',
            openedAtMs: t,
            entryNotional: Math.abs(delta) * px,
            entrySize: Math.abs(delta),
            exitNotional: 0,
            exitSize: 0,
            maxAbs: Math.abs(end),
            realized,
            fills: 1,
            fromFlip: false,
          }
        }
        continue
      }

      open.fills += 1
      open.realized += realized
      open.maxAbs = Math.max(open.maxAbs, Math.abs(end))
      const increasing = Math.abs(end) > Math.abs(start)
      if (increasing) {
        open.entryNotional += Math.abs(delta) * px
        open.entrySize += Math.abs(delta)
      } else {
        open.exitNotional += Math.abs(delta) * px
        open.exitSize += Math.abs(delta)
      }

      const flipped = Math.abs(end) > EPS && Math.sign(end) !== Math.sign(start)
      if (Math.abs(end) < EPS || flipped) {
        trips.push({
          coin,
          side: open.side,
          openedAtMs: open.openedAtMs,
          closedAtMs: t,
          entryPrice: open.entrySize > EPS ? open.entryNotional / open.entrySize : px,
          exitPrice: open.exitSize > EPS ? open.exitNotional / open.exitSize : px,
          size: open.maxAbs,
          realizedPnl: Math.round(open.realized * 1e6) / 1e6,
          fromFlip: flipped,
          fills: open.fills,
        })
        open = flipped
          ? {
              side: end > 0 ? 'long' : 'short',
              openedAtMs: t,
              entryNotional: Math.abs(end) * px,
              entrySize: Math.abs(end),
              exitNotional: 0,
              exitSize: 0,
              maxAbs: Math.abs(end),
              realized: 0,
              fills: 0,
              fromFlip: true,
            }
          : null
      }
    }
  }
  trips.sort((a, b) => b.closedAtMs - a.closedAtMs)
  return trips
}

/** Aggregate closed trips into the CEX-equivalent per-TF stats. */
export function fillStats(fills: HlFill[], windowStartMs: number, windowDays: number): FillStats {
  const trips = reconstructRoundTrips(fills, windowStartMs)
  const total = trips.length
  const wins = trips.filter((t) => t.realizedPnl > 0)
  const losses = trips.filter((t) => t.realizedPnl < 0)
  const holdHoursList = trips.map((t) => (t.closedAtMs - t.openedAtMs) / 3_600_000)
  const avgHold =
    holdHoursList.length > 0
      ? holdHoursList.reduce((a, b) => a + b, 0) / holdHoursList.length
      : null
  const avgWin = wins.length > 0 ? wins.reduce((a, t) => a + t.realizedPnl, 0) / wins.length : null
  const avgLoss =
    losses.length > 0 ? losses.reduce((a, t) => a + t.realizedPnl, 0) / losses.length : null

  return {
    totalPositions: total,
    winPositions: wins.length,
    winRate: total > 0 ? Math.round((wins.length / total) * 10000) / 100 : null,
    avgHoldingHours: avgHold === null ? null : Math.round(avgHold * 100) / 100,
    pnlRatio:
      avgWin !== null && avgLoss !== null && Math.abs(avgLoss) > EPS
        ? Math.round((avgWin / Math.abs(avgLoss)) * 100) / 100
        : null,
    tripsPerWeek: windowDays > 0 ? Math.round((total / windowDays) * 7 * 100) / 100 : null,
    trips,
  }
}
