import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(process.cwd(), 'app/api/traders/[handle]/core/route.ts'), 'utf8')

describe('/api/traders/[handle]/core raw-history quarantine wiring', () => {
  it('does not read the warm RPC, resolve a profile, or enqueue/map Tier-C data', () => {
    expect(route).not.toContain('resolveServingTrader')
    expect(route).not.toContain('getCoreModules')
    expect(route).not.toContain('requestTierC')
    expect(route).not.toContain('coreModulesFromTierC')
    expect(route).toContain('quarantinedPublicCoreModules(tf)')
    expect(route).toContain('METRIC_AUTHORITY_NO_STORE_HEADERS')
    expect(route).toContain("export const dynamic = 'force-dynamic'")
    expect(route).toContain('export const revalidate = 0')
  })
})
