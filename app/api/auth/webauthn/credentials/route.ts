/**
 * WebAuthn Credentials management (authenticated, owner-only)
 * GET: list the current user's enrolled passkeys.
 * DELETE: remove one of the user's passkeys by id.
 */

import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { badRequest, serverError } from '@/lib/api/response'
import { NextResponse } from 'next/server'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('webauthn-credentials')

export const dynamic = 'force-dynamic'

interface PasskeyListRow {
  id: string
  device_name: string | null
  created_at: string
  last_used_at: string | null
  transports: string[] | null
}

export const GET = withAuth(
  async ({ user, supabase }) => {
    const { data, error } = await supabase
      .from('user_passkeys')
      .select('id, device_name, created_at, last_used_at, transports')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    if (error) {
      logger.error('[credentials GET] Failed to list passkeys:', error)
      return serverError('Failed to load passkeys')
    }

    const passkeys = ((data ?? []) as PasskeyListRow[]).map((row) => ({
      id: row.id,
      deviceName: row.device_name,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      transports: row.transports ?? [],
    }))

    return NextResponse.json({ passkeys })
  },
  {
    name: 'webauthn-credentials-list',
    rateLimit: 'authenticated',
    skipCsrf: true,
  }
)

const DeleteSchema = z.object({ id: z.string().uuid() })

export const DELETE = withAuth(
  async ({ user, supabase, request }) => {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return badRequest('Invalid JSON body')
    }

    const parsed = DeleteSchema.safeParse(body)
    if (!parsed.success) {
      return badRequest('Invalid passkey id')
    }

    // Delete under the account lifecycle lock and require an exact typed ACK.
    const { data, error } = await supabase.rpc(
      'delete_webauthn_credential_for_active_profile_atomic',
      {
        p_user_id: user.id,
        p_passkey_id: parsed.data.id,
      }
    )
    const deletion = Array.isArray(data) && data.length === 1 ? data[0] : null

    if (error || !deletion) {
      logger.error('[credentials DELETE] Atomic removal failed:', error)
      return serverError('Failed to remove passkey')
    }
    if (
      deletion.status === 'suspended' &&
      deletion.result_user_id === null &&
      deletion.result_passkey_id === null
    ) {
      return NextResponse.json({ error: 'Account unavailable' }, { status: 403 })
    }
    if (
      deletion.status === 'not_found' &&
      deletion.result_user_id === user.id &&
      deletion.result_passkey_id === parsed.data.id
    ) {
      return NextResponse.json({ error: 'Passkey not found' }, { status: 404 })
    }
    if (
      deletion.status !== 'deleted' ||
      deletion.result_user_id !== user.id ||
      deletion.result_passkey_id !== parsed.data.id
    ) {
      logger.error('[credentials DELETE] Atomic removal returned an invalid acknowledgement')
      return serverError('Failed to remove passkey')
    }

    return NextResponse.json({ removed: true })
  },
  {
    name: 'webauthn-credentials-delete',
    rateLimit: 'sensitive',
    skipCsrf: true,
  }
)
