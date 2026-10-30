import { NextResponse } from 'next/server'

export const LEGACY_PORTFOLIO_SUCCESSOR = '/api/trader/authorize'

const PRIVATE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  Pragma: 'no-cache',
} as const

export function withPrivateNoStore<T extends Response>(response: T): T {
  for (const [name, value] of Object.entries(PRIVATE_NO_STORE_HEADERS)) {
    response.headers.set(name, value)
  }
  return response
}

export function retiredPortfolioCapability(
  operation: 'connect' | 'sync' | 'positions' | 'snapshots'
) {
  return withPrivateNoStore(
    NextResponse.json(
      {
        success: false,
        error: `Legacy portfolio ${operation} is unavailable in Arena V1.`,
        successor: LEGACY_PORTFOLIO_SUCCESSOR,
      },
      {
        status: 410,
        headers: {
          Link: `<${LEGACY_PORTFOLIO_SUCCESSOR}>; rel="successor-version"`,
        },
      }
    )
  )
}

export function retiredPortfolioWrite(operation: 'connect' | 'sync') {
  return retiredPortfolioCapability(operation)
}
