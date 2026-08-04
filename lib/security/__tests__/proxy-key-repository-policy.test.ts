import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'

const trackedFiles = execFileSync('git', ['ls-files', '-z'], {
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean)
  // A retirement change can delete tracked files before the commit that removes
  // them from the index. Missing working-tree paths cannot contain credentials.
  .filter((file) => existsSync(file))
  // Git submodules are tracked as gitlinks but materialize as directories.
  // Symlinks are excluded so this repository scan never follows paths outside
  // the checkout.
  .filter((file) => lstatSync(file).isFile())

const runtimeCredentialFiles = new Set([
  'infra/vps-playwright/ecosystem.config.js',
  'infra/vps-playwright/ecosystem-jp.config.js',
  'scripts/vps-deploy/arena-proxy.mjs',
  'scripts/vps-deploy/proxy-key-auth.cjs',
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
