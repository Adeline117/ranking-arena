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

    // Scope the delete to the owner so a user can never remove someone else's key.
    const { data, error } = await supabase
      .from('user_passkeys')
      .delete()
      .eq('id', parsed.data.id)
      .eq('user_id', user.id)
      .select('id')

    if (error) {
      logger.error('[credentials DELETE] Failed to remove passkey:', error)
      return serverError('Failed to remove passkey')
    }

    if (!data || data.length === 0) {
      return NextResponse.json({ error: 'Passkey not found' }, { status: 404 })
    }

    return NextResponse.json({ removed: true })
  },
  {
    name: 'webauthn-credentials-delete',
    rateLimit: 'sensitive',
    skipCsrf: true,
  }
)
