/**
 * Tier-A driver for one source, without the queue.
 *
 * Usage:
 *   npx tsx scripts/ingest-test-tier-a.ts <slug>            # production run
 *   npx tsx scripts/ingest-test-tier-a.ts <slug> --smoke    # validation run
 *
 * --smoke automates the footgun that bit three adapters in a row: a
 * validation crawl (max_pages knob / temp expected_count) publishes
 * snapshots whose counts would poison the rolling-median baseline; the SOP
 * "UPDATE count_check_passed=false afterwards" lived in agent prompts and
 * human memory. With --smoke the snapshots created by THIS run are evicted
 * from the baseline pool automatically on exit (data stays for inspection).
 */
import { resolve } from 'path'
import { config } from 'dotenv'
import type { TierJobData } from '@/worker/src/ingest/queues'
config({ path: resolve(process.cwd(), 'worker', '.env') })
config({ path: resolve(process.cwd(), '.env.local') })

async function main() {
  const args = process.argv.slice(2)
  const smoke = args.includes('--smoke')
  const slug = args.find((a) => !a.startsWith('--')) ?? 'bitget_cfd'

  await import('@/lib/ingest/adapters/register')
  const { processTierA } = await import('@/worker/src/ingest/processors/tier-a-leaderboard')
  const { getIngestPool, closeIngestPool } = await import('@/lib/ingest/db')

  const startedAt = new Date().toISOString()
  let results: unknown
  try {
    const fakeJob = {
      name: 'tiera:leaderboard',
      data: { sourceSlug: slug } as TierJobData,
      async updateData(nextData: TierJobData) {
        this.data = nextData
      },
    }
    results = await processTierA(fakeJob as never)
    console.log(JSON.stringify(results, null, 2))
  } finally {
    if (smoke) {
      const { rowCount } = await getIngestPool().query(
        `UPDATE arena.leaderboard_snapshots ls
            SET count_check_passed = false,
                meta = ls.meta || '{"smoke": true}'::jsonb
          WHERE ls.source_id = (SELECT id FROM arena.sources WHERE slug = $1)
            AND ls.scraped_at >= $2::timestamptz
            AND ls.count_check_passed`,
        [slug, startedAt]
      )
      console.log(
        `[smoke] evicted ${rowCount ?? 0} snapshot(s) from the rolling baseline ` +
          `(rows kept for inspection)`
      )
    }
    await closeIngestPool()
  }
  process.exit(0)
}
main().catch((err) => {
  console.error('FAILED:', err)
  process.exit(1)
})
