import {
  DEEP_CRAWL_STALE_FLOOR_MS,
  evaluateWorkerProgress,
  findStalledDeepCrawls,
  WORKER_PROGRESS_STALE_MS,
} from '../worker-progress'

const NOW = Date.parse('2026-11-13T12:00:00Z')
const H = 3600_000

describe('evaluateWorkerProgress', () => {
  it('flags a live ingest node whose last Tier-A publication is too old', () => {
    const res = evaluateWorkerProgress({
      ingestNodes: ['mac'],
      scoringNodes: [],
      started: { mac: String(NOW - 48 * H) },
      tierA: { mac: String(NOW - 13 * H) },
      scoring: null,
      now: NOW,
    })
    expect(res.stalled).toEqual([
      {
        node: 'mac',
        kind: 'tier_a',
        last_success_at: new Date(NOW - 13 * H).toISOString(),
        stalled_minutes: 780,
      },
    ])
  })

  it('gives a freshly restarted node a full threshold of grace', () => {
    const res = evaluateWorkerProgress({
      ingestNodes: ['mac'],
      scoringNodes: [],
      started: { mac: String(NOW - 1 * H) },
      tierA: { mac: String(NOW - 30 * H) },
      scoring: null,
      now: NOW,
    })
    expect(res.stalled).toEqual([])
  })

  it('flags a node that never published since start once the threshold passes', () => {
    const res = evaluateWorkerProgress({
      ingestNodes: [],
      scoringNodes: ['scoring@mac'],
      started: { 'scoring@mac': String(NOW - WORKER_PROGRESS_STALE_MS.scoring - 1) },
      tierA: null,
      scoring: {},
      now: NOW,
    })
    expect(res.stalled[0]).toMatchObject({
      node: 'scoring@mac',
      kind: 'scoring',
      last_success_at: null,
    })
  })

  it('reports a node without any marker as unknown, not stalled', () => {
    const res = evaluateWorkerProgress({
      ingestNodes: ['old-build'],
      scoringNodes: [],
      started: null,
      tierA: null,
      scoring: null,
      now: NOW,
    })
    expect(res).toEqual({ stalled: [], unknown: ['old-build'] })
  })
})

describe('findStalledDeepCrawls', () => {
  const sources = [
    { slug: 'bybit', cadence_tier_b_seconds: 18 * 3600, cadence_tier_d_seconds: 2 * 3600 },
  ]

  it('flags a tier whose last completion is older than twice its cadence', () => {
    const res = findStalledDeepCrawls({
      sources,
      marks: { B: { bybit: String(NOW - 37 * H) }, D: { bybit: String(NOW - 1 * H) } },
      now: NOW,
    })
    expect(res).toEqual({ stalled: [{ tier: 'B', slug: 'bybit', age_hours: 37 }], unseen: [] })
  })

  it('never pages a short-cadence tier inside the absolute floor', () => {
    const marks = (hours: number) => ({
      B: { bybit: String(NOW) },
      D: { bybit: String(NOW - hours * H) },
    })
    // 2× the 2h Tier-D cadence is 4h, but the floor is 6h.
    expect(findStalledDeepCrawls({ sources, marks: marks(5), now: NOW }).stalled).toEqual([])
    expect(DEEP_CRAWL_STALE_FLOOR_MS).toBe(6 * H)
    expect(findStalledDeepCrawls({ sources, marks: marks(6.5), now: NOW }).stalled).toEqual([
      { tier: 'D', slug: 'bybit', age_hours: 6.5 },
    ])
  })

  it('reports a source with no mark as unseen instead of stalled', () => {
    const res = findStalledDeepCrawls({ sources, marks: { B: null, D: {} }, now: NOW })
    expect(res).toEqual({
      stalled: [],
      unseen: [
        { tier: 'B', slug: 'bybit' },
        { tier: 'D', slug: 'bybit' },
      ],
    })
  })
})
