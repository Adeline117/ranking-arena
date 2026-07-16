const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/

function pathPart(value: string): string {
  const queryIndex = value.indexOf('?')
  const hashIndex = value.indexOf('#')
  const end = Math.min(
    queryIndex === -1 ? value.length : queryIndex,
    hashIndex === -1 ? value.length : hashIndex
  )
  return value.slice(0, end)
}

function hasSafeInternalShape(value: string): boolean {
  const path = pathPart(value)
  return (
    path.startsWith('/') &&
    !path.startsWith('//') &&
    !path.startsWith('/\\') &&
    !path.includes('\\') &&
    !CONTROL_CHARACTERS.test(value)
  )
}

/**
 * Return the original internal path only when every encoded path layer remains
 * internal. Browsers treat backslashes as slashes in special URLs, and routing
 * layers may decode `%2f`/`%5c` more than once, so a simple `startsWith('/')`
 * check is not an open-redirect boundary.
 */
export function safeInternalReturnPath(
  candidate: string | null | undefined,
  baseOrigin = typeof window === 'undefined' ? 'https://arena.invalid' : window.location.origin
): string | null {
  if (!candidate || !hasSafeInternalShape(candidate)) return null

  let decodedPath = pathPart(candidate)
  for (let depth = 0; depth < 8; depth += 1) {
    if (!hasSafeInternalShape(decodedPath)) return null
    let nextPath: string
    try {
      nextPath = decodeURIComponent(decodedPath)
    } catch {
      return null
    }
    if (nextPath === decodedPath) break
    if (depth === 7) return null
    decodedPath = nextPath
  }

  try {
    const base = new URL(baseOrigin)
    const resolved = new URL(candidate, base)
    if (
      resolved.origin !== base.origin ||
      resolved.username !== '' ||
      resolved.password !== '' ||
      !resolved.pathname.startsWith('/')
    ) {
      return null
    }
  } catch {
    return null
  }

  return candidate
}
