/**
 * Stripe Webhook Route Tests
 * 测试 Stripe webhook 处理器的请求验证
 *
 * 注意：完整的集成测试（包括幂等性验证）需要 E2E 测试或使用 Stripe CLI：
 * - stripe listen --forward-to localhost:3000/api/stripe/webhook
 * - stripe trigger checkout.session.completed
 *
 * @jest-environment node
 */

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          single: jest.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
      insert: jest.fn().mockResolvedValue({ error: null }),
    }),
  }),
}))

jest.mock('@/lib/stripe', () => ({
  stripe: {
    subscriptions: {
      retrieve: jest.fn(),
    },
  },
  constructWebhookEvent: jest.fn(),
  SUBSCRIPTION_STATUS_MAP: {
    active: 'active',
    canceled: 'canceled',
    incomplete: 'incomplete',
    incomplete_expired: 'expired',
    past_due: 'past_due',
    paused: 'paused',
    trialing: 'trialing',
    unpaid: 'unpaid',
  },
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}))

jest.mock('@/app/api/pro-official-group/route', () => ({
  joinProOfficialGroup: jest.fn().mockResolvedValue({ success: true }),
  leaveProOfficialGroup: jest.fn().mockResolvedValue(true),
}))

import { NextRequest } from 'next/server'
import { POST } from '../route'
import { constructWebhookEvent } from '@/lib/stripe'

// Helper to create mock NextRequest
function createMockRequest(body: string, signature: string | null): NextRequest {
  const headers = new Headers()
  if (signature) {
    headers.set('stripe-signature', signature)
  }
  return {
    text: jest.fn().mockResolvedValue(body),
    headers: {
      get: (name: string) => headers.get(name),
    },
  } as unknown as NextRequest
}

describe('Stripe Webhook Route', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('Request Validation', () => {
    it('should return 400 when stripe-signature header is missing', async () => {
      const request = createMockRequest('{}', null)
      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Missing stripe-signature header')
    })

    it('should return 400 when signature verification fails', async () => {
      ;(constructWebhookEvent as jest.Mock).mockImplementation(() => {
        throw new Error('Invalid signature')
      })

      const request = createMockRequest('{}', 'invalid_sig')
      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Invalid signature')
    })

    it('should call constructWebhookEvent with correct parameters', async () => {
      ;(constructWebhookEvent as jest.Mock).mockReturnValue({
        id: 'evt_test',
        type: 'test.event',
        data: { object: {} },
      })

      const request = createMockRequest('test_body', 'test_signature')
      await POST(request)

      expect(constructWebhookEvent).toHaveBeenCalledWith('test_body', 'test_signature')
    })
  })

  describe('Event Type Recognition', () => {
    const supportedEventTypes = [
      'checkout.session.completed',
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
      'invoice.payment_succeeded',
      'invoice.payment_failed',
    ]

    supportedEventTypes.forEach((eventType) => {
      it(`should recognize ${eventType} event`, async () => {
        ;(constructWebhookEvent as jest.Mock).mockReturnValue({
          id: `evt_${eventType}`,
          type: eventType,
          data: {
            object: {
              id: 'obj_123',
              customer: 'cus_123',
              metadata: {},
            },
          },
        })

        const request = createMockRequest('{}', 'valid_sig')
        const response = await POST(request)

        // Should not return 400 (validation errors)
        expect(response.status).not.toBe(400)
      })
    })
  })
})

/**
 * 幂等性测试说明
 *
 * Webhook 幂等性通过以下机制实现：
 * 1. stripe_events 表存储已处理的事件 ID
 * 2. 每次收到 webhook 先查询该事件是否已处理
 * 3. 已处理的事件返回 { received: true, skipped: true }
 *
 * 测试幂等性的方法：
 *
 * 1. E2E 测试 (推荐):
 *    - 使用 Playwright/Cypress 配合真实 Stripe 测试环境
 *    - 多次触发同一事件，验证数据库只记录一次
 *
 * 2. Stripe CLI 手动测试:
 *    ```
 *    # 启动 webhook 转发
 *    stripe listen --forward-to localhost:3000/api/stripe/webhook
 *
 *    # 触发事件（会自动生成唯一 event ID）
 *    stripe trigger checkout.session.completed
 *
 *    # 使用 --replay 重放已有事件测试幂等性
 *    stripe events resend evt_xxx
 *    ```
 *
 * 3. 数据库直接验证:
 *    ```sql
 *    -- 查看已处理事件
 *    SELECT * FROM stripe_events ORDER BY processed_at DESC;
 *
 *    -- 验证无重复
 *    SELECT event_id, COUNT(*) FROM stripe_events GROUP BY event_id HAVING COUNT(*) > 1;
 *    ```
 */
