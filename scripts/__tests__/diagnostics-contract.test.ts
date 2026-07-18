import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

describe('public diagnostics contract', () => {
  const diagnose = source('scripts/diagnose.mjs')
  const status = source('scripts/check_status.mjs')
  const packageJson = JSON.parse(source('package.json')) as {
    scripts: Record<string, string>
  }

  it('routes freshness and platform checks to an existing current diagnostic', () => {
    expect(diagnose).not.toContain('check-freshness.mjs')
    expect(diagnose).toContain("'check_status.mjs'), '--freshness'")
    expect(diagnose).toContain("'check_status.mjs'), '--platforms'")
    expect(packageJson.scripts['check:status']).toBe('node scripts/diagnose.mjs --status')
  })

  it('checks the user-visible serving contracts instead of retired snapshot tables', () => {
    expect(status).toContain("fetchJson(baseUrl, '/api/health')")
    expect(status).toContain("fetchJson(baseUrl, '/api/sources/visible?timeRange=90D')")
    expect(status).toContain("fetchJson(baseUrl, '/api/rankings?window=90d&limit=1')")
    expect(status).not.toContain("from('trader_snapshots')")
    expect(status).not.toContain('SUPABASE_SERVICE_ROLE_KEY')
  })

  it('does not advertise a deleted outlier cleaner', () => {
    expect(packageJson.scripts['clean:outliers']).toBeUndefined()
  })
})
