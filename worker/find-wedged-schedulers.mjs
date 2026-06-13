/**
 * One-time repair: find tier-A schedulers on the local queue whose repeat
 * chain is WEDGED by orphaned iterations (>1 pending repeat:<key>:* job — a
 * healthy scheduler has exactly one). Root cause: repeated
 * removeJobScheduler+upsert churn (manual restarts / cadence flips) leaves the
 * prior iteration orphaned; they pile up in prioritized/waiting and the
 * scheduler never advances. Fix per wedged key: tear down scheduler → remove
 * all orphaned iterations → rebuild → enqueue a non-repeat priority-1 kick.
 *
 * DRY_RUN=1 to only report. Never touches a key with an ACTIVE iteration.
 */
import { config } from 'dotenv'
import { Queue } from 'bullmq'
import IORedis from 'ioredis'

config({ path: new URL('./.env', import.meta.url) })
const DRY = process.env.DRY_RUN === '1'

const conn = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  tls: process.env.REDIS_URL.startsWith('rediss://') ? {} : undefined,
})
const q = new Queue('arena-ingest', { connection: conn })

// Gather pending iteration jobs grouped by scheduler key (tier-A only).
const pendingByKey = new Map() // key -> [{id, state}]
for (const st of ['prioritized', 'waiting', 'delayed']) {
  for (const j of await q.getJobs([st], 0, 1000)) {
    const m = /^repeat:(tiera:[^:]+):\d+$/.exec(j?.id ?? '')
    if (!m) continue
    const arr = pendingByKey.get(m[1]) ?? []
    arr.push({ id: j.id, state: st, job: j })
    pendingByKey.set(m[1], arr)
  }
}
const activeKeys = new Set()
for (const j of await q.getJobs(['active'], 0, 200)) {
  const m = /^repeat:(tiera:[^:]+):\d+$/.exec(j?.id ?? '')
  if (m) activeKeys.add(m[1])
}

const scheds = await q.getJobSchedulers(0, 2000)
const schedEvery = new Map(scheds.map((s) => [s.key, s.every]))

const wedged = [...pendingByKey.entries()].filter(
  ([key, arr]) => arr.length > 1 && !activeKeys.has(key) && schedEvery.has(key)
)
console.log(`wedged tier-A schedulers (>1 pending iteration, not active): ${wedged.length}`)
for (const [key, arr] of wedged)
  console.log(`  ${key}: ${arr.length} pending [${arr.map((a) => a.state).join(',')}]`)

if (DRY) {
  console.log('\nDRY_RUN — no changes')
  await q.close()
  await conn.quit()
  process.exit(0)
}

for (const [key, arr] of wedged) {
  const slug = key.slice('tiera:'.length)
  const every = schedEvery.get(key) ?? 300000
  await q.removeJobScheduler(key)
  let removed = 0
  for (const { job } of arr) {
    const ok = await job
      .remove()
      .then(() => true)
      .catch(() => false)
    if (ok) removed++
  }
  await q.upsertJobScheduler(
    key,
    { every },
    { name: 'tiera:leaderboard', data: { sourceSlug: slug }, opts: { priority: 1 } }
  )
  await q.add(
    'tiera:leaderboard',
    { sourceSlug: slug },
    {
      priority: 1,
      jobId: `manualkick-${slug}-${Date.now()}`,
      removeOnComplete: true,
      removeOnFail: { age: 3600 },
    }
  )
  console.log(`✓ ${key}: removed ${removed} orphans, rebuilt, kicked`)
}

await q.close()
await conn.quit()
