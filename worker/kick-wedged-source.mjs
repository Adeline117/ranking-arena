/**
 * Repair a WEDGED tier-A scheduler (orphaned iterations piling up → source
 * never crawls; see memory serving-pitfalls #10). Usage:
 *   node kick-wedged-source.mjs <slug>                 # local queue
 *   QUEUE=arena-ingest-vps_sg node kick-wedged-source.mjs okx_spot
 * Tears down the scheduler, sweeps all orphaned repeat:<key>:* iterations,
 * rebuilds at the SAME cadence, and enqueues a non-repeat priority-1 kick so
 * the source crawls NOW. Skips a key with an ACTIVE (in-flight) iteration.
 * Cross-check DB freshness first — '>1 pending iteration' alone is benign on a
 * fresh source; only act when age_h > 2× cadence.
 */
import { config } from 'dotenv'
import { Queue } from 'bullmq'
import IORedis from 'ioredis'

config({ path: new URL('./.env', import.meta.url) })

const conn = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  tls: process.env.REDIS_URL.startsWith('rediss://') ? {} : undefined,
})
const q = new Queue(process.env.QUEUE || 'arena-ingest', { connection: conn })

const SLUG = process.argv[2] || 'bitget_spot'
const KEY = `tiera:${SLUG}`

// 1. scheduler state
const scheds = await q.getJobSchedulers(0, 1000)
const mine = scheds.find((s) => s.key === KEY)
console.log('=== scheduler', KEY, '===')
if (mine) {
  console.log(
    JSON.stringify(
      {
        key: mine.key,
        every: mine.every,
        next: mine.next,
        nextISO: mine.next ? new Date(mine.next).toISOString() : null,
        overdueMin: mine.next ? Math.round((Date.now() - mine.next) / 60000) : null,
      },
      null,
      2
    )
  )
} else {
  console.log('NO SCHEDULER FOUND')
}

// 2. Tear down the scheduler (clears its tracked iteration), then sweep any
//    ORPHANED repeat:tiera:bitget_spot:* iterations left by repeated rebuilds.
const active = (await q.getJobs(['active'], 0, 100)).filter(
  (j) => j?.data?.sourceSlug === SLUG && j?.name === 'tiera:leaderboard'
)
if (active.length) {
  console.log(`\n${active.length} ACTIVE bitget_spot crawl in flight — NOT touching, exiting`)
  await q.close()
  await conn.quit()
  process.exit(0)
}

await q.removeJobScheduler(KEY)
console.log(`\nremoved scheduler ${KEY}`)

let removed = 0
for (const st of ['prioritized', 'waiting', 'delayed', 'failed']) {
  const jobs = await q.getJobs([st], 0, 500)
  const mineJobs = jobs.filter(
    (j) => j?.data?.sourceSlug === SLUG && j?.name === 'tiera:leaderboard'
  )
  for (const j of mineJobs) {
    const ok = await j
      .remove()
      .then(() => true)
      .catch((e) => {
        console.log(`    ${j.id} remove failed: ${e.message}`)
        return false
      })
    if (ok) {
      console.log(`  removed orphaned ${st} ${j.id}`)
      removed++
    }
  }
}
console.log(`removed ${removed} orphaned iteration(s)`)

// 3. re-create the scheduler at the current DB cadence (5min; worker reconcile
//    will converge it). Then enqueue a NON-repeat priority-1 kick to crawl NOW.
const preserveEvery = mine?.every ?? 300000
await q.upsertJobScheduler(
  KEY,
  { every: preserveEvery },
  { name: 'tiera:leaderboard', data: { sourceSlug: SLUG }, opts: { priority: 1 } }
)
console.log(`re-created scheduler ${KEY} (every=${preserveEvery}ms)`)

const kick = await q.add(
  'tiera:leaderboard',
  { sourceSlug: SLUG },
  {
    priority: 1,
    jobId: `manualkick-${SLUG}-${Date.now()}`,
    removeOnComplete: true,
    removeOnFail: { age: 3600 },
  }
)
console.log(`✓ enqueued manual kick job ${kick.id}`)

await q.close()
await conn.quit()
