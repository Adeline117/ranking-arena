type AuthIdentityLike = { provider?: unknown }

export interface AccountDeletionAuthContext {
  accessToken: string | null
  email: string | null
  identities?: AuthIdentityLike[] | null
  appMetadata?: Record<string, unknown> | null
}

export type AccountDeletionProof = 'password' | 'typed' | 'unavailable'

const PASSWORDLESS_PRIMARY_METHODS = new Set([
  'otp',
  'magiclink',
  'oauth',
  'sso/saml',
  'web3',
  'oauth_provider/authorization_code',
])

function decodeJwtPayload(accessToken: string): Record<string, unknown> | null {
  try {
    const segments = accessToken.split('.')
    if (segments.length !== 3 || !segments[1]) return null
    const normalized = segments[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const decoded: unknown = JSON.parse(atob(padded))
    return decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function authenticationMethods(accessToken: string | null): Set<string> | null {
  if (!accessToken) return null
  const payload = decodeJwtPayload(accessToken)
  if (!payload || !Array.isArray(payload.amr) || payload.amr.length === 0) return null

  const methods = new Set<string>()
  for (const entry of payload.amr) {
    const method =
      typeof entry === 'string'
        ? entry
        : entry !== null && typeof entry === 'object' && !Array.isArray(entry)
          ? (entry as Record<string, unknown>).method
          : null
    if (typeof method !== 'string' || !method) return null
    methods.add(method)
  }
  return methods
}

function identityProviders(context: AccountDeletionAuthContext): Set<string> {
  const providers = new Set<string>()
  for (const identity of context.identities ?? []) {
    if (typeof identity.provider === 'string' && identity.provider) {
      providers.add(identity.provider)
    }
  }

  const metadataProvider = context.appMetadata?.provider
  if (typeof metadataProvider === 'string' && metadataProvider) providers.add(metadataProvider)

  const metadataProviders = context.appMetadata?.providers
  if (Array.isArray(metadataProviders)) {
    for (const provider of metadataProviders) {
      if (typeof provider === 'string' && provider) providers.add(provider)
    }
  }
  return providers
}

/**
 * Select the deletion proof from the authentication method of the validated
 * session, not merely the identities linked to the account. Supabase's
 * `email` identity is shared by password and email-OTP users, so provider
 * metadata alone cannot tell whether a password exists.
 *
 * The caller must validate the JWT before trusting this result. A malformed or
 * unknown email session stays on the stronger password path, while completely
 * missing provider evidence is rejected by the server as unavailable.
 */
export function getAccountDeletionProof(context: AccountDeletionAuthContext): AccountDeletionProof {
  if ((context.email ?? '').endsWith('@wallet.arena')) return 'typed'

  const providers = identityProviders(context)
  if (providers.size === 0) return 'unavailable'

  const methods = authenticationMethods(context.accessToken)
  if (methods?.has('password')) return 'password'
  if (methods && [...methods].some((method) => PASSWORDLESS_PRIMARY_METHODS.has(method))) {
    return 'typed'
  }

  // Preserve the password proof for legacy tokens without AMR. Non-email
  // OAuth identities have no password credential and retain typed confirmation.
  return providers.has('email') ? 'password' : 'typed'
}
