import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { computeHotTraders } from '../hot-score'

describe('quarantined hot score', () => {
  it('never emits recommendations from unproven daily history', async () => {
    await expect(computeHotTraders()).resolves.toEqual([])
    await expect(computeHotTraders(1)).resolves.toEqual([])
  })

  it('has no database or legacy daily read path', () => {
    const source = readFileSync(join(process.cwd(), 'lib/recommendations/hot-score.ts'), 'utf8')
    expect(source).not.toContain('getSupabaseAdmin')
    expect(source).not.toContain('trader_daily_snapshots')
    expect(source).not.toContain('leaderboard_ranks')
  })
})
