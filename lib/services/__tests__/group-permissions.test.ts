import { getGroupRole } from '../group-permissions'

function serviceClient(result: { data: unknown; error: unknown }) {
  const chain: Record<string, jest.Mock> = {
    select: jest.fn(),
    eq: jest.fn(),
    maybeSingle: jest.fn().mockResolvedValue(result),
  }
  chain.select.mockReturnValue(chain)
  chain.eq.mockReturnValue(chain)
  return { from: jest.fn().mockReturnValue(chain) }
}

describe('getGroupRole', () => {
  it('returns the stored role when the service lookup succeeds', async () => {
    const client = serviceClient({ data: { role: 'admin' }, error: null })

    await expect(getGroupRole(client as never, 'user-1', 'group-1')).resolves.toBe('admin')
  })

  it('rejects instead of converting a database error into a missing role', async () => {
    const databaseError = { code: 'XX001', message: 'database failed' }
    const client = serviceClient({ data: null, error: databaseError })

    await expect(getGroupRole(client as never, 'user-1', 'group-1')).rejects.toBe(databaseError)
  })
})
