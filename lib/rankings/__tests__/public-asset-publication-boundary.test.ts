import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')

function source(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8')
}

describe('public ranking asset publication boundary', () => {
  it.each([
    'app/api/badge/trader/[handle]/route.ts',
    'app/api/og/trader/route.tsx',
    'app/api/og/rank/route.tsx',
    'app/api/og/compare/route.tsx',
    'app/api/og/exchange/route.tsx',
    'app/api/share/rank-card/route.tsx',
  ])('%s rejects non-public sources and uses the URL-level response epoch', (route) => {
    const text = source(route)
    expect(text).toContain('isPublicRankingSourceAllowed')
    expect(text).toContain('redirectToPublicRankingResponseCacheEpoch')
    expect(text).toContain('publicRankingResponseCacheHeaders')
  })

  it.each([
    'app/api/badge/trader/[handle]/route.ts',
    'app/api/og/trader/route.tsx',
    'app/api/og/exchange/route.tsx',
    'app/api/share/rank-card/route.tsx',
  ])('%s gates the resolved database source before publishing ranking metrics', (route) => {
    const text = source(route)
    expect(text).toMatch(
      /if \(!isPublicRankingSourceAllowed\((?:srcName|exchange|tr\.source|resolved\.platform)\)\)/
    )
  })
})
