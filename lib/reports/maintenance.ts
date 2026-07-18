import { NextResponse } from 'next/server'

export const REPORT_MAINTENANCE_RETRY_AFTER_SECONDS = 60

export const REPORT_MAINTENANCE_BODY = {
  success: false,
  error: 'Reporting is temporarily unavailable. Please retry shortly.',
  code: 'REPORT_MAINTENANCE',
  retryable: true,
} as const

export function reportMaintenanceResponse(): NextResponse {
  return NextResponse.json(REPORT_MAINTENANCE_BODY, {
    status: 503,
    headers: {
      'Cache-Control': 'private, no-store',
      'Retry-After': String(REPORT_MAINTENANCE_RETRY_AFTER_SECONDS),
    },
  })
}
