import {
  compositeArenaScore,
  compositeUpperBound,
  rankCompositeCohort,
  type Composite90Row,
} from '../composite-ranking'

type Row = Composite90Row & { s30: number | null; s7: number | null }

// Deterministic pseudo-random cohort (LCG), sorted like the 90D view.
function cohort(n: number, seed = 7): Row[] {
  let x = seed
  const next = () => {
    x = (x * 1103515245 + 12345) % 2147483648
    return x / 2147483648
  }
  return Array.from({ length: n }, (_, i) => ({
    key: `t${i}`,
    score90d: Math.round(next() * 10000) / 100,
    s30: next() < 0.15 ? null : Math.round(next() * 10000) / 100,
    s7: next() < 0.25 ? null : Math.round(next() * 10000) / 100,
  })).sort((a, b) => b.score90d - a.score90d)
}

function scan(rows: Row[], need: number, maxScan?: number) {
  const fetched: number[] = []
  const result = rankCompositeCohort<Row>({
    need,
    batch: 50,
    maxScan,
    fetch90: async (from, to) => {
      fetched.push(from)
      return rows.slice(from, to + 1)
    },
    fetchShortScores: async (batch) =>
      new Map(batch.map((r) => [r.key, { score30d: r.s30, score7d: r.s7 }])),
  })
  return { result, fetched }
}

describe('compositeArenaScore', () => {
  it('has no composite without a 90D score', () => {
    expect(compositeArenaScore(null, 90, 90)).toBeNull()
  })

  it('never exceeds the upper bound used to stop the scan', () => {
    for (const s90 of [0, 10, 55.5, 90, 100]) {
      for (const s30 of [null, 0, 50, 100]) {
        for (const s7 of [null, 0, 50, 100]) {
          expect(compositeArenaScore(s90, s30, s7)!).toBeLessThanOrEqual(compositeUpperBound(s90))
        }
      }
    }
  })
})

describe('rankCompositeCohort', () => {
  it('returns exactly the brute-force composite order (ties by 90D order)', async () => {
    const rows = cohort(1000)
    const brute = rows
      .map((row, order) => ({ row, order, c: compositeArenaScore(row.score90d, row.s30, row.s7)! }))
      .sort((a, b) => b.c - a.c || a.order - b.order)
      .slice(0, 101)
    const { result, fetched } = scan(rows, 101)
    const out = await result
    expect(out.status).toBe('ranked')
    if (out.status !== 'ranked') return
    expect(out.ranked.map((r) => r.row.key)).toEqual(brute.map((b) => b.row.key))
    expect(out.ranked.map((r) => r.composite)).toEqual(brute.map((b) => b.c))
    // Converges before reading the whole cohort.
    expect(fetched.length).toBeLessThan(rows.length / 50)
  })

  it('returns the whole cohort when it is smaller than the request', async () => {
    const rows = cohort(30)
    const out = await scan(rows, 101).result
    expect(out.status === 'ranked' && out.ranked.length).toBe(30)
  })

  it('fails closed instead of reading past the scan bound', async () => {
    // Flat 90D scores never let the bound converge before maxScan.
    const rows = Array.from({ length: 400 }, (_, i) => ({
      key: `t${i}`,
      score90d: 50,
      s30: null,
      s7: null,
    }))
    const out = await scan(rows, 101, 100).result
    expect(out).toEqual({ status: 'scan_bounded' })
  })
})
