/** @jest-environment node */

const mockDelByPattern = jest.fn()
const mockUser = { id: '11111111-1111-4111-8111-111111111111' }

function updateQuery(result: { error: unknown }) {
  const builder: Record<string, unknown> = {}
  for (const method of ['update', 'eq', 'in']) builder[method] = jest.fn(() => builder)
  builder.then = (resolve: (value: unknown) => void) => resolve(result)
  return builder
}
const mockFrom = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (handler: Function) =>
    (request: Request): Promise<Response> =>
      handler({ user: mockUser, supabase: { from: mockFrom }, request }),
}))
jest.mock('@/lib/cache', () => ({
  delByPattern: (...args: unknown[]) => mockDelByPattern(...args),
}))

import { POST } from '../route'

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/notifications/mark-read', {
      method: 'POST',
      body: JSON.stringify(body),
    }) as Parameters<typeof POST>[0]
  )

describe('POST /api/notifications/mark-read', () => {
  beforeEach(() => jest.clearAllMocks())

  it.each([[{ mark_all: true }], [{ notification_ids: ['n1', 'n2'] }]])(
    'drops the cached notification list after %j',
    async (body) => {
      mockFrom.mockReturnValue(updateQuery({ error: null }))

      const response = await post(body)

      expect(response.status).toBe(200)
      expect(mockDelByPattern).toHaveBeenCalledWith(`notifications:${mockUser.id}:*`)
    }
  )

  it('does not invalidate when the update fails', async () => {
    mockFrom.mockReturnValue(updateQuery({ error: { message: 'db down' } }))

    const response = await post({ mark_all: true })

    expect(response.status).toBe(500)
    expect(mockDelByPattern).not.toHaveBeenCalled()
  })
})
