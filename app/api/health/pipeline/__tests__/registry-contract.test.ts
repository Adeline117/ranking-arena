import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(process.cwd(), 'app/api/health/pipeline/route.ts'), 'utf8')

describe('pipeline health registry contract', () => {
  it('does not rebuild active membership from historical TypeScript lists', () => {
    expect(route).not.toMatch(/import[\s\S]{0,160}\bSOURCES_WITH_DATA\b/)
    expect(route).toContain("rpc('get_platform_freshness')")
    expect(route).toContain('freshnessRows: lbLatestRes.data || []')
  })

  it('fails closed when the registry RPC or outer health computation is blind', () => {
    expect(route).toContain('lbLatestRes.error || !lbLatestRes.data?.length')
    expect(route).toContain('active platform freshness authority is unavailable')
    expect(route).toContain('withDeadline<PlatformHealth[] | null>')
    expect(route).toContain('if (platformHealth === null)')
    expect(route).toContain('clearTimeout(timeout)')
  })

  it('invalidates legacy cache entries and classifies platform failures in the body', () => {
    expect(route).toContain("const CACHE_KEY = 'api:health:pipeline:v6'")
    expect(route).toContain('const platformStatus = classifyPlatformHealth(platformHealth)')
    expect(route).toContain("platformStatus === 'critical'")
    expect(route).toContain("platformStatus === 'degraded'")
  })
})
