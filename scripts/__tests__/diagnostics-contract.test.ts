import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

describe('public diagnostics contract', () => {
  const diagnose = source('scripts/diagnose.mjs')
  const scriptsReadme = source('scripts/README.md')
  const productionAllowlist = JSON.parse(source('scripts/PRODUCTION_ALLOWLIST.json')) as {
    allowed: string[]
  }
  const packageJson = JSON.parse(source('package.json')) as {
    scripts: Record<string, string>
  }

  it('keeps status, freshness, and platform checks in one canonical diagnostic', () => {
    expect(diagnose).not.toContain('check-freshness.mjs')
    expect(diagnose).not.toContain('check_status.mjs')
    expect(existsSync(join(process.cwd(), 'scripts/check_status.mjs'))).toBe(false)
    expect(diagnose).toContain("['status', 'freshness', 'platforms']")
    expect(packageJson.scripts['check:status']).toBe('node scripts/diagnose.mjs --status')
    expect(productionAllowlist.allowed).toEqual(['diagnose.mjs', 'pipeline-health-check.mjs'])
  })

  it('does not expose the retired table-count diagnostic', () => {
    expect(existsSync(join(process.cwd(), 'scripts/check_tables.mjs'))).toBe(false)
    expect(diagnose).not.toContain('check_tables.mjs')
    expect(diagnose).not.toContain('--tables')
    expect(packageJson.scripts['check:tables']).toBeUndefined()
    expect(productionAllowlist.allowed).not.toContain('check_tables.mjs')
    expect(scriptsReadme).not.toContain('check_tables')
    expect(scriptsReadme).not.toContain('check:tables')
    expect(scriptsReadme).not.toContain('--tables')
  })

  it('checks the user-visible serving contracts instead of retired snapshot tables', () => {
    expect(diagnose).toContain("fetchJson(baseUrl, '/api/health')")
    expect(diagnose).toContain("fetchJson(baseUrl, '/api/sources/visible?timeRange=90D')")
    expect(diagnose).toContain("fetchJson(baseUrl, '/api/rankings?window=90d&limit=1')")
    expect(diagnose).not.toContain("from('trader_snapshots')")
    expect(diagnose).not.toContain('SUPABASE_SERVICE_ROLE_KEY')
  })

  it('does not advertise a deleted outlier cleaner', () => {
    expect(packageJson.scripts['clean:outliers']).toBeUndefined()
  })
})
