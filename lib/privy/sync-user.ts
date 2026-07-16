/**
 * Privy identities cannot be trusted as Supabase identities until a server
 * verifies the Privy token and exchanges it through an explicit identity
 * bridge. The current client has only a public Privy app id and no Supabase
 * session, so profile synchronization must remain disabled.
 */

interface PrivyUserInfo {
  privyId: string
  email?: string | null
  walletAddress?: string | null
}

type PrivySyncResult = { handle: string | null; isNew: boolean }

const PRIVY_BRIDGE_UNAVAILABLE = 'verified Privy-to-Supabase bridge unavailable'

/**
 * Fail closed until a verified server-side Privy-to-Supabase bridge exists.
 * The retained result type keeps the current caller contract stable; this
 * implementation never resolves and therefore cannot report a fake isNew.
 */
export async function syncPrivyUserToSupabase(info: PrivyUserInfo): Promise<PrivySyncResult> {
  void info
  throw new Error(PRIVY_BRIDGE_UNAVAILABLE)
}
