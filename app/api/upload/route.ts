/**
 * POST /api/upload — authenticated image upload.
 * DELETE /api/upload — best-effort removal of the caller's unclaimed report evidence.
 *
 * Strict deploy order for report evidence: 20260716112300, then
 * 20260716113800, then the 20260716114500 advisory-first lock migration, then
 * this application. Report uploads intentionally have no direct
 * registry-table fallback.
 */

import { randomBytes } from 'crypto'
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { badRequest, conflict, serverError } from '@/lib/api/response'
import { createLogger } from '@/lib/utils/logger'
import { sniffImageFile } from '@/lib/utils/image-magic-bytes'
import {
  parseReportEvidenceRef,
  REPORT_EVIDENCE_BUCKET,
  REPORT_EVIDENCE_SIGNED_URL_TTL_SECONDS,
} from '@/lib/reports/evidence'

const logger = createLogger('upload')

export const dynamic = 'force-dynamic'

const MAX_FILE_SIZE = 2 * 1024 * 1024
const ALLOWED_BUCKETS = ['reports', 'avatars', 'posts']
const NO_STORE = 'private, no-store'

const ReservationSchema = z
  .object({
    reserved: z.literal(true),
    evidence_ref: z.string(),
    object_name: z.string(),
    expires_at: z.string().datetime({ offset: true }),
  })
  .strict()

const FinalizationSchema = z
  .object({
    finalized: z.literal(true),
    evidence_ref: z.string(),
    status: z.literal('uploaded'),
    expires_at: z.string().datetime({ offset: true }),
  })
  .strict()

const CleanupLeaseSchema = z.discriminatedUnion('acquired', [
  z
    .object({
      acquired: z.literal(false),
      reason: z.enum(['NOT_FOUND', 'CLAIMED']),
    })
    .strict(),
  z
    .object({
      acquired: z.literal(true),
      evidence_ref: z.string(),
      object_name: z.string(),
      lease_token: z.string().uuid(),
      lease_expires_at: z.string().datetime({ offset: true }),
    })
    .strict(),
])

function noStore<T extends NextResponse>(response: T): T {
  response.headers.set('Cache-Control', NO_STORE)
  return response
}

function validHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

async function releaseCleanupLease(
  supabase: SupabaseClient,
  reporterId: string,
  evidenceRef: string,
  leaseToken: string
) {
  try {
    const { error } = await supabase.rpc('release_report_evidence_cleanup', {
      p_reporter_id: reporterId,
      p_evidence_ref: evidenceRef,
      p_lease_token: leaseToken,
    })
    if (error) logger.error('[upload] Failed to release evidence cleanup lease:', error)
  } catch (error) {
    logger.error('[upload] Failed to release evidence cleanup lease:', error)
  }
}

async function cleanupReportEvidence(
  supabase: SupabaseClient,
  reporterId: string,
  evidenceRef: string
): Promise<'deleted' | 'missing' | 'claimed' | 'failed'> {
  const parsedRef = parseReportEvidenceRef(evidenceRef, reporterId)
  if (!parsedRef) return 'failed'

  let leaseData: unknown
  try {
    const lease = await supabase.rpc('lease_report_evidence_cleanup', {
      p_reporter_id: reporterId,
      p_evidence_ref: evidenceRef,
    })
    if (lease.error) {
      logger.error('[upload] Failed to lease evidence cleanup:', lease.error)
      return 'failed'
    }
    leaseData = lease.data
  } catch (error) {
    logger.error('[upload] Failed to lease evidence cleanup:', error)
    return 'failed'
  }

  const lease = CleanupLeaseSchema.safeParse(leaseData)
  if (!lease.success) {
    logger.error('[upload] Invalid evidence cleanup lease result')
    return 'failed'
  }
  if (!lease.data.acquired) {
    return lease.data.reason === 'CLAIMED' ? 'claimed' : 'missing'
  }
  if (lease.data.evidence_ref !== evidenceRef || lease.data.object_name !== parsedRef.objectName) {
    logger.error('[upload] Evidence cleanup lease identity mismatch')
    await releaseCleanupLease(supabase, reporterId, evidenceRef, lease.data.lease_token)
    return 'failed'
  }

  let removeError: unknown = null
  try {
    const result = await supabase.storage
      .from(REPORT_EVIDENCE_BUCKET)
      .remove([lease.data.object_name])
    removeError = result.error
  } catch (error) {
    removeError = error
  }
  if (removeError) {
    logger.error('[upload] Failed to remove report evidence:', removeError)
    await releaseCleanupLease(supabase, reporterId, evidenceRef, lease.data.lease_token)
    return 'failed'
  }

  try {
    const ack = await supabase.rpc('ack_report_evidence_cleanup', {
      p_reporter_id: reporterId,
      p_evidence_ref: evidenceRef,
      p_lease_token: lease.data.lease_token,
    })
    if (ack.error || ack.data !== true) {
      logger.error('[upload] Failed to acknowledge evidence cleanup:', ack.error)
      return 'failed'
    }
  } catch (error) {
    logger.error('[upload] Failed to acknowledge evidence cleanup:', error)
    return 'failed'
  }

  return 'deleted'
}

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    const formData = await request.formData()
    const file = formData.get('file') as File | null
    const bucket = (formData.get('bucket') as string) || REPORT_EVIDENCE_BUCKET

    if (!ALLOWED_BUCKETS.includes(bucket)) {
      return noStore(badRequest(`Invalid bucket. Allowed: ${ALLOWED_BUCKETS.join(', ')}`))
    }
    if (!file) return noStore(badRequest('No file provided'))
    if (file.size > MAX_FILE_SIZE) return noStore(badRequest('File too large (max 2MB)'))

    const sniffed = await sniffImageFile(file, ['jpeg', 'png', 'gif', 'webp', 'avif'])
    if (!sniffed) {
      return noStore(badRequest('Invalid file type. Allowed: JPEG, PNG, WebP, GIF, AVIF'))
    }

    let fileName: string
    let evidenceRef: string | null = null
    if (bucket === REPORT_EVIDENCE_BUCKET) {
      let reservedResult: Awaited<ReturnType<typeof supabase.rpc>>
      try {
        reservedResult = await supabase.rpc('reserve_report_evidence_upload', {
          p_reporter_id: user.id,
          p_mime_type: sniffed.mime,
          p_extension: sniffed.extension,
        })
      } catch (error) {
        logger.error('[upload] Failed to reserve report evidence:', error)
        return noStore(serverError('Upload failed'))
      }
      const rawReservationRef =
        reservedResult.data &&
        typeof reservedResult.data === 'object' &&
        !Array.isArray(reservedResult.data) &&
        typeof (reservedResult.data as Record<string, unknown>).evidence_ref === 'string'
          ? ((reservedResult.data as Record<string, unknown>).evidence_ref as string)
          : null
      const reservation = ReservationSchema.safeParse(reservedResult.data)
      const parsedRef = reservation.success
        ? parseReportEvidenceRef(reservation.data.evidence_ref, user.id)
        : null
      if (
        reservedResult.error ||
        !reservation.success ||
        !parsedRef ||
        reservation.data.object_name !== parsedRef.objectName
      ) {
        if (rawReservationRef && parseReportEvidenceRef(rawReservationRef, user.id)) {
          await cleanupReportEvidence(supabase, user.id, rawReservationRef)
        }
        logger.error('[upload] Invalid report evidence reservation:', reservedResult.error)
        return noStore(serverError('Upload failed'))
      }
      evidenceRef = reservation.data.evidence_ref
      fileName = reservation.data.object_name
    } else {
      fileName = `${user.id}/${randomBytes(8).toString('hex')}.${sniffed.extension}`
    }

    let storageBucket: ReturnType<typeof supabase.storage.from>
    let buffer: Buffer
    try {
      storageBucket = supabase.storage.from(bucket)
      buffer = Buffer.from(await file.arrayBuffer())
    } catch (error) {
      if (evidenceRef) await cleanupReportEvidence(supabase, user.id, evidenceRef)
      logger.error('[upload] Failed to prepare upload:', error)
      return noStore(serverError('Upload failed'))
    }
    let uploadError: unknown = null
    try {
      const upload = await storageBucket.upload(fileName, buffer, {
        contentType: sniffed.mime,
        upsert: false,
        ...(bucket === REPORT_EVIDENCE_BUCKET ? { cacheControl: '0' } : {}),
      })
      uploadError = upload.error
    } catch (error) {
      uploadError = error
    }
    if (uploadError) {
      if (evidenceRef) await cleanupReportEvidence(supabase, user.id, evidenceRef)
      logger.error('[upload] Storage error:', uploadError)
      return noStore(serverError('Upload failed'))
    }

    if (bucket === REPORT_EVIDENCE_BUCKET && evidenceRef) {
      let signedUrl: unknown = null
      let signError: unknown = null
      try {
        const signed = await storageBucket.createSignedUrl(
          fileName,
          REPORT_EVIDENCE_SIGNED_URL_TTL_SECONDS
        )
        signedUrl = signed.data?.signedUrl
        signError = signed.error
      } catch (error) {
        signError = error
      }

      let finalizeError: unknown = null
      let finalized = false
      if (!signError && validHttpsUrl(signedUrl)) {
        try {
          const result = await supabase.rpc('finalize_report_evidence_upload', {
            p_reporter_id: user.id,
            p_evidence_ref: evidenceRef,
          })
          const parsed = FinalizationSchema.safeParse(result.data)
          finalized = !result.error && parsed.success && parsed.data.evidence_ref === evidenceRef
          finalizeError = result.error
        } catch (error) {
          finalizeError = error
        }
      }

      if (signError || !validHttpsUrl(signedUrl) || !finalized) {
        await cleanupReportEvidence(supabase, user.id, evidenceRef)
        logger.error('[upload] Failed to finish report evidence upload:', {
          signError,
          finalizeError,
        })
        return noStore(serverError('Upload failed'))
      }

      return NextResponse.json(
        { url: signedUrl, preview_url: signedUrl, evidence_ref: evidenceRef },
        { headers: { 'Cache-Control': NO_STORE } }
      )
    }

    const { data: publicUrl } = storageBucket.getPublicUrl(fileName)
    return noStore(NextResponse.json({ url: publicUrl.publicUrl }))
  },
  { name: 'upload', rateLimit: 'sensitive' }
)

export const DELETE = withAuth(
  async ({ user, supabase, request }) => {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return noStore(badRequest('Invalid JSON body'))
    }
    const input = z.object({ evidence_ref: z.string() }).strict().safeParse(body)
    if (!input.success || !parseReportEvidenceRef(input.data.evidence_ref, user.id)) {
      return noStore(badRequest('Invalid report evidence'))
    }

    const result = await cleanupReportEvidence(supabase, user.id, input.data.evidence_ref)
    if (result === 'claimed') {
      return noStore(conflict('Claimed report evidence cannot be deleted'))
    }
    if (result === 'failed') return noStore(serverError('Evidence cleanup failed'))

    return NextResponse.json(
      { success: true, deleted: result === 'deleted' },
      { headers: { 'Cache-Control': NO_STORE } }
    )
  },
  { name: 'upload-delete', rateLimit: 'sensitive' }
)
