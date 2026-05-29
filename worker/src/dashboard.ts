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

const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 4000)

export function startDashboard(): void {
  const serverAdapter = new ExpressAdapter()
  serverAdapter.setBasePath('/admin/jobs')

  createBullBoard({
    queues: [new BullMQAdapter(getQueue())],
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
