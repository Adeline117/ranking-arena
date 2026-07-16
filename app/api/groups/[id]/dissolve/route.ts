/**
 * POST /api/groups/[id]/dissolve
 *
 * Irreversibly dissolves a group through the canonical locked database RPC.
 * Historical content remains readable while new interaction is disabled.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { socialFeatureGuard } from '@/lib/features'
import logger from '@/lib/logger'

type RouteContext = { params: Promise<{ id: string }> }

const paramsSchema = z.object({ id: z.string().uuid() }).strict()
const dissolutionResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('invalid') }).strict(),
  z.object({ status: z.literal('actor_unavailable') }).strict(),
  z.object({ status: z.literal('not_found') }).strict(),
  z.object({ status: z.literal('forbidden') }).strict(),
  z
    .object({
      status: z.literal('already_dissolved'),
      dissolved_at: z.string().datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      status: z.literal('dissolved'),
      dissolved_at: z.string().datetime({ offset: true }),
      audit_log_id: z.string().uuid(),
    })
    .strict(),
])

export async function POST(request: NextRequest, context: RouteContext) {
  const handler = withAuth(
    async ({ user, supabase }) => {
      const guard = socialFeatureGuard()
      if (guard) return guard

      const params = paramsSchema.safeParse(await context.params)
      if (!params.success) {
        return NextResponse.json({ error: 'Invalid group id' }, { status: 400 })
      }

      const { data, error } = await supabase.rpc('dissolve_group_atomic', {
        p_actor_id: user.id,
        p_group_id: params.data.id,
      })
      if (error) {
        logger.error('[dissolve] Atomic group dissolution failed', {
          groupId: params.data.id,
          actorId: user.id,
          code: error.code,
        })
        return NextResponse.json({ error: 'Failed to dissolve group' }, { status: 500 })
      }

      const parsedResult = dissolutionResultSchema.safeParse(data)
      if (!parsedResult.success) {
        logger.error('[dissolve] Atomic group dissolution returned an invalid result', {
          groupId: params.data.id,
          actorId: user.id,
        })
        return NextResponse.json({ error: 'Failed to dissolve group' }, { status: 500 })
      }

      const result = parsedResult.data
      switch (result.status) {
        case 'invalid':
          return NextResponse.json({ error: 'Invalid dissolution request' }, { status: 400 })
        case 'actor_unavailable':
          return NextResponse.json({ error: 'Account is not active' }, { status: 403 })
        case 'not_found':
          return NextResponse.json({ error: 'Group not found' }, { status: 404 })
        case 'forbidden':
          return NextResponse.json(
            { error: 'Only the group owner can dissolve the group' },
            { status: 403 }
          )
        case 'already_dissolved':
          // Treat a retry after a lost acknowledgement as success.  The group
          // row is the one-way idempotency record and the RPC emits no new audit.
          return NextResponse.json({
            success: true,
            action: result.status,
            dissolved_at: result.dissolved_at,
          })
        case 'dissolved':
          logger.info('[dissolve] Group dissolved', {
            groupId: params.data.id,
            actorId: user.id,
            auditLogId: result.audit_log_id,
          })
          return NextResponse.json({
            success: true,
            action: result.status,
            dissolved_at: result.dissolved_at,
          })
      }
    },
    { name: 'group-dissolve', rateLimit: 'sensitive' }
  )

  return handler(request)
}
