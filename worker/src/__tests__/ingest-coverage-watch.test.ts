/**
 * @jest-environment node
 */
import type IORedis from 'ioredis'
import { alertUncoveredRegions } from '../ingest/region-coverage'
import {
  INGEST_COVERAGE_WATCH_INTERVAL_MS,
  startIngestCoverageWatch,
} from '../ingest-coverage-watch'

const redis = {} as IORedis

describe('scoring-side ingest coverage watch', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('checks the ingest heartbeat on every tick, not before the first', async () => {
    const check = jest.fn(async () => [])
    const timer = startIngestCoverageWatch(redis, { check })
    try {
      expect(check).not.toHaveBeenCalled()
      jest.advanceTimersByTime(INGEST_COVERAGE_WATCH_INTERVAL_MS)
      jest.advanceTimersByTime(INGEST_COVERAGE_WATCH_INTERVAL_MS)
      expect(check).toHaveBeenCalledTimes(2)
      expect(check).toHaveBeenCalledWith(redis)
    } finally {
      clearInterval(timer)
    }
  })

  it('keeps running when a check fails', async () => {
    const log = jest.fn()
    const check = jest
      .fn<Promise<unknown>, [IORedis]>()
      .mockRejectedValueOnce(new Error('redis down'))
      .mockResolvedValue([])
    const timer = startIngestCoverageWatch(redis, { check, log })
    try {
      jest.advanceTimersByTime(INGEST_COVERAGE_WATCH_INTERVAL_MS)
      await Promise.resolve()
      await Promise.resolve()
      expect(log).toHaveBeenCalledWith('[worker] ingest coverage watch failed:', 'redis down')
      jest.advanceTimersByTime(INGEST_COVERAGE_WATCH_INTERVAL_MS)
      expect(check).toHaveBeenCalledTimes(2)
    } finally {
      clearInterval(timer)
    }
  })
})

describe('what the watch pages', () => {
  const NOW = Date.parse('2026-11-21T20:00:00.000Z')
  const beat = (regions: string[], ageMs: number) =>
    JSON.stringify({ ts: NOW - ageMs, regions, release_id: 'a'.repeat(64) })

  it('pages the local region when its only worker stopped heart-beating', async () => {
    // The incident: the ingest worker is "online" but its heartbeat stopped 7 hours ago,
    // while the scoring process is alive.
    const roster = {
      'AdelinedeMac-mini.local': beat(['local'], 7 * 3600_000),
      'scoring@AdelinedeMac-mini.local': beat(['scoring'], 30_000),
    }
    const send = jest.fn(async () => undefined)
    const reader = { hgetall: jest.fn(async () => roster) } as unknown as IORedis

    const uncovered = await alertUncoveredRegions(reader, NOW, send)

    expect(uncovered).toContain('local')
    expect(send).toHaveBeenCalledWith(
      reader,
      expect.objectContaining({
        sourceSlug: 'framework:region-uncovered:local',
        tier: 'A',
        phase: 0,
      })
    )
  })
})
