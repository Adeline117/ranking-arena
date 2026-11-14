import type IORedis from 'ioredis'
import { alertUncoveredRegions } from '../region-coverage'

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
