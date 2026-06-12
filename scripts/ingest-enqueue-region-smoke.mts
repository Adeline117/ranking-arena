/**
 * Enqueue ONE Tier-A job onto a region queue — smoke test for a
 * region-resident worker node (e.g. the SG VPS consuming arena-ingest-vps_sg).
 *
 * Usage: npx tsx scripts/ingest-enqueue-region-smoke.mts <sourceSlug> [region]
 *   e.g. npx tsx scripts/ingest-enqueue-region-smoke.mts binance_spot vps_sg
 *
 * Runs on the Mac (only talks to Redis); the job executes wherever the
 * region queue's worker lives. Watch `pm2 logs arena-ingest-worker-sg`
 * on the VPS and arena.leaderboard_snapshots for the result.
 */
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { config } from 'dotenv'

const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, '..', 'worker', '.env') })

const [slug = 'binance_spot', region = 'vps_sg'] = process.argv.slice(2)

const { getRegionQueue, INGEST_JOB } = await import('../worker/src/ingest/queues')

const queue = getRegionQueue(region)
const job = await queue.add(
  INGEST_JOB.TIER_A,
  { sourceSlug: slug },
  { attempts: 1 } // smoke: fail fast, no retries
)
console.log(`[smoke] enqueued ${job.name} id=${job.id} queue=${queue.name} source=${slug}`)
const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed')
console.log('[smoke] queue counts:', counts)
await queue.close()
process.exit(0)
