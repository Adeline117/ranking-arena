import type { User } from '@supabase/supabase-js'
import type { NextRequest } from 'next/server'
import { getAuthUser } from '@/lib/supabase/server'
import { ApiError, ErrorCode } from './errors'

/**
 * Resolve an optional viewer without ever downgrading supplied credentials to
 * anonymous. Callers with no Authorization header remain anonymous; callers
 * that supplied a malformed, expired, suspended, or otherwise invalid bearer
 * receive a canonical 401 so the client can refresh or end its session.
 */
export async function getOptionalAuthUser(request: NextRequest): Promise<User | null> {
  const authorization = request.headers.get('authorization')
  if (authorization === null || authorization === undefined) return null

  const user = await getAuthUser(request)
  if (!user) {
    throw new ApiError('Invalid authentication token', {
      code: ErrorCode.INVALID_TOKEN,
    })
  }
  return user
}
