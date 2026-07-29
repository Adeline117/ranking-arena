import type { SupabaseClient } from '@supabase/supabase-js'
import { AdminUserSanctionError, setAdminUserSanctionAtomic } from './user-sanctions'

const ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const TARGET_ID = '22222222-2222-4222-8222-222222222222'

function clientWith(result: { data: unknown; error: { code?: string } | null }) {
  const rpc = jest.fn().mockResolvedValue(result)
  return {
    client: { rpc } as unknown as SupabaseClient,
    rpc,
  }
}

describe('administrator user sanction rollout', () => {
  it('calls the single atomic authority and accepts its exact acknowledgement', async () => {
    const { client, rpc } = clientWith({
      data: [
        {
          applied: true,
          result_action: 'ban',
          result_target_id: TARGET_ID,
          status: 'applied',
          target_handle: 'target',
        },
      ],
      error: null,
    })

    await expect(
      setAdminUserSanctionAtomic(client, {
        actorId: ACTOR_ID,
        targetId: TARGET_ID,
        action: 'ban',
        reason: ' abuse ',
      })
    ).resolves.toMatchObject({ applied: true, status: 'applied' })

    expect(rpc).toHaveBeenCalledWith('set_admin_user_sanction_atomic', {
      p_actor_id: ACTOR_ID,
      p_target_id: TARGET_ID,
      p_action: 'ban',
      p_reason: ' abuse ',
    })
  })

  it('accepts a typed no-op acknowledgement without inventing success', async () => {
    const { client } = clientWith({
      data: [
        {
          applied: false,
          result_action: 'unban',
          result_target_id: TARGET_ID,
          status: 'not_banned',
          target_handle: 'target',
        },
      ],
      error: null,
    })

    await expect(
      setAdminUserSanctionAtomic(client, {
        actorId: ACTOR_ID,
        targetId: TARGET_ID,
        action: 'unban',
      })
    ).resolves.toEqual({
      applied: false,
      result_action: 'unban',
      result_target_id: TARGET_ID,
      status: 'not_banned',
      target_handle: 'target',
    })
  })

  it.each([
    ['42501', 'forbidden'],
    ['22023', 'validation'],
    ['40001', 'conflict'],
    ['40P01', 'conflict'],
    ['55P03', 'conflict'],
    ['XX000', 'database'],
  ])('classifies database code %s as %s', async (code, kind) => {
    const { client } = clientWith({ data: null, error: { code } })

    await expect(
      setAdminUserSanctionAtomic(client, {
        actorId: ACTOR_ID,
        targetId: TARGET_ID,
        action: 'ban',
      })
    ).rejects.toMatchObject({
      name: 'AdminUserSanctionError',
      kind,
      databaseCode: code,
    })
  })

  it.each([
    [null],
    [[]],
    [
      [
        {
          applied: true,
          result_action: 'ban',
          result_target_id: TARGET_ID,
          status: 'already_banned',
          target_handle: 'target',
        },
      ],
    ],
    [
      [
        {
          applied: false,
          result_action: 'ban',
          result_target_id: TARGET_ID,
          status: 'not_found',
          target_handle: 'unexpected',
        },
      ],
    ],
  ])('fails closed on malformed acknowledgement %#', async (data) => {
    const { client } = clientWith({ data, error: null })

    await expect(
      setAdminUserSanctionAtomic(client, {
        actorId: ACTOR_ID,
        targetId: TARGET_ID,
        action: 'ban',
      })
    ).rejects.toEqual(expect.any(AdminUserSanctionError))
  })

  it('rejects malformed UUIDs and oversized reasons before contacting the database', async () => {
    const { client, rpc } = clientWith({ data: null, error: null })

    await expect(
      setAdminUserSanctionAtomic(client, {
        actorId: ACTOR_ID,
        targetId: 'not-a-uuid',
        action: 'ban',
      })
    ).rejects.toMatchObject({ kind: 'validation' })
    await expect(
      setAdminUserSanctionAtomic(client, {
        actorId: ACTOR_ID,
        targetId: TARGET_ID,
        action: 'ban',
        reason: 'x'.repeat(1001),
      })
    ).rejects.toMatchObject({ kind: 'validation' })
    expect(rpc).not.toHaveBeenCalled()
  })
})
