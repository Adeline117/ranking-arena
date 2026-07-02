/**
 * Tier-0 DEX risk derivation (spec §11 DEX / plan Milestone 2).
 *
 * DEX sources expose a daily *cumulative*-PnL series but NO risk metrics
 * (MDD / Sharpe / Sortino) — CEX leaderboards hand those over directly. We
 * reconstruct them on-chain-equivalent from the already-fetched daily series
 * plus a capital base (the source's reported max-capital / AUM proxy), so no
 * extra network request is needed.
 *
 * PROVENANCE — these are `daily-approx`: built from once-a-day samples, so an
 * intraday peak-to-trough that recovers before the daily close is invisible.
 * The result therefore *understates* true drawdown and overstates Sharpe.
 * Callers MUST tag `extras.risk_derivation = 'daily-approx'` so the UI/score
 * never present these as exchange-grade precise values.
 *
 * Pure & dependency-free on purpose: ingest parsers stay self-contained (no
 * `@/lib/utils/*` coupling), and this unit is independently testable.
 */

export interface CumulativePnlPoint {
  /** ISO timestamp (sorted or unsorted — we sort defensively). */
  ts: string
  /** Cumulative PnL in quote currency (USD) at this sample. */
  value: number
}

export interface SeriesRisk {
  /** Max drawdown, POSITIVE percent magnitude (e.g. 15.3) — matches all other
   *  adapters + the serving `max_drawdown >= 0` guard; null if not derivable. */
  mdd: number | null
  /** Annualised Sharpe (rf=0), daily-approx; null if insufficient samples. */
  sharpe: number | null
  /** Annualised Sortino (rf=0, downside-only), daily-approx; null if insufficient. */
  sortino: number | null
  /** Number of valid daily samples the derivation used. */
  samples: number
}

const TRADING_DAYS_PER_YEAR = 365 // crypto is 24/7
const MIN_RATIO_POINTS = 7 // statistical floor for Sharpe/Sortino
const RATIO_CAP = 10 // clamp pathological ratios (tiny-denominator blowups)

const EMPTY: SeriesRisk = { mdd: null, sharpe: null, sortino: null, samples: 0 }

/**
 * Derive MDD + Sharpe + Sortino from a daily cumulative-PnL series and a
 * positive capital base (equity_i = capitalBase + cumPnl_i).
 *
 * @param points       Daily cumulative-PnL samples (USD).
 * @param capitalBase  Positive denominator (max-capital / AUM proxy). Without a
 *                     real base, percentage MDD and per-day returns are
 *                     meaningless — returns all-null rather than guessing.
 */
export function riskFromCumulativePnl(
  points: CumulativePnlPoint[] | null | undefined,
  capitalBase: number | null | undefined
): SeriesRisk {
  if (!Array.isArray(points) || points.length < 2) return EMPTY
  if (capitalBase == null || !isFinite(capitalBase) || capitalBase <= 0) return EMPTY

  // Defensive: sort by ts, keep finite samples only.
  const clean = points
    .filter((p) => p && typeof p.ts === 'string' && p.value != null && isFinite(p.value))
    .slice()
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
  if (clean.length < 2) return EMPTY

  // Equity curve from cumulative PnL. A non-positive equity = total wipeout.
  const equity: number[] = []
  for (const p of clean) {
    const e = capitalBase + p.value
    if (e <= 0) {
      // Capital fully eroded at this sample → MDD is 100% (positive magnitude),
      // ratios undefined.
      return { mdd: 100, sharpe: null, sortino: null, samples: clean.length }
    }
    equity.push(e)
  }

  return {
    mdd: maxDrawdownPct(equity),
    sharpe: sharpeOfChanges(dailyReturns(equity)),
    sortino: sortinoOfChanges(dailyReturns(equity)),
    samples: equity.length,
  }
}

export interface PnlRatios {
  sharpe: number | null
  sortino: number | null
  samples: number
}

/**
 * Base-free Sharpe/Sortino from a cumulative-PnL series — for DEX sources that
 * expose NO capital base (e.g. gTrade, whose ROI/AUM are already NULL).
 *
 * Under the constant-capital daily-approx assumption the capital base CANCELS
 * out of both ratios: returnᵢ = Δpnlᵢ / base, and Sharpe = mean/std is
 * scale-invariant, so Sharpe = mean(Δ)/std(Δ)·√365 regardless of `base`. MDD is
 * deliberately absent here — it is scale-DEPENDENT (needs a real equity base);
 * use riskFromCumulativePnl when a base exists.
 *
 * Same daily-approx provenance caveat — caller MUST tag
 * `extras.risk_derivation = 'daily-approx'`.
 */
export function ratiosFromCumulativePnl(
  points: CumulativePnlPoint[] | null | undefined
): PnlRatios {
  if (!Array.isArray(points) || points.length < 2)
    return { sharpe: null, sortino: null, samples: 0 }
  const clean = points
    .filter((p) => p && typeof p.ts === 'string' && p.value != null && isFinite(p.value))
    .slice()
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
  if (clean.length < 2) return { sharpe: null, sortino: null, samples: 0 }
  const deltas: number[] = []
  for (let i = 1; i < clean.length; i++) deltas.push(clean[i].value - clean[i - 1].value)
  return {
    sharpe: sharpeOfChanges(deltas),
    sortino: sortinoOfChanges(deltas),
    // Report the count the ratio gate actually uses (deltas = N-1 points), so a
    // disclosed samples>=7 always implies a non-null ratio was attempted.
    samples: deltas.length,
  }
}

/**
 * MDD + Sharpe + Sortino from a DIRECT equity series (value = equity in USD,
 * e.g. Hyperliquid's accountValueHistory). This is the most honest input — MDD
 * is true peak-to-trough on the actual sampled equity, no base reconstruction.
 * Still `daily-approx` / sample-limited provenance (sparse samples miss
 * intra-sample dips) — caller MUST tag `extras.risk_derivation`.
 */
export function riskFromEquitySeries(points: CumulativePnlPoint[] | null | undefined): SeriesRisk {
  if (!Array.isArray(points) || points.length < 2) return EMPTY
  const equity = points
    .filter((p) => p && typeof p.ts === 'string' && p.value != null && isFinite(p.value))
    .slice()
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
    .map((p) => p.value)
    .filter((v) => v > 0)
  if (equity.length < 2) return EMPTY
  return {
    mdd: maxDrawdownPct(equity),
    sharpe: sharpeOfChanges(dailyReturns(equity)),
    sortino: sortinoOfChanges(dailyReturns(equity)),
    samples: equity.length,
  }
}

/**
 * Peak-to-trough max drawdown over an equity curve, returned as a POSITIVE
 * percent magnitude (e.g. 45.78) — matching every other adapter's mdd
 * convention (raw maxDrawdown/maxRetracement fields are positive), the serving
 * `max_drawdown >= 0 && < 100` guard, and the registry `inverted:true` metric.
 */
function maxDrawdownPct(equity: number[]): number | null {
  if (equity.length < 2) return null
  let peak = equity[0]
  let worst = 0 // most-negative drawdown ratio
  for (let i = 1; i < equity.length; i++) {
    const v = equity[i]
    if (v > peak) peak = v
    const dd = (v - peak) / peak // <= 0
    if (dd < worst) worst = dd
  }
  return Math.round(Math.abs(worst) * 100 * 100) / 100 // positive percent magnitude, 2dp (avoids -0)
}

/** Per-day simple returns from an equity curve. */
function dailyReturns(equity: number[]): number[] {
  const r: number[] = []
  for (let i = 1; i < equity.length; i++) {
    r.push((equity[i] - equity[i - 1]) / equity[i - 1])
  }
  return r
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

/**
 * Annualised Sharpe (rf=0), sample std-dev, clamped. `changes` are per-period
 * values — either returns (base-aware) or raw PnL deltas (base-free; the base
 * cancels in mean/std, so both yield the same Sharpe under constant capital).
 */
function sharpeOfChanges(changes: number[]): number | null {
  const r = changes
  if (r.length < MIN_RATIO_POINTS) return null
  const mu = mean(r)
  const variance = r.reduce((s, x) => s + (x - mu) * (x - mu), 0) / (r.length - 1)
  const sd = Math.sqrt(variance)
  if (sd === 0) return null // flat curve — Sharpe undefined, not infinite
  const sharpe = (mu / sd) * Math.sqrt(TRADING_DAYS_PER_YEAR)
  return clampRatio(sharpe)
}

/** Annualised Sortino (rf=0), downside deviation, clamped. See sharpeOfChanges. */
function sortinoOfChanges(changes: number[]): number | null {
  const r = changes
  if (r.length < MIN_RATIO_POINTS) return null
  const mu = mean(r)
  const negs = r.filter((x) => x < 0)
  if (negs.length === 0) return RATIO_CAP // no down days → cap rather than infinity
  // Downside deviation over the FULL sample count (standard Sortino convention).
  const downside = Math.sqrt(negs.reduce((s, x) => s + x * x, 0) / r.length)
  if (downside === 0) return RATIO_CAP
  const sortino = (mu / downside) * Math.sqrt(TRADING_DAYS_PER_YEAR)
  return clampRatio(sortino)
}

function clampRatio(x: number): number | null {
  if (!isFinite(x)) return null
  const v = Math.max(-RATIO_CAP, Math.min(RATIO_CAP, x))
  return Math.round(v * 100) / 100
}

// ── CEX self-derivation (spec §Tier-0-CEX) ─────────────────────────────────
// Many CEX sources hand over a cumulative pnl/roi chart series but NEVER a
// Sharpe/Sortino (bitget/xt/mexc/bitunix/okx_web3_solana all captured the
// series yet stored sharpe=NULL). Rather than wait for an API that will never
// expose it, we compute it ourselves from the series we already store — the
// exact same engine + provenance discipline as the DEX Tier-0 path.

interface RiskDerivableStat {
  timeframe: number
  sharpe: number | null
  mdd: number | null
  extras: Record<string, unknown>
}
interface RiskDerivableSeries {
  timeframe: number
  metric: string
  points: CumulativePnlPoint[]
}

/** Cumulative-series metrics we can honestly take period-deltas from. Ordered
 *  by preference. `pnl`/`roi` verified cumulative in prod; `*_daily` excluded
 *  (per-day semantics vary by adapter — never guess). */
const DERIVABLE_METRICS = ['pnl', 'roi'] as const

/** Annualised volatility (%) = sample-stddev of period ROI deltas × √365.
 *  ROI series only — a pnl (USD) series' stddev is dollars, not a percent. */
function volatilityFromRoiSeries(points: CumulativePnlPoint[]): number | null {
  const clean = points
    .filter((p) => p && typeof p.ts === 'string' && p.value != null && isFinite(p.value))
    .slice()
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
  if (clean.length < MIN_RATIO_POINTS + 1) return null
  const deltas: number[] = []
  for (let i = 1; i < clean.length; i++) deltas.push(clean[i].value - clean[i - 1].value)
  if (deltas.length < MIN_RATIO_POINTS) return null
  return annualizedVol(deltas)
}

/** Annualised % volatility from an array of per-period returns (already deltas). */
function annualizedVol(changes: number[]): number | null {
  if (changes.length < MIN_RATIO_POINTS) return null
  const mu = mean(changes)
  const variance = changes.reduce((s, x) => s + (x - mu) * (x - mu), 0) / (changes.length - 1)
  const vol = Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR)
  if (!isFinite(vol) || vol <= 0) return null
  return Math.round(vol * 100) / 100
}

/** Clean + sort a series' values (ascending by ts). */
function sortedValues(points: CumulativePnlPoint[]): number[] {
  return points
    .filter((p) => p && typeof p.ts === 'string' && p.value != null && isFinite(p.value))
    .slice()
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
    .map((p) => p.value)
}

export interface DerivedRisk {
  sharpe: number | null
  sortino: number | null
  /** Annualised % volatility — only from a ROI-basis series (percent). */
  volatility: number | null
}

/**
 * Derive Sharpe/Sortino/volatility from ONE series block, handling both shapes:
 *   cumulative (`pnl`/`roi`)      → period changes are consecutive diffs
 *   per-day     (`pnl_daily`/`roi_daily`) → the values ARE the period changes
 * Volatility is percent-meaningful only for a ROI basis (roi / roi_daily);
 * a USD PnL series yields Sharpe/Sortino (scale-invariant) but no volatility.
 * The board-path counterpart to deriveMissingRatios (which is cumulative-only).
 */
export function deriveRiskFromSeries(metric: string, points: CumulativePnlPoint[]): DerivedRisk {
  const empty: DerivedRisk = { sharpe: null, sortino: null, volatility: null }
  const vals = sortedValues(points)
  if (vals.length < 2) return empty
  const isDaily = metric.endsWith('_daily')
  const isRoi = metric === 'roi' || metric === 'roi_daily'
  let changes: number[]
  if (isDaily) {
    changes = vals // per-day values are already the returns/deltas
  } else {
    changes = []
    for (let i = 1; i < vals.length; i++) changes.push(vals[i] - vals[i - 1])
  }
  return {
    sharpe: sharpeOfChanges(changes),
    sortino: sortinoOfChanges(changes),
    volatility: isRoi ? annualizedVol(changes) : null,
  }
}

/** Metric preference for board-path derivation: a real cumulative pnl/roi wins;
 *  else a per-day daily series. Never a volume/lead_size series. */
const BOARD_DERIVABLE_METRICS = ['pnl', 'roi', 'pnl_daily', 'roi_daily'] as const

/**
 * Pick the best derivable series among a trader's board blocks (for one
 * timeframe) and derive risk from it. Returns null when none qualifies.
 */
export function deriveRiskFromBlocks(
  blocks: Array<{ metric: string; points: CumulativePnlPoint[] }>
): DerivedRisk | null {
  for (const metric of BOARD_DERIVABLE_METRICS) {
    const b = blocks.find((x) => x.metric === metric && x.points.length >= 2)
    if (b) {
      const r = deriveRiskFromSeries(metric, b.points)
      if (r.sharpe !== null || r.sortino !== null || r.volatility !== null) return r
    }
  }
  return null
}

/**
 * Fill missing risk ratios on stats IN PLACE from matching-timeframe cumulative
 * series — the "compute it ourselves" path, now GATED to pure-DEX sources only
 * (SELF_DERIVE_RISK_SOURCES in publish.ts: hyperliquid/gmx/gtrade). CEX and
 * blofin ship the real Sharpe/Sortino/calmar/volatility on their (harvestable)
 * profile endpoints, so self-filling would masquerade an inaccurate daily-approx
 * as the exchange value — harvest real or leave honest NULL (user directive
 * 2026-07-02). blofin's profile is reachable via unsigned uapi stat endpoints
 * (adapters/blofin), so it is NO LONGER a self-derive source.
 *
 * Each metric fills INDEPENDENTLY and ONLY when currently NULL/absent — an
 * exchange-reported value is never overridden. Gates on ≥MIN_RATIO_POINTS
 * deltas; stamps provenance. MDD untouched (base-free ratios can't yield an
 * honest percent drawdown). Pure w.r.t. inputs it doesn't own.
 */
export function deriveMissingRatios<T extends RiskDerivableStat>(
  stats: T[],
  series: RiskDerivableSeries[]
): T[] {
  if (!Array.isArray(stats) || !Array.isArray(series)) return stats
  for (const s of stats) {
    const cumSeries = DERIVABLE_METRICS.map((metric) =>
      series.find(
        (ser) => ser.timeframe === s.timeframe && ser.metric === metric && ser.points.length >= 2
      )
    ).filter(Boolean) as RiskDerivableSeries[]
    if (cumSeries.length === 0) continue
    const primary = cumSeries[0] // pnl preferred, else roi
    const roiSeries = cumSeries.find((ser) => ser.metric === 'roi')

    let derivedAny = false
    // Sharpe + Sortino from the cumulative series (base-free deltas).
    const { sharpe, sortino, samples } = ratiosFromCumulativePnl(primary.points)
    if ((s.sharpe === null || s.sharpe === undefined) && sharpe !== null) {
      s.sharpe = sharpe
      derivedAny = true
    }
    if (s.extras.sortino === undefined && sortino !== null) {
      s.extras.sortino = sortino
      derivedAny = true
    }
    // Volatility from the ROI series only (percentage-meaningful).
    if (s.extras.volatility === undefined && s.extras.roe_volatility === undefined && roiSeries) {
      const vol = volatilityFromRoiSeries(roiSeries.points)
      if (vol !== null) {
        s.extras.volatility = vol
        derivedAny = true
      }
    }
    if (derivedAny) {
      s.extras.risk_self_derived = true
      s.extras.risk_derived_samples = samples
    }
  }
  return stats
}
