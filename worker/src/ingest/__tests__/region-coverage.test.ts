import type IORedis from 'ioredis'
import { alertScoringSilence, alertUncoveredRegions } from '../region-coverage'

const NOW = Date.parse('2026-11-14T12:00:00.000Z')
const beat = (regions: string[], ageMs: number) =>
  JSON.stringify({ ts: NOW - ageMs, regions, release_id: 'a'.repeat(64) })

function setup(roster: Record<string, string>) {
  const redis = { hgetall: jest.fn(async () => roster) } as unknown as IORedis
  const send = jest.fn(async () => undefined)
  return { redis, send }
}

describe('alertUncoveredRegions', () => {
  it('pages the region whose only node stopped heart-beating', async () => {
    const { redis, send } = setup({
      mac: beat(['local'], 30 * 60_000),
      sg: beat(['vps_sg'], 30_000),
    })
    await expect(alertUncoveredRegions(redis, NOW, send)).resolves.toEqual(['local'])
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(
      redis,
      expect.objectContaining({ sourceSlug: 'framework:region-uncovered:local', tier: 'A' })
    )
  })

  it('stays quiet while every required region has a fresh owner', async () => {
    const { redis, send } = setup({
      mac: beat(['local'], 30_000),
      sg: beat(['vps_sg'], 30_000),
    })
    await expect(alertUncoveredRegions(redis, NOW, send)).resolves.toEqual([])
    expect(send).not.toHaveBeenCalled()
  })

  it('does not count the scoring process as region coverage', async () => {
    const { redis, send } = setup({
      mac: beat(['local'], 30_000),
      scoring: beat(['scoring'], 30_000),
    })
    await expect(alertUncoveredRegions(redis, NOW, send)).resolves.toEqual(['vps_sg'])
  })
})

describe('alertScoringSilence', () => {
  const H = 3600_000
  function scoringSetup(roster: Record<string, string>, marks: Record<string, string>) {
    const redis = {
      hgetall: jest.fn(async (key: string) =>
        key === 'arena:worker:progress:scoring'
          ? marks
          : key === 'arena:worker:progress:started'
            ? { scoring: String(NOW - 48 * H) }
            : roster
      ),
    } as unknown as IORedis
    const send = jest.fn(async () => undefined)
    return { redis, send }
  }

  it('pages when no scoring process has a fresh heartbeat', async () => {
    const { redis, send } = scoringSetup(
      { mac: beat(['local'], 30_000), scoring: beat(['scoring'], 30 * 60_000) },
      {}
    )
    await expect(alertScoringSilence(redis, NOW, send)).resolves.toEqual({
      down: true,
      stalled: [],
    })
    expect(send).toHaveBeenCalledWith(
      redis,
      expect.objectContaining({ sourceSlug: 'framework:scoring-down', tier: 'A', phase: 0 })
    )
  })

  it('pages a live scoring process that has not published for over 6 hours', async () => {
    const { redis, send } = scoringSetup(
      { scoring: beat(['scoring'], 30_000) },
      { scoring: String(NOW - 7 * H) }
    )
    await expect(alertScoringSilence(redis, NOW, send)).resolves.toEqual({
      down: false,
      stalled: ['scoring'],
    })
    expect(send).toHaveBeenCalledWith(
      redis,
      expect.objectContaining({
        sourceSlug: 'framework:scoring-stalled:scoring',
        message: expect.stringContaining('420min'),
      })
    )
  })

  it('stays quiet while scoring is alive and publishing', async () => {
    const { redis, send } = scoringSetup(
      { scoring: beat(['scoring'], 30_000) },
      { scoring: String(NOW - 2 * H) }
    )
    await expect(alertScoringSilence(redis, NOW, send)).resolves.toEqual({
      down: false,
      stalled: [],
    })
    expect(send).not.toHaveBeenCalled()
  })
})
