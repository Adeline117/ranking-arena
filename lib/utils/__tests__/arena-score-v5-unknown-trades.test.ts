import {
  ARENA_V4_CONFIG,
  computeArenaScoresV4,
  computeArenaScoresV5,
  type TraderScoreInputV4,
} from '../arena-score'

// Deterministic 200-trader cohort (no Math.random) around which a probe trader
// with fixed metrics varies only its trade count.
function cohort(): TraderScoreInputV4[] {
  return Array.from({ length: 200 }, (_, i) => ({
    roi: 5 + ((i * 37) % 300),
    pnl: 1_000 + ((i * 7919) % 500_000),
    maxDrawdown: 3 + ((i * 13) % 60),
    winRate: 35 + ((i * 17) % 50),
    sharpeRatio: 0.2 + ((i * 11) % 30) / 10,
    profitFactor: 0.8 + ((i * 5) % 20) / 10,
    tradesCount: 20 + ((i * 29) % 400),
  }))
}

const probeBase: Omit<TraderScoreInputV4, 'tradesCount'> = {
  roi: 150,
  pnl: 50_000,
  maxDrawdown: 20,
  winRate: 60,
  sharpeRatio: 1.5,
  profitFactor: 1.6,
}

function probe(
  scorer: typeof computeArenaScoresV5,
  tradesCount: number | null
): { score: number; confidence: number } {
  const results = scorer([...cohort(), { ...probeBase, tradesCount }], '30D')
  const r = results[results.length - 1]
  return { score: r.totalScore, confidence: r.confidence }
}

describe('Arena Score V5 — unknown/zero trade counts never out-rank small real samples', () => {
  it('unknown (0/null) confidence equals the ~5-trade equivalent', () => {
    const zero = probe(computeArenaScoresV5, 0)
    const unknown = probe(computeArenaScoresV5, null)
    const five = probe(computeArenaScoresV5, ARENA_V4_CONFIG.UNKNOWN_TRADES_EQUIV)
    expect(zero).toEqual(unknown)
    expect(zero.confidence).toBe(five.confidence)
    expect(zero.score).toBe(five.score)
  })

  it('audit probes: t=0 scores below t=10 and t=21 (was 60.6 > 47.7 / 59.9 under 0.3)', () => {
    const s0 = probe(computeArenaScoresV5, 0).score
    const s1 = probe(computeArenaScoresV5, 1).score
    const s10 = probe(computeArenaScoresV5, 10).score
    const s21 = probe(computeArenaScoresV5, 21).score
    expect(s1).toBeLessThan(s0) // 1 real trade is a smaller sample than the 5-trade floor
    expect(s0).toBeLessThan(s10)
    expect(s10).toBeLessThan(s21)
  })

  it('V4 keeps the frozen legacy 0.3 contract (golden vectors / PG17 parity)', () => {
    const v4Zero = probe(computeArenaScoresV4, 0)
    const v4TwentyOne = probe(computeArenaScoresV4, 21)
    // legacy defect preserved for reproducibility: unknown ≈ 21.4 trades
    expect(v4Zero.score).toBeGreaterThanOrEqual(v4TwentyOne.score)
  })
})
