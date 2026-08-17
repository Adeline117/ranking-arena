/**
 * /api/admin/users/[id]/role — RETIRED
 *
 * The legacy endpoint checked the target, changed its privilege, and wrote an
 * audit row in separate statements. A concurrent role change could therefore
 * bypass the checked state or leave a privilege change without its audit
 * record. There is no in-repository caller, so keep an authenticated tombstone
 * until an atomic role authority is deliberately introduced.
 */

import { NextResponse } from 'next/server'
import { withAdminAuth } from '@/lib/api/with-admin-auth'

export const dynamic = 'force-dynamic'

export const PUT = withAdminAuth(
  async () =>
    NextResponse.json(
      {
        success: false,
        error: 'Administrator role changes are disabled until an atomic authority is available.',
        code: 'ADMIN_USER_ROLE_ENDPOINT_RETIRED',
      },
      {
        status: 410,
        headers: {
          'Cache-Control': 'private, no-store',
          Deprecation: 'true',
        },
      }
    ),
  { name: 'admin-user-role-retired' }
)
