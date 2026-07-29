import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(__dirname, '..', 'route.ts'), 'utf8')

describe('detailed health database probe', () => {
  it('selects a real leaderboard_ranks column through the generated client type', () => {
    expect(route).toContain('const supabase = getSupabaseAdmin()')
    expect(route).toContain("from('leaderboard_ranks').select('id').limit(1)")
    expect(route).not.toContain("from('leaderboard_ranks').select('count')")
  })

  it('derives source health from the sealed registry freshness authority', () => {
    expect(route).toContain("from '@/lib/rankings/build-freshness-report'")
    expect(route.match(/buildFreshnessReport\(\)/g)).toHaveLength(2)
    expect(route).toContain('for (const platform of freshness.platforms)')
    expect(route).toContain('summary: { total: freshness.summary.total, healthy, stale, critical }')
    expect(route).toContain("status: critical > 0 || stale > 0 ? 'degraded' : 'healthy'")
    expect(route).toContain("if (checks.cron.status !== 'pass')")
    expect(route).not.toContain("from('cron_logs')")
    expect(route).not.toContain('const ACTIVE_PLATFORMS =')
  })
})
