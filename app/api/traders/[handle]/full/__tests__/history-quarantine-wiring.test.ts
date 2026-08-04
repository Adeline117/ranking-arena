import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('full trader cache boundary', () => {
  it('sanitizes the value returned by getOrSetWithLock before serialization', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/api/traders/[handle]/full/route.ts'),
      'utf8'
    )

    expect(source).toContain('const data = quarantineLegacyFullPositions(')
    expect(source.indexOf('await getOrSetWithLock(')).toBeLessThan(
      source.indexOf("if (!data) {\n      throw ApiError.notFound('Trader not found')")
    )
  })
})
