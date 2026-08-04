import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import en from '@/lib/i18n/en'
import ja from '@/lib/i18n/ja'
import ko from '@/lib/i18n/ko'
import zh from '@/lib/i18n/zh'
import {
  TOKEN_RANKING_CONTAINMENT_BODY,
  TOKEN_RANKING_CONTAINMENT_HEADERS,
  TOKEN_RANKING_NOT_PUBLISHED_CODE,
} from '@/lib/rankings/token-ranking-containment'

const root = process.cwd()

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

describe('token-ranking containment contract', () => {
  it('keeps the fixed response immutable and private across browser and CDN caches', () => {
    expect(Object.isFrozen(TOKEN_RANKING_CONTAINMENT_BODY)).toBe(true)
    expect(Object.isFrozen(TOKEN_RANKING_CONTAINMENT_HEADERS)).toBe(true)
    expect(TOKEN_RANKING_CONTAINMENT_BODY.code).toBe(TOKEN_RANKING_NOT_PUBLISHED_CODE)
    expect(TOKEN_RANKING_CONTAINMENT_HEADERS).toEqual({
      'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
      'CDN-Cache-Control': 'no-store',
      'Vercel-CDN-Cache-Control': 'no-store',
      'Retry-After': '3600',
    })
  })

  it.each([
    ['en', en],
    ['zh', zh],
    ['ja', ja],
    ['ko', ko],
  ])('ships complete %s containment copy', (_language, dictionary) => {
    for (const key of [
      'tokenRankingsContainmentLabel',
      'tokenRankingsContainmentTitle',
      'tokenRankingsContainmentDescription',
      'tokenRankingsContainmentBack',
    ]) {
      expect(dictionary[key as keyof typeof dictionary]).toEqual(expect.any(String))
      expect(dictionary[key as keyof typeof dictionary].length).toBeGreaterThan(0)
    }
  })

  it('keeps token ranking pages disconnected from clients and data readers', () => {
    const pageSources = [
      source('app/(app)/rankings/tokens/page.tsx'),
      source('app/(app)/rankings/tokens/[token]/page.tsx'),
      source('app/(app)/rankings/tokens/TokenRankingContainment.tsx'),
    ].join('\n')

    expect(pageSources).not.toMatch(
      /getSupabaseAdmin|tieredGetOrSet|checkRateLimit|unstable_cache|TokensIndexClient|TokenRankingClient|\bfetch\s*\(/
    )
    expect(pageSources.match(/index:\s*false/g)).toHaveLength(2)
  })

  it('removes token rankings from navigation and both sitemap implementations', () => {
    expect(source('app/(app)/rankings/RankingsSubNav.tsx')).not.toContain(
      "{ href: '/rankings/tokens'"
    )
    expect(source('app/sitemap.ts')).not.toContain('/rankings/tokens')
    expect(source('app/api/sitemap-xml/route.ts')).not.toContain('/rankings/tokens')
  })
})
