import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('full trader public-cohort boundary', () => {
  it('sanitizes a live detail response and disables shared payload caching', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/api/traders/[handle]/full/route.ts'),
      'utf8'
    )

    expect(source).toContain('const data = quarantineLegacyFullPositions(')
    expect(source).toContain('await fetchTraderFull(handle)')
    expect(source).not.toContain('getOrSetWithLock')
    expect(source).toContain("'Cache-Control': 'private, no-store, max-age=0'")
  })
})
