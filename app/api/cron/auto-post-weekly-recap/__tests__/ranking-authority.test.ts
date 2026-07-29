import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(
  join(process.cwd(), 'app/api/cron/auto-post-weekly-recap/route.ts'),
  'utf8'
)

describe('weekly recap ranking authority', () => {
  it('materializes the public post from one sealed public generation', () => {
    expect(route).toContain('readSealedRankingAuthorityGeneration(')
    expect(route).toContain('const authoritySources = publication.proofs.map')
    expect(route).toContain(".in('source', authoritySources)")
    expect(route).toContain(".filter('rank_publication_id', 'eq', publication.scoreCohortId)")
  })

  it('fails closed on rank, source-boundary, or deduplication read errors', () => {
    expect(route).toContain('if (existingError)')
    expect(route).toContain('weekly recap deduplication query failed:')
    expect(route).toContain('if (error || data === null)')
    expect(route).toContain('!isPublicRankingSourceAllowed(row.source)')
    expect(route).toContain(
      "throw new Error('weekly ranking query crossed the public source boundary')"
    )
  })

  it('uses a deterministic total order before selecting a finite candidate set', () => {
    expect(route).toContain(".order('roi', { ascending: false })")
    expect(route).toContain(".order('source', { ascending: true })")
    expect(route).toContain(".order('source_trader_id', { ascending: true })")
    expect(route).toContain('.limit(40)')
  })

  it('bounds every database phase inside an explicit serverless budget', () => {
    expect(route).toContain('export const maxDuration = 60')
    expect(route).toContain('const workSignal = AbortSignal.timeout(45_000)')
    expect(route.match(/\.abortSignal\(workSignal\)/g)).toHaveLength(3)
    expect(route).toContain('{ safetyTimeoutMs: 55_000 }')
  })
})
