import { computeArenaScoresV4, computeArenaScoresV5, type TraderScoreInputV4 } from '../arena-score'

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
  tradesCount: number | null,
  source?: string
): { score: number; confidence: number } {
  const results = scorer([...cohort(), { ...probeBase, tradesCount, source }], '30D')
  const r = results[results.length - 1]
  return { score: r.totalScore, confidence: r.confidence }
}

describe('Arena Score V4/V5 — unknown/zero trade counts never out-rank real samples', () => {
  it.each([computeArenaScoresV4, computeArenaScoresV5])(
    'unknown (null, or a CEX 0) scores exactly like 1 real trade',
    (scorer) => {
      const one = probe(scorer, 1, 'binance_futures')
      expect(probe(scorer, null, 'binance_futures')).toEqual(one)
      expect(probe(scorer, 0, 'binance_futures')).toEqual(one)
      expect(probe(scorer, null, 'hyperliquid')).toEqual(one)
    }
  )

  it.each([computeArenaScoresV4, computeArenaScoresV5])(
    'unknown never beats 1–4 real trades (audit probe: 5-trade floor beat them)',
    (scorer) => {
      const unknown = probe(scorer, null).score
      for (const t of [2, 3, 4]) expect(unknown).toBeLessThan(probe(scorer, t).score)
    }
  )

  it.each(['gmx', 'gtrade', 'hyperliquid'])(
    '%s: a self-computed 0 is a real 0 and ranks below 1 real trade',
    (source) => {
      for (const scorer of [computeArenaScoresV4, computeArenaScoresV5]) {
        const zero = probe(scorer, 0, source)
        const one = probe(scorer, 1, source)
        expect(zero.confidence).toBeLessThan(one.confidence)
        expect(zero.score).toBeLessThan(one.score)
      }
    }
  )
})

describe('Arena Score V4/V5 — large cohorts', () => {
  it('scores a 250k cohort without a call-stack RangeError', () => {
    const big: TraderScoreInputV4[] = Array.from({ length: 250_000 }, (_, i) => ({
      roi: (i % 500) + 1,
      pnl: 1_000 + i,
      maxDrawdown: (i % 50) + 1,
      winRate: (i % 60) + 20,
      sharpeRatio: null,
      profitFactor: null,
      tradesCount: (i % 300) + 1,
    }))
    const results = computeArenaScoresV4(big, '90D')
    expect(results).toHaveLength(250_000)
    expect(Math.max(...results.slice(0, 1000).map((r) => r.totalScore))).toBeLessThanOrEqual(100)
  }, 60_000)
})
