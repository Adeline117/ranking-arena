import type { User } from '@supabase/supabase-js'
import { getUserAccountStatus } from '@/lib/supabase/server'

export async function hasActiveTwoFactorProfile(
  user: Pick<User, 'id' | 'email'>
): Promise<boolean> {
  return (
    (await getUserAccountStatus(user.id, {
      verifiedEmail: user.email ?? null,
    })) === 'active'
  )
}
