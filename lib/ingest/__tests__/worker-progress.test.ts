import { evaluateWorkerProgress, WORKER_PROGRESS_STALE_MS } from '../worker-progress'

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
