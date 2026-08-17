import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), 'utf8')

describe('public profile service-route audience boundary', () => {
  const ownedRoutes = [
    {
      path: 'app/api/users/[handle]/activities/route.ts',
      childRead: ".from('user_activities')",
    },
    {
      path: 'app/api/users/[handle]/collections/route.ts',
      childRead: ".from('user_collections')",
    },
    {
      path: 'app/api/users/[handle]/bookmark-folders/route.ts',
      childRead: ".from('bookmark_folders')",
    },
  ]

  it.each(ownedRoutes)('$path authorizes current account state before child reads', (entry) => {
    const source = read(entry.path)
    const audienceRead = source.indexOf('readPublicProfileAudienceByHandle(')
    const activeCheck = source.indexOf("audience.status !== 'active'")
    const childRead = source.indexOf(entry.childRead)

    expect(audienceRead).toBeGreaterThan(-1)
    expect(activeCheck).toBeGreaterThan(audienceRead)
    expect(childRead).toBeGreaterThan(activeCheck)
    expect(source).toContain("'Cache-Control': 'private, no-store, max-age=0'")
  })

  it('re-authorizes the aggregate route before its fresh public-cohort read', () => {
    const source = read('app/api/users/[handle]/full/route.ts')
    const audienceRead = source.indexOf('readPublicProfileAudienceByHandle(')
    const inactiveCheck = source.indexOf("audience.status === 'inactive'")
    const cohortRead = source.indexOf('fetchPublicProfileRankingRows(')

    expect(audienceRead).toBeGreaterThan(-1)
    expect(inactiveCheck).toBeGreaterThan(audienceRead)
    expect(cohortRead).toBeGreaterThan(inactiveCheck)
    expect(source).toContain('fetchPublicFullTraderIdentity(')
    expect(source).toContain('projectPublicFullProfileRanking(')
    expect(source).toContain('sanitizePublicFullSimilarTraders(')
    expect(source).not.toContain('getOrSetWithLock(')
    expect(source).not.toContain("from('leaderboard_ranks')")
    expect(source).not.toContain('getTraderPerformance(')
    expect(source).not.toContain('getTraderStats(')
    expect(source).not.toContain('getTraderByHandle(')
    expect(source).toContain("'Cache-Control': 'private, no-store, max-age=0'")
    expect(source).not.toContain('detail: profileError')
    expect(source).not.toMatch(/s-maxage|stale-while-revalidate/)
  })

  it('filters every authenticated search candidate through current public state', () => {
    const source = read('app/api/users/search/route.ts')
    const stateSelect = source.indexOf(
      "'id, handle, avatar_url, deleted_at, banned_at, is_banned, ban_expires_at'"
    )
    const currentFilter = source.indexOf('isPublicProfileActive(candidate, now)')

    expect(stateSelect).toBeGreaterThan(-1)
    expect(currentFilter).toBeGreaterThan(stateSelect)
    expect(source).toContain("'Cache-Control': 'private, no-store, max-age=0'")
  })
})
