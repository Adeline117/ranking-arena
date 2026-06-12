import { getRegionQueue, INGEST_REGIONS, getTierCQueue } from '../worker/src/ingest/queues'
async function main() {
  for (const region of INGEST_REGIONS) {
    const q = getRegionQueue(region)
    console.log(`[${region}]`, await q.getJobCounts('active', 'waiting', 'delayed', 'failed'))
  }
  console.log('[tierc]', await getTierCQueue().getJobCounts('active', 'waiting', 'delayed', 'failed'))
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
