import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const trackedFiles = execFileSync('git', ['ls-files', '-z'], {
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean)

const runtimeCredentialFiles = new Set([
  'infra/vps-playwright/ecosystem.config.js',
  'infra/vps-playwright/ecosystem-jp.config.js',
  'scripts/archive/test-vps-scrapers.ts',
  'scripts/cron/auto-fix-platform.ts',
  'scripts/import/import_all_platforms.mjs',
  'scripts/vps-deploy/arena-proxy.mjs',
  'scripts/vps-deploy/cron-runner.js',
  'scripts/vps-deploy/proxy-key-auth.cjs',
  'scripts/vps-deploy/scraper-cron.mjs',
  'scripts/vps-deploy/scraper-v16-parallel.js',
])

describe('repository proxy credential policy', () => {
  it('does not contain the leaked proxy credential family', () => {
    const violations = trackedFiles.filter((file) => {
      const source = readFileSync(file, 'utf8')
      return /\barena-proxy-(?:sg|jp)-20\d{2}\b/i.test(source)
    })

    expect(violations).toEqual([])
  })

  it('requires proxy credentials from the runtime environment', () => {
    const violations: string[] = []

    for (const file of runtimeCredentialFiles) {
      const source = readFileSync(file, 'utf8')
      const hasLiteralFallback =
        /process\.env\.(?:VPS_)?PROXY_KEY(?:_CURRENT|_NEXT)?\s*(?:\|\||\?\?)\s*['"`][^'"`]+/m.test(
          source
        )
      const hasLiteralAssignment =
        /(?:PROXY_KEY(?:_CURRENT|_NEXT)?|SCRAPER_KEY|VPS_KEY|API_KEY)\s*[:=]\s*['"`][^'"`]{8,}/m.test(
          source
        )

      if (hasLiteralFallback || hasLiteralAssignment) violations.push(file)
    }

    expect(violations).toEqual([])
  })
})
