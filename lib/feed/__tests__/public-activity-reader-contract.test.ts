import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

describe('public activity reader contract', () => {
  it('keeps every public activity reader behind the explicit receipt-gated policy', () => {
    const allowlistedReaders = [
      'app/api/feed/route.ts',
      'app/api/feed/activities/route.ts',
      'app/(app)/feed/page.tsx',
    ]
    for (const path of allowlistedReaders) {
      const contents = source(path)
      expect(contents).toContain('PUBLIC_NON_RANKING_ACTIVITY_TYPES')
      expect(contents).toContain('filterPublicNonRankingActivities')
      expect(contents).toContain('hasPublicNonRankingActivityTypes')
    }

    for (const path of ['app/api/feed/activities/[id]/route.ts', 'app/(app)/feed/[id]/page.tsx']) {
      const contents = source(path)
      expect(contents).toContain('isPublicNonRankingActivity')
      expect(contents).toContain('hasPublicNonRankingActivityTypes')
    }

    expect(source('app/components/feed/ActivityFeed.tsx')).toContain(
      'filterPublicNonRankingActivities'
    )
    expect(source('lib/feed/public-activity-policy.ts')).toContain(
      'PUBLIC_NON_RANKING_ACTIVITY_TYPES: readonly KnownNonRankingActivityType[] ='
    )
    expect(source('lib/types/activities.ts')).not.toContain("| 'large_trade'")
    expect(source('app/components/feed/ActivityFeed.tsx')).not.toContain('large_trade')
  })

  it('removes raw leaderboard activity generation and disables public/ISR caches', () => {
    const generator = source('app/api/cron/generate-activities/route.ts')
    expect(generator).not.toContain(".from('leaderboard_ranks')")
    expect(generator).not.toContain('.upsert(')
    expect(generator).toContain('RANKING_ACTIVITY_EVIDENCE_UNAVAILABLE')

    for (const path of [
      'app/api/feed/route.ts',
      'app/api/feed/activities/route.ts',
      'app/api/feed/activities/[id]/route.ts',
      'app/(app)/feed/page.tsx',
      'app/(app)/feed/[id]/page.tsx',
    ]) {
      const contents = source(path)
      expect(contents).toContain("export const dynamic = 'force-dynamic'")
      expect(contents).toContain('export const revalidate = 0')
    }

    for (const path of [
      'app/api/feed/route.ts',
      'app/api/feed/activities/route.ts',
      'app/api/feed/activities/[id]/route.ts',
    ]) {
      expect(source(path)).toContain('noStorePublicActivity')
    }
  })
})
