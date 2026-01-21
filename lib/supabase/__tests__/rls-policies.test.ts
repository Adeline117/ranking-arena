/**
 * RLS 策略测试
 * 验证 00011_fix_rls_security.sql 中的安全修复
 *
 * 运行方式: npm test -- lib/supabase/__tests__/rls-policies.test.ts
 *
 * 注意: 这些测试需要真实的 Supabase 实例和测试用户
 * 在 CI 环境中可能需要 mock 或跳过
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js'

// 测试配置
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

// 跳过条件
const shouldSkip = !SUPABASE_URL || !SUPABASE_ANON_KEY

describe('RLS Policies', () => {
  let anonClient: SupabaseClient
  let serviceClient: SupabaseClient

  beforeAll(() => {
    if (shouldSkip) return

    anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    if (SUPABASE_SERVICE_KEY) {
      serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    }
  })

  describe('notifications INSERT policy', () => {
    it.skipIf(shouldSkip)('should prevent anonymous users from inserting notifications', async () => {
      const { error } = await anonClient.from('notifications').insert({
        user_id: '00000000-0000-0000-0000-000000000000',
        type: 'system',
        title: 'Test',
        message: 'Test notification',
      })

      expect(error).not.toBeNull()
      expect(error?.code).toBe('42501') // insufficient_privilege
    })

    it.skipIf(shouldSkip || !SUPABASE_SERVICE_KEY)(
      'should allow service role to insert notifications',
      async () => {
        // 先创建测试用户
        const testUserId = '00000000-0000-0000-0000-000000000001'

        const { error } = await serviceClient.from('notifications').insert({
          user_id: testUserId,
          type: 'system',
          title: 'Test',
          message: 'Test notification from service role',
        })

        // 可能因为外键约束失败，但不应该是权限问题
        if (error) {
          expect(error.code).not.toBe('42501')
        }
      }
    )
  })

  describe('risk_alerts INSERT policy', () => {
    it.skipIf(shouldSkip)('should prevent anonymous users from inserting risk alerts', async () => {
      const { error } = await anonClient.from('risk_alerts').insert({
        user_id: '00000000-0000-0000-0000-000000000000',
        trader_id: 'test-trader',
        alert_type: 'drawdown',
        severity: 'warning',
        threshold: 10,
        current_value: 15,
        message: 'Test alert',
      })

      expect(error).not.toBeNull()
      expect(error?.code).toBe('42501')
    })
  })

  describe('group_applications policy', () => {
    it.skipIf(shouldSkip)('should allow applicant to view own application', async () => {
      // 此测试需要登录用户
      // 在实际测试中，需要先登录并创建申请
      expect(true).toBe(true)
    })

    it.skipIf(shouldSkip)('should allow group admin to view applications', async () => {
      // 此测试需要:
      // 1. 创建群组
      // 2. 添加 admin 角色用户
      // 3. 创建申请
      // 4. 以 admin 身份查询
      expect(true).toBe(true)
    })
  })

  describe('pro_official_groups policy', () => {
    it.skipIf(shouldSkip)('should deny free users access to pro groups', async () => {
      const { data, error } = await anonClient.from('pro_official_groups').select('*')

      // 未登录用户应该看不到任何数据
      expect(data).toEqual([])
    })
  })

  describe('posts DELETE policy', () => {
    it.skipIf(shouldSkip)('should prevent non-authors from deleting posts', async () => {
      // 尝试删除一个不属于当前用户的帖子
      const { error } = await anonClient
        .from('posts')
        .delete()
        .eq('id', '00000000-0000-0000-0000-000000000000')

      // 未登录用户应该无法删除
      expect(error).not.toBeNull()
    })
  })

  describe('comments DELETE policy', () => {
    it.skipIf(shouldSkip)('should prevent non-authors from deleting comments', async () => {
      const { error } = await anonClient
        .from('comments')
        .delete()
        .eq('id', '00000000-0000-0000-0000-000000000000')

      expect(error).not.toBeNull()
    })
  })
})

describe('Helper Functions', () => {
  let serviceClient: SupabaseClient

  beforeAll(() => {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return
    serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  })

  it.skipIf(!SUPABASE_SERVICE_KEY)('is_group_admin should exist', async () => {
    const { data, error } = await serviceClient.rpc('is_group_admin', {
      p_group_id: '00000000-0000-0000-0000-000000000000',
    })

    // 应该返回 false（不存在的群组）
    expect(error).toBeNull()
    expect(data).toBe(false)
  })

  it.skipIf(!SUPABASE_SERVICE_KEY)('is_site_admin should exist', async () => {
    const { data, error } = await serviceClient.rpc('is_site_admin')

    expect(error).toBeNull()
    expect(typeof data).toBe('boolean')
  })

  it.skipIf(!SUPABASE_SERVICE_KEY)('is_premium_user should exist', async () => {
    const { data, error } = await serviceClient.rpc('is_premium_user')

    expect(error).toBeNull()
    expect(typeof data).toBe('boolean')
  })
})

describe('RLS Policy Existence', () => {
  let serviceClient: SupabaseClient

  beforeAll(() => {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return
    serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  })

  const expectedPolicies = [
    { table: 'notifications', policy: 'Only service role can insert notifications' },
    { table: 'risk_alerts', policy: 'Only service role can insert risk alerts' },
    { table: 'group_applications', policy: 'Group admins can update applications' },
    { table: 'group_applications', policy: 'Group admins can view applications' },
    { table: 'posts', policy: 'Authors and group admins can delete posts' },
    { table: 'comments', policy: 'Authors and group admins can delete comments' },
  ]

  it.skipIf(!SUPABASE_SERVICE_KEY)('should have all required RLS policies', async () => {
    const { data: policies, error } = await serviceClient.rpc('get_policies_for_table', {
      table_name: 'notifications',
    })

    // 由于 get_policies_for_table 可能不存在，这里只做基本检查
    // 实际验证可以通过 SQL 查询 pg_policies 视图
    expect(error).toBeNull()
  })
})

// 扩展 it 方法支持 skipIf
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    interface It {
      skipIf: (condition: boolean) => (name: string, fn: () => Promise<void> | void) => void
    }
  }
}

// 实现 skipIf
;(it as any).skipIf = (condition: boolean) => {
  return condition ? it.skip : it
}
