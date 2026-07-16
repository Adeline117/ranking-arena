/**
 * Reclaims expired or abandoned private report evidence.
 *
 * The database only leases registry rows (FOR UPDATE SKIP LOCKED). Storage
 * objects are deleted exclusively through the Storage API, then acknowledged
 * in the registry. Failed removals release the lease for an immediate retry;
 * failed acknowledgements are retried after the bounded lease expires.
 */

import type { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { withCron } from '@/lib/api/with-cron'
import { parseReportEvidenceRef, REPORT_EVIDENCE_BUCKET } from '@/lib/reports/evidence'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const CleanupItemSchema = z
  .object({
    evidence_ref: z.string(),
    reporter_id: z.string().uuid(),
    object_name: z.string(),
    lease_token: z.string().uuid(),
    lease_expires_at: z.string().datetime({ offset: true }),
  })
  .strict()
const CleanupBatchSchema = z.array(CleanupItemSchema).max(50)

export const GET = withCron(
  'cleanup-report-evidence',
  async (_request: NextRequest, { supabase }) => {
    // Generated database types intentionally lag this deploy-ordered migration.
    const serviceClient: SupabaseClient = supabase
    const leased = await serviceClient.rpc('lease_stale_report_evidence_cleanup', {
      p_limit: 50,
    })
    if (leased.error) throw leased.error

    const batch = CleanupBatchSchema.safeParse(leased.data)
    if (!batch.success) throw new Error('Invalid report evidence cleanup lease batch')

    let deleted = 0
    let failed = 0
    for (const item of batch.data) {
      const parsed = parseReportEvidenceRef(item.evidence_ref, item.reporter_id)
      if (!parsed || parsed.objectName !== item.object_name) {
        failed++
        continue
      }

      let removeError: unknown = null
      try {
        const removal = await serviceClient.storage
          .from(REPORT_EVIDENCE_BUCKET)
          .remove([item.object_name])
        removeError = removal.error
      } catch (error) {
        removeError = error
      }

      if (removeError) {
        failed++
        await serviceClient.rpc('release_report_evidence_cleanup', {
          p_reporter_id: item.reporter_id,
          p_evidence_ref: item.evidence_ref,
          p_lease_token: item.lease_token,
        })
        continue
      }

      const ack = await serviceClient.rpc('ack_report_evidence_cleanup', {
        p_reporter_id: item.reporter_id,
        p_evidence_ref: item.evidence_ref,
        p_lease_token: item.lease_token,
      })
      if (ack.error || ack.data !== true) {
        // Leave the bounded lease in place. The stale-leasing RPC will pick it
        // up again after lease_expires_at and Storage removal is idempotent.
        failed++
        continue
      }
      deleted++
    }

    return { count: deleted, leased: batch.data.length, failed }
  },
  { safetyTimeoutMs: 55_000 }
)
