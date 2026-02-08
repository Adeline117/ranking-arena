/**
 * API versioning utilities (stub)
 */

import { NextRequest, NextResponse } from 'next/server'

export type ApiVersion = 'v1' | 'v2'

export interface VersionContext {
  version: ApiVersion
  isDeprecated: boolean
  sunsetDate?: string
}

export function parseApiVersion(_request: NextRequest): VersionContext {
  return { version: 'v1', isDeprecated: false }
}

export function addVersionHeaders(response: NextResponse, context: VersionContext): void {
  response.headers.set('X-API-Version', context.version)
}

export function addDeprecationHeaders(response: NextResponse, context: VersionContext): void {
  if (context.isDeprecated) {
    response.headers.set('Deprecation', 'true')
    if (context.sunsetDate) {
      response.headers.set('Sunset', context.sunsetDate)
    }
  }
}
