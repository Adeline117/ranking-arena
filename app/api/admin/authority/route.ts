import { withAdminAuth } from '@/lib/api/with-admin-auth'
import { success } from '@/lib/api/response'

export const dynamic = 'force-dynamic'

// This is the client admin shell's sole authority probe. Reusing
// withAdminAuth keeps production ADMIN_EMAILS and active-profile semantics
// identical to every mutation the shell can invoke.
export const GET = withAdminAuth(
  async ({ admin }) =>
    success(
      {
        admin: {
          email: admin.email,
          id: admin.id,
        },
      },
      200,
      {
        'Cache-Control': 'private, no-store',
        Vary: 'Authorization',
      }
    ),
  { name: 'admin-authority' }
)
