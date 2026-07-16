const LOCAL_EXCHANGE_LOGO = /^(\/icons\/exchanges\/)([^/?#]+)\.(?:png|jpe?g|svg|webp)([?#].*)?$/i

const LEGACY_BASENAME_ALIASES: Record<string, string> = {
  gateio: 'gate',
}

/**
 * Canonicalize exchange-logo paths that were persisted before the public
 * assets were consolidated to PNG. External avatars and unrelated local
 * assets are returned unchanged.
 */
export function canonicalizeLocalExchangeLogoPath(url: string): string {
  const match = url.match(LOCAL_EXCHANGE_LOGO)
  if (!match) return url

  const [, prefix, basename, suffix = ''] = match
  const canonicalBasename = LEGACY_BASENAME_ALIASES[basename.toLowerCase()] ?? basename
  return `${prefix}${canonicalBasename}.png${suffix}`
}
