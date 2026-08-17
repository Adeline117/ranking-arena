/**
 * /api/admin/moderate — RETIRED
 *
 * The legacy action multiplexer mixed direct table deletes with detached
 * audit writes. Content moderation now goes through the target-scoped atomic
 * moderation queue, while user sanctions use their dedicated atomic routes.
 * Keep this authenticated tombstone so old callers cannot revive either
 * mutation path.
 */

import { NextResponse } from 'next/server'
import { withAdminAuth } from '@/lib/api/with-admin-auth'

export const dynamic = 'force-dynamic'

const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }

export const POST = withAdminAuth(
  async () =>
    NextResponse.json(
      {
        success: false,
        error: 'The legacy administrator moderation endpoint has been retired.',
        code: 'ADMIN_MODERATE_ENDPOINT_RETIRED',
        replacements: {
          content: '/api/admin/moderation-queue',
          ban: '/api/admin/users/{id}/ban',
        },
      },
      {
        status: 410,
        headers: {
          ...NO_STORE_HEADERS,
          Deprecation: 'true',
          Link: '</api/admin/moderation-queue>; rel="successor-version", </api/admin/users/{id}/ban>; rel="alternate"',
        },
      }
    ),
  { name: 'admin-moderate-retired' }
)
