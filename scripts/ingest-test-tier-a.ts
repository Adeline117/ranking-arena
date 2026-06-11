/**
 * One-off Phase-0 milestone driver: run the Tier-A processor for one source
 * without the queue. Usage:
 *   npx tsx scripts/ingest-test-tier-a.ts bitget_cfd
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config({ path: resolve(process.cwd(), 'worker', '.env') })
config({ path: resolve(process.cwd(), '.env.local') })

async function main() {
  const slug = process.argv[2] ?? 'bitget_cfd'
  await import('@/lib/ingest/adapters/register')
  const { processTierA } = await import('@/worker/src/ingest/processors/tier-a-leaderboard')
  const fakeJob = { name: 'tiera:leaderboard', data: { sourceSlug: slug } }
  const results = await processTierA(fakeJob as never)
  console.log(JSON.stringify(results, null, 2))
  const { closeIngestPool } = await import('@/lib/ingest/db')
  await closeIngestPool()
  process.exit(0)
}
main().catch((err) => {
  console.error('FAILED:', err)
  process.exit(1)
})
