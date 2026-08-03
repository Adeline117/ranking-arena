const mockRpc = jest.fn()
const mockAdmin = { rpc: mockRpc }

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => mockAdmin,
}))

import { assertUserStripeBillingSurfaceAccess } from './billing-surface-access'

const USER_ID = '11111111-1111-4111-8111-111111111111'

describe('user Stripe billing surface access', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('allows only the exact service-role acknowledgement', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'allowed' }, error: null })

    await expect(assertUserStripeBillingSurfaceAccess(USER_ID)).resolves.toBeUndefined()
    expect(mockRpc).toHaveBeenCalledWith('resolve_user_stripe_billing_surface_access_atomic', {
      p_user_id: USER_ID,
    })
  })

  it.each([
    ['blocked', { data: { status: 'blocked' }, error: null }],
    ['invalid', { data: { status: 'invalid' }, error: null }],
    ['database error', { data: null, error: { message: 'database unavailable' } }],
    ['malformed status', { data: { status: 'unknown' }, error: null }],
    ['additional key', { data: { status: 'allowed', reason: 'unexpected' }, error: null }],
    ['missing result error field', { data: { status: 'allowed' } }],
  ])('fails closed for %s', async (_label, result) => {
    mockRpc.mockResolvedValue(result)

    await expect(assertUserStripeBillingSurfaceAccess(USER_ID)).rejects.toThrow(
      /billing surface access/i
    )
  })

  it('fails closed when the RPC transport rejects', async () => {
    mockRpc.mockRejectedValue(new Error('connection reset'))

    await expect(assertUserStripeBillingSurfaceAccess(USER_ID)).rejects.toThrow('connection reset')
  })
})
