import {
  isAuthSessionMissingError,
  type Session,
  type SupabaseClient,
  type User,
} from '@supabase/supabase-js'

type ClientAuth = Pick<SupabaseClient['auth'], 'getSession' | 'getUser'>

export type ClientAuthBootstrapResult =
  | {
      status: 'authenticated'
      user: User
      session: Session | null
    }
  | {
      status: 'signed-out'
    }
  | {
      status: 'error'
      error: unknown
    }

/**
 * Resolve browser auth without collapsing transient Supabase failures into a
 * signed-out state. Reading the local session first also avoids racing session
 * restoration on a fresh page load.
 */
export async function bootstrapClientAuth(auth: ClientAuth): Promise<ClientAuthBootstrapResult> {
  let sessionResponse: Awaited<ReturnType<ClientAuth['getSession']>>
  try {
    sessionResponse = await auth.getSession()
  } catch (error) {
    return { status: 'error', error }
  }

  if (sessionResponse.error) {
    return { status: 'error', error: sessionResponse.error }
  }

  const session = sessionResponse.data.session

  let userResponse: Awaited<ReturnType<ClientAuth['getUser']>>
  try {
    userResponse = await auth.getUser()
  } catch (error) {
    if (!session && isAuthSessionMissingError(error)) {
      return { status: 'signed-out' }
    }
    return { status: 'error', error }
  }

  if (userResponse.error) {
    if (!session && isAuthSessionMissingError(userResponse.error)) {
      return { status: 'signed-out' }
    }
    return { status: 'error', error: userResponse.error }
  }

  const user = userResponse.data.user ?? session?.user ?? null
  if (!user) {
    return { status: 'signed-out' }
  }

  if (session?.user?.id && session.user.id !== user.id) {
    return {
      status: 'error',
      error: new Error('Supabase session and user identities do not match'),
    }
  }

  return { status: 'authenticated', user, session }
}
