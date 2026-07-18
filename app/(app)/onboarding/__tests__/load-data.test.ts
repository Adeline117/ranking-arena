import { loadOnboardingGroups, loadOnboardingTraders } from '../load-data'

function response(payload: unknown, status = 200) {
  return {
    json: jest.fn().mockResolvedValue(payload),
    ok: status >= 200 && status < 300,
    status,
  }
}

describe('onboarding discovery loaders', () => {
  it('accepts canonical empty trader and group results as real empty states', async () => {
    const traderFetch = jest.fn().mockResolvedValue(response({ traders: [] }))
    const groupFetch = jest.fn().mockResolvedValue(
      response({
        success: true,
        data: { groups: [] },
      })
    )

    await expect(loadOnboardingTraders(traderFetch)).resolves.toEqual([])
    await expect(loadOnboardingGroups(groupFetch)).resolves.toEqual([])
    expect(traderFetch).toHaveBeenCalledWith('/api/sidebar/top-traders')
    expect(groupFetch).toHaveBeenCalledWith('/api/groups?limit=8&sort_by=member_count')
  })

  it.each([
    ['traders', loadOnboardingTraders, { traders: [] }],
    ['groups', loadOnboardingGroups, { success: true, data: { groups: [] } }],
  ] as const)(
    'rejects a non-2xx %s response instead of showing an empty state',
    async (_resource, loader, payload) => {
      const fetcher = jest.fn().mockResolvedValue(response(payload, 503))

      await expect(loader(fetcher)).rejects.toThrow('status 503')
    }
  )

  it.each([
    ['missing trader list', loadOnboardingTraders, {}],
    ['malformed trader row', loadOnboardingTraders, { traders: [{ source: 'binance' }] }],
    ['legacy group envelope', loadOnboardingGroups, { groups: [] }],
    [
      'malformed group row',
      loadOnboardingGroups,
      { success: true, data: { groups: [{ id: 'group-1' }] } },
    ],
  ] as const)(
    'rejects %s instead of silently coercing it to empty',
    async (_case, loader, payload) => {
      const fetcher = jest.fn().mockResolvedValue(response(payload))

      await expect(loader(fetcher)).rejects.toThrow('malformed')
    }
  )

  it('rejects invalid JSON as a load failure', async () => {
    const fetcher = jest.fn().mockResolvedValue({
      json: jest.fn().mockRejectedValue(new SyntaxError('invalid json')),
      ok: true,
      status: 200,
    })

    await expect(loadOnboardingTraders(fetcher)).rejects.toThrow('status 200')
  })
})
