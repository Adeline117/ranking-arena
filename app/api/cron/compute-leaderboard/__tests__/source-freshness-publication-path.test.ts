/**
 * @jest-environment node
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = process.env.LEADERBOARD_PUBLICATION_CONTRACT_ROOT ?? process.cwd()
const route = readFileSync(join(repoRoot, 'app/api/cron/compute-leaderboard/route.ts'), 'utf8')
const publisher = readFileSync(
  join(repoRoot, 'app/api/cron/compute-leaderboard/publish-atomic-rank-generation.ts'),
  'utf8'
)
const finalizerMigration = readFileSync(
  join(
    repoRoot,
    'supabase/migrations/20260729054600_atomic_leaderboard_rank_generation_publication.sql'
  ),
  'utf8'
)

function finalizerBody(): string {
  return (
    finalizerMigration.match(
      /CREATE OR REPLACE FUNCTION public\.finalize_leaderboard_rank_generation_v1\([\s\S]*?AS \$body\$([\s\S]*?)\$body\$;/
    )?.[1] ?? ''
  )
}

describe('compute leaderboard source freshness publication path', () => {
  it('activates only the staged generation publisher with an exact-output degradation gate', () => {
    const publish = route.indexOf('await publishAtomicRankGeneration({')
    const authorization = route.indexOf(
      'authorizePublication: async ({ publishedCount, publishedCountsBySource }) => {',
      publish
    )
    const guard = route.indexOf('await checkDegradationGuard({', authorization)
    const skip = route.indexOf('if (!publication) return -1', guard)

    expect(publish).toBeGreaterThan(-1)
    expect(authorization).toBeGreaterThan(publish)
    expect(guard).toBeGreaterThan(authorization)
    expect(skip).toBeGreaterThan(guard)
    expect(route).not.toContain('await upsertLeaderboard({')
    expect(route).not.toContain('await zeroOutExcluded({')
    expect(route).not.toContain('await rerankAllRows(')
    expect(route).not.toContain('await atomicPlatformCleanup(')
    expect(route).not.toContain('await upsertSourceFreshness({')
  })

  it('passes exact source watermarks and identities only to the atomic finalizer', () => {
    const finalizeCall = publisher.indexOf("'finalize_leaderboard_rank_generation_v1'")
    expect(finalizeCall).toBeGreaterThan(-1)
    const finalizeTail = publisher.slice(finalizeCall)
    expect(finalizeTail).toContain('p_source_publications: finalSourcePayload')
    expect(publisher).toContain('source_as_of: publication.source_as_of')
    expect(publisher).toContain('trader_ids: traderIds')
    expect(publisher).not.toContain('upsertSourceFreshness')
  })

  it('seals source proofs after cleanup and rerank inside the finalizer transaction', () => {
    const body = finalizerBody()
    const cleanup = body.indexOf('public.cleanup_leaderboard_rank_publication(')
    const rerank = body.indexOf('public.rerank_leaderboard_publication(')
    const seal = body.indexOf('public.seal_leaderboard_rank_publication(', rerank)
    const sealedHead = body.indexOf("SET phase = 'sealed'", seal)

    expect(body).not.toBe('')
    expect(cleanup).toBeGreaterThan(-1)
    expect(rerank).toBeGreaterThan(cleanup)
    expect(seal).toBeGreaterThan(rerank)
    expect(sealedHead).toBeGreaterThan(seal)
    expect(body).toContain('p_source_publications')
  })
})
