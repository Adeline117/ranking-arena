import type { NextRequest } from 'next/server'

const PRODUCTION_SIWE_ORIGINS: Readonly<Record<string, string>> = {
  'www.arenafi.org': 'https://www.arenafi.org',
  'arenafi.org': 'https://arenafi.org',
}

export interface SiweRequestOrigin {
  domain: string
  origin: string
}

/** Resolve only a known-good Host/Origin tuple for SIWE message verification. */
export function resolveSiweRequestOrigin(request: NextRequest): SiweRequestOrigin | null {
  const headerOrigin = request.headers.get('origin')
  const headerHost = request.headers.get('host')
  if (!headerOrigin || !headerHost) return null

  let originUrl: URL
  try {
    originUrl = new URL(headerOrigin)
  } catch {
    return null
  }
  if (originUrl.origin !== headerOrigin || originUrl.host !== headerHost) return null

  const productionOrigin = PRODUCTION_SIWE_ORIGINS[headerHost]
  if (productionOrigin === headerOrigin) {
    return { domain: headerHost, origin: productionOrigin }
  }

  if (
    process.env.NODE_ENV !== 'production' &&
    (originUrl.hostname === 'localhost' || originUrl.hostname === '127.0.0.1') &&
    (originUrl.protocol === 'http:' || originUrl.protocol === 'https:')
  ) {
    return { domain: headerHost, origin: headerOrigin }
  }

  return null
}
