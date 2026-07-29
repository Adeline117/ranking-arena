import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(__dirname, '..', 'route.ts'), 'utf8')

describe('detailed health database probe', () => {
  it('selects a real leaderboard_ranks column through the generated client type', () => {
    expect(route).toContain('const supabase = getSupabaseAdmin()')
    expect(route).toContain("from('leaderboard_ranks').select('id').limit(1)")
    expect(route).not.toContain("from('leaderboard_ranks').select('count')")
  })
})
