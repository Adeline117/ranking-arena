/**
 * Legacy uptime-monitor URL (callable, not cron-scheduled, public, no auth).
 *
 * It used to return a constant `200 {status:'ok'}` with no dependency check,
 * so any monitor pointed here was permanently green — including through the
 * 2026-08 → 11 public data freeze (audit P2-6). It now returns exactly the
 * public /api/health verdict and body (DB, Redis, source freshness and 90D
 * publication proof): 200 healthy, 202 Redis-only degraded, 503 stale data
 * or database down. The body never contains internal errors or secrets.
 */

import { GET as publicHealthGet, HEAD as publicHealthHead } from '@/app/api/health/route'

export const dynamic = 'force-dynamic'
export const maxDuration = 15

export async function GET() {
  return publicHealthGet()
}

export async function HEAD() {
  return publicHealthHead()
}
