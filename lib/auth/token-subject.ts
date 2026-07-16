/** Return the bearer token from an Authorization header, if it is well formed. */
export function bearerToken(authorization: string | null): string | null {
  if (!authorization) return null
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  return match?.[1]?.trim() || null
}

/**
 * Decode only the JWT subject claim. A null result means the credential is
 * opaque (or malformed), so its principal cannot safely be inferred.
 */
export function jwtSubject(accessToken: string | null): string | null {
  if (!accessToken) return null
  try {
    const payload = accessToken.split('.')[1]
    if (!payload) return null
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const decoded = JSON.parse(atob(padded)) as { sub?: unknown }
    return typeof decoded.sub === 'string' && decoded.sub ? decoded.sub : null
  } catch {
    return null
  }
}
