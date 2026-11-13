/**
 * Bull Board Dashboard — visual monitoring for all pipeline jobs.
 *
 * Runs on http://localhost:4000/admin/jobs when worker starts.
 * Shows job status, duration, retry count, failed jobs, etc.
 */

import express from 'express'
import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter'
import { ExpressAdapter } from '@bull-board/express'
import { getQueue } from './queues'
import { isV1IngestExecutionPublished } from '@/lib/ingest/v1-execution-publication'
import { INGEST_REGIONS, getFastQueue, getRegionQueue, getTierCQueue } from './ingest/queues'

const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 4000)

export function startDashboard(): void {
  const serverAdapter = new ExpressAdapter()
  serverAdapter.setBasePath('/admin/jobs')

  createBullBoard({
    queues: [
      // Legacy pipeline queue.
      new BullMQAdapter(getQueue()),
      // Ingest queues use the ingest-gated Redis client. When only the ranking
      // chain is published they are not observable from this process.
      // New ingest pipeline: every region-affine bulk, fast-lane, and Tier-C
      // queue. Omitting the fast lane makes small user-facing boards invisible
      // exactly when that lane is enabled. Queue instances here are lightweight
      // Redis clients for observability only — consumers live in the separate
      // arena-ingest-worker PM2 app.
      ...(isV1IngestExecutionPublished()
        ? [
            ...INGEST_REGIONS.map((region) => new BullMQAdapter(getRegionQueue(region))),
            ...INGEST_REGIONS.map((region) => new BullMQAdapter(getFastQueue(region))),
            ...INGEST_REGIONS.map((region) => new BullMQAdapter(getTierCQueue(region))),
          ]
        : []),
    ],
    serverAdapter,
  })

  const app = express()
  app.use('/admin/jobs', serverAdapter.getRouter())

  // Health endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() })
  })

  app.listen(DASHBOARD_PORT, () => {
    console.log(`[dashboard] Bull Board running at http://localhost:${DASHBOARD_PORT}/admin/jobs`)
  })
}
