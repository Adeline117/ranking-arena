/**
 * @jest-environment node
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mockVerifyAdminAuth = jest.fn()

jest.mock('@/lib/auth/verify-service-auth', () => ({
  verifyAdminAuth: (...args: unknown[]) => mockVerifyAdminAuth(...args),
}))

import { GET } from '../route'

function request(query = ''): Request {
  return new Request(`https://www.arenafi.org/api/monitoring/freshness${query}`, {
    headers: { authorization: 'Bearer admin-or-cron-credential' },
  })
}

describe('deprecated GET /api/monitoring/freshness', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('does not expose the successor endpoint before admin authentication', async () => {
    mockVerifyAdminAuth.mockResolvedValue(false)

    const response = await GET(request())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'unauthorized' })
    expect(mockVerifyAdminAuth).toHaveBeenCalledWith(expect.any(Request))
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('cache-control')).toBe('private, no-store')
  })

  it('retires the incompatible contract explicitly for authorized callers', async () => {
    mockVerifyAdminAuth.mockResolvedValue(true)

    const response = await GET(request('?format=html&threshold=999'))

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toEqual({
      error: 'The legacy freshness endpoint has been retired.',
      code: 'MONITORING_FRESHNESS_ENDPOINT_RETIRED',
      successor: '/api/admin/data-freshness',
    })
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('deprecation')).toBe('true')
    expect(response.headers.get('link')).toBe(
      '</api/admin/data-freshness>; rel="successor-version"'
    )
  })

  it('contains no deleted snapshot authority or second freshness calculation', () => {
    const route = readFileSync(join(process.cwd(), 'app/api/monitoring/freshness/route.ts'), 'utf8')
    const skill = readFileSync(
      join(process.cwd(), '.claude/skills/arena-enrichment-patterns/SKILL.md'),
      'utf8'
    )

    expect(route).not.toContain('get_monitoring_freshness_summary')
    expect(route).not.toMatch(/\.rpc\s*\(/)
    expect(route).not.toContain('getSupabaseAdmin')
    expect(route).not.toContain('PLATFORM_THRESHOLDS')
    expect(route).not.toContain('fieldCoverage')
    expect(skill).not.toContain('/api/monitoring/freshness')
    expect(skill).toContain('/api/admin/data-freshness')
  })
})
