import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(process.cwd(), 'app/api/v3/route.ts'), 'utf8')

describe('public API v3 private response cache contract', () => {
  it('never shares authenticated or quota-bearing responses through a CDN cache', () => {
    expect(route).toContain("const PRIVATE_API_CACHE_CONTROL = 'private, no-store, max-age=0'")
    expect(route).not.toContain('s-maxage')
    expect(route).not.toMatch(/['"]Cache-Control['"]\s*:\s*['"]public/)
  })

  it('applies the private policy to JSON, errors, quota responses, and CSV', () => {
    expect(route).toContain("res.headers.set('Cache-Control', PRIVATE_API_CACHE_CONTROL)")
    expect(route.match(/'Cache-Control': PRIVATE_API_CACHE_CONTROL/g)).toHaveLength(3)
  })
})
