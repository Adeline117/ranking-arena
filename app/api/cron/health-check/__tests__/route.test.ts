/** @jest-environment node */

const mockHealthGet = jest.fn()
const mockHealthHead = jest.fn()

jest.mock('@/app/api/health/route', () => ({
  GET: () => mockHealthGet(),
  HEAD: () => mockHealthHead(),
}))

import { GET, HEAD } from '../route'

describe('/api/cron/health-check', () => {
  it('is no longer a constant ok: it forwards the public health verdict', async () => {
    mockHealthGet.mockResolvedValueOnce(
      Response.json({ status: 'degraded', stale: true }, { status: 503 })
    )
    const response = await GET()
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ status: 'degraded', stale: true })
  })

  it('forwards healthy as 200', async () => {
    mockHealthGet.mockResolvedValueOnce(Response.json({ status: 'healthy' }, { status: 200 }))
    expect((await GET()).status).toBe(200)
  })

  it('HEAD mirrors the public HEAD verdict', async () => {
    mockHealthHead.mockResolvedValueOnce(new Response(null, { status: 503 }))
    expect((await HEAD()).status).toBe(503)
  })
})
