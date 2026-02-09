import { NextRequest, NextResponse } from 'next/server'
import { verifyAttestation } from '@/lib/web3/eas'
import { ARENA_SCORE_SCHEMA_UID } from '@/lib/web3/contracts'
import type { Hex } from 'viem'
import logger from '@/lib/logger'

/**
 * GET /api/attestation/[uid]
 *
 * Verify an Arena Score attestation by its UID.
 * Returns attestation details and validity status.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ uid: string }> }
) {
  const { uid } = await params

  if (!uid || !uid.startsWith('0x')) {
    return NextResponse.json({ error: 'Invalid attestation UID' }, { status: 400 })
  }

  if (!ARENA_SCORE_SCHEMA_UID) {
    return NextResponse.json({
      error: 'EAS not configured',
      message: 'Arena Score attestation schema has not been registered yet.',
    }, { status: 503 })
  }

  try {
    const { valid, attestation, reason } = await verifyAttestation(uid as Hex)

    return NextResponse.json({
      valid,
      reason,
      attestation: attestation ? {
        uid: attestation.uid,
        schema: attestation.schema,
        time: attestation.time,
        expirationTime: attestation.expirationTime,
        recipient: attestation.recipient,
        attester: attestation.attester,
      } : null,
    })
  } catch (err) {
    logger.error('[Attestation verify] Error:', err)
    return NextResponse.json({ error: 'Verification failed' }, { status: 500 })
  }
}
