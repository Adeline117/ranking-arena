import { reconcileAllDueProEntitlementProjections } from './projection-reconciliation'

describe('Pro projection reconciliation runtime', () => {
  it('drains ordered atomic pages and aggregates authority counts', async () => {
    const rpc = jest
      .fn()
      .mockResolvedValueOnce({
        data: {
          status: 'reconciled',
          processed_count: 2,
          authority_count: 1,
          next_cursor: '11111111-1111-4111-8111-111111111111',
          has_more: true,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          status: 'reconciled',
          processed_count: 1,
          authority_count: 1,
          next_cursor: '22222222-2222-4222-8222-222222222222',
          has_more: false,
        },
        error: null,
      })

    await expect(
      reconcileAllDueProEntitlementProjections({ rpc } as never, { pageLimit: 2 })
    ).resolves.toEqual({ processedCount: 3, authorityCount: 2, pages: 2 })
    expect(rpc).toHaveBeenNthCalledWith(2, 'reconcile_due_pro_entitlement_projections_atomic', {
      p_limit: 2,
      p_after_user_id: '11111111-1111-4111-8111-111111111111',
    })
  })

  it.each([
    [{ status: 'manual_review' }],
    [
      {
        status: 'reconciled',
        processed_count: 1,
        authority_count: 2,
        next_cursor: null,
        has_more: false,
      },
    ],
    [
      {
        status: 'reconciled',
        processed_count: 1,
        authority_count: 1,
        next_cursor: null,
        has_more: true,
      },
    ],
  ])('fails closed on malformed page %#', async (data) => {
    const rpc = jest.fn().mockResolvedValue({ data, error: null })
    await expect(reconcileAllDueProEntitlementProjections({ rpc } as never)).rejects.toThrow(
      'returned an invalid page'
    )
  })

  it('fails closed when the service-role RPC is unavailable', async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: null,
      error: { message: 'database unavailable' },
    })
    await expect(reconcileAllDueProEntitlementProjections({ rpc } as never)).rejects.toThrow(
      'database unavailable'
    )
  })
})
