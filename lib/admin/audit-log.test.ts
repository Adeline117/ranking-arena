const mockError = jest.fn()
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: (...a: unknown[]) => mockError(...a) }),
}))

import type { SupabaseClient } from '@supabase/supabase-js'
import { recordAdminLog } from './audit-log'

function client(result: unknown) {
  const insert = jest
    .fn()
    .mockImplementation(() =>
      result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
    )
  return { client: { from: jest.fn(() => ({ insert })) } as unknown as SupabaseClient, insert }
}

describe('recordAdminLog', () => {
  beforeEach(() => mockError.mockReset())

  it('returns true on success', async () => {
    const { client: c, insert } = client({ error: null })
    await expect(recordAdminLog(c, { admin_id: 'a', action: 'ban_user' })).resolves.toBe(true)
    expect(insert).toHaveBeenCalledWith({ admin_id: 'a', action: 'ban_user' })
    expect(mockError).not.toHaveBeenCalled()
  })

  it('logs and returns false on a DB error (does not throw)', async () => {
    const { client: c } = client({ error: { message: 'rls' } })
    await expect(recordAdminLog(c, { admin_id: 'a', action: 'ban_user' })).resolves.toBe(false)
    expect(mockError).toHaveBeenCalledTimes(1)
  })

  it('logs and returns false when the insert throws', async () => {
    const { client: c } = client(new Error('network'))
    await expect(recordAdminLog(c, { admin_id: 'a', action: 'ban_user' })).resolves.toBe(false)
    expect(mockError).toHaveBeenCalledTimes(1)
  })
})
