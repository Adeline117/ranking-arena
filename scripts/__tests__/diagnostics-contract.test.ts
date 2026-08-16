import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

describe('public diagnostics contract', () => {
  const diagnose = source('scripts/diagnose.mjs')
  const status = source('scripts/check_status.mjs')
  const seasons = source('scripts/check_seasons.mjs')
  const enrichment = source('scripts/check_enrichment.mjs')
  const scriptsReadme = source('scripts/README.md')
  const readme = source('README.md')
  const runbook = source('docs/RUNBOOK.md')
  const onboarding = source('docs/ONBOARDING.md')
  const scraperGuide = source('docs/SCRAPER.md')
  const claudeGuide = source('CLAUDE.md')
  const productionAllowlist = JSON.parse(source('scripts/PRODUCTION_ALLOWLIST.json')) as {
    allowed: string[]
  }
  const packageJson = JSON.parse(source('package.json')) as {
    scripts: Record<string, string>
  }

  it('routes freshness and platform checks to an existing current diagnostic', () => {
    expect(diagnose).not.toContain('check-freshness.mjs')
    expect(diagnose).toContain("'check_status.mjs'), '--freshness'")
    expect(diagnose).toContain("'check_status.mjs'), '--platforms'")
    expect(packageJson.scripts['check:status']).toBe('node scripts/diagnose.mjs --status')
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
    expect(status).toContain("fetchJson(baseUrl, '/api/health')")
    expect(status).toContain("fetchJson(baseUrl, '/api/sources/visible?timeRange=90D')")
    expect(status).toContain("fetchJson(baseUrl, '/api/rankings?window=90d&limit=1')")
    expect(status).not.toContain("from('trader_snapshots')")
    expect(status).not.toContain('SUPABASE_SERVICE_ROLE_KEY')
  })

  it('keeps credentialed inventories on current relations and fails closed', () => {
    expect(diagnose).toContain("seasons: [resolve(__dirname, 'check_seasons.mjs')]")
    expect(diagnose).toContain("enrichment: [resolve(__dirname, 'check_enrichment.mjs')]")

    expect(seasons).toContain("from('leaderboard_ranks')")
    expect(seasons).toContain("select('source, season_id, rank, computed_at')")
    expect(seasons).not.toContain("from('trader_snapshots')")
    expect(seasons).toContain('process.exitCode = 1')

    expect(enrichment).toContain("from('trader_stats_detail')")
    expect(enrichment).toContain("from('trader_equity_curve')")
    expect(enrichment).toContain("from('trader_asset_breakdown')")
    expect(enrichment).toContain('avg_holding_time_hours')
    expect(enrichment).not.toContain("from('trader_snapshots')")
    expect(enrichment).not.toContain("avg_holding_time')")
    expect(enrichment).toContain('queryError(')
    expect(enrichment).toContain('process.exitCode = 1')
    expect(scriptsReadme).toContain('non-authoritative enrichment inventory')
    expect(scriptsReadme).toContain('it exits nonzero rather than claiming success')
  })

  it('does not direct operators to the retired automatic health/fix script', () => {
    for (const document of [readme, runbook, onboarding]) {
      expect(document).not.toContain('node scripts/pipeline-health-check.mjs')
      expect(document).toContain('npm run check:freshness')
    }
    expect(runbook).not.toContain('UPDATE pipeline_logs')
  })

  it('keeps source guidance read-only and branches changes for review', () => {
    expect(scraperGuide).toContain('npm run check:freshness')
    expect(scraperGuide).not.toContain('ssh root@')
    expect(scraperGuide).not.toContain('pm2 restart')
    expect(scraperGuide).not.toContain('Authorization: Bearer $CRON_SECRET')
    expect(scraperGuide).not.toContain('curl http://')
    expect(claudeGuide).toContain('不得直接提交或推送 `main`')
    expect(claudeGuide).not.toContain('git push origin main')
    expect(claudeGuide).not.toContain('scripts/post-deploy-check.sh')
    expect(readme).not.toContain('45.76.152.169')
    expect(readme).toContain('Observation only; no auto-fix or release authority during V1 NO-GO')
    expect(onboarding).not.toContain('wait for Vercel deploy')
    expect(runbook).not.toContain('Authorization: Bearer $CRON_SECRET')
    expect(runbook).not.toContain('ingest-enqueue-region-smoke.mts')
    expect(runbook).not.toContain('compute-leaderboard?season=90D')
  })

  it('does not advertise a deleted outlier cleaner', () => {
    expect(packageJson.scripts['clean:outliers']).toBeUndefined()
  })
})
