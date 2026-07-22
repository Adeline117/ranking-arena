import fs from 'node:fs'
import path from 'node:path'

function processorSource(file: string): string {
  return fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
}

describe('ingest processor persistent-profile contract', () => {
  it('preserves Tier A on the existing unsuffixed warm-cookie profile', () => {
    const source = processorSource('tier-a-leaderboard.ts')
    const openSessionCalls = source.match(/openSession\([^)]*\)/g) ?? []
    expect(openSessionCalls.length).toBeGreaterThan(0)
    expect(new Set(openSessionCalls)).toEqual(new Set(['openSession(src)']))
  })

  it('assigns fixed, mutually distinct lanes to every other browser tier', () => {
    const tierB = processorSource('tier-b-profiles.ts')
    const tierBSeries = processorSource('tier-b-series.ts')
    const tierD = processorSource('tier-d-positions.ts')
    expect(tierB).toContain("profileLaneKey: 'tier-b'")
    expect(tierB).toContain("profileSuffix: 'tier-b'")
    expect(tierBSeries).toContain("profileLaneKey: 'tier-b-series'")
    expect(tierBSeries).toContain("profileSuffix: 'series'")
    expect(tierD).toContain("profileLaneKey: 'tier-d'")
    expect(tierD).toContain("profileSuffix: 'tier-d'")
  })

  it('routes both Tier-C paths through the same bounded two-slot lane', () => {
    const source = processorSource('tier-c-profile.ts')
    expect(source.match(/profileLaneKey: 'tier-c'/g)).toHaveLength(2)
    expect(source.match(/profileSuffix: 'tier-c'/g)).toHaveLength(2)
    expect(source.match(/profileSlotCount: 2/g)).toHaveLength(2)
  })
})
